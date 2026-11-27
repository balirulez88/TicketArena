import { type Logger, logBindingsFor, silentLogger } from "@ticketarena/contracts";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import { createBackgroundLoop, sleep } from "./background-loop.js";
import { createFailureReporter } from "./failure-reporter.js";
import { type MessageBus, PermanentPublishError } from "./message-bus.js";
import { DEFAULT_MAX_PERMANENT_FAILURES, recordPermanentFailure } from "./outbox-failures.js";
import { type ServiceName, type ServiceStore, serviceStore } from "./service-store.js";

export const DEFAULT_RELAY_INTERVAL_MS = 250;
export const DEFAULT_RELAY_BATCH_SIZE = 100;
// The claim transaction stays open while PubAcks are awaited, so Prisma's 5 s default is too tight.
const CLAIM_TRANSACTION_TIMEOUT_MS = 60_000;

export interface OutboxRelayOptions {
  readonly bus: MessageBus;
  readonly prisma: PrismaClient;
  /** Whose outbox to drain; each service has its own (ADR 0009). Defaults to booking. */
  readonly service?: ServiceName;
  readonly logger?: Logger;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  /** Clock for rate-limiting the outage log and stamping failures; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Permanent publish failures after which a row becomes FAILED (ADR 0022); defaults to
   * `DEFAULT_MAX_PERMANENT_FAILURES`. Transient failures never count towards it.
   */
  readonly maxPermanentFailures?: number;
}

export interface OutboxRelay {
  /** Claims, publishes and marks one batch; resolves to the number of rows published. */
  tick(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

interface ClaimedRow {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

interface FailedRow {
  readonly row: ClaimedRow;
  readonly attempts: number;
  readonly lastError: string;
}

/** The message data; a payload that cannot be serialised can never be published. */
function serialise(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    throw new PermanentPublishError("unserialisable", "payload cannot be serialised", {
      cause: error,
    });
  }
}

/**
 * Publishes committed outbox rows (ADR 0003). Rows are claimed with `FOR UPDATE SKIP LOCKED` in
 * the same transaction that marks them, so concurrent relays take disjoint rows and a crash
 * before commit leaves them PENDING. The resulting redelivery is absorbed by `Nats-Msg-Id` and
 * by consumer dedupe (ADR 0007).
 *
 * Only the oldest PENDING row of each aggregate is claimable. A row held by an in-flight relay,
 * or one whose publish failed and will be retried, is still PENDING, so no relay can publish a
 * later row of that aggregate ahead of it. The cost is one row per aggregate per tick.
 *
 * A publish that fails permanently (the row itself can never be published: `PermanentPublishError`)
 * counts towards `maxPermanentFailures`; at the cap the row becomes FAILED, keeping its payload,
 * and is never claimed again, which releases the rest of its aggregate (ADR 0022: consumers
 * tolerate the gap, as they do the consumer-side DLQ's). A transient failure (the broker is down,
 * the stream is full) only bumps `attempts`, so an outage of any length never fails a row.
 */
export function createOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const intervalMs = options.intervalMs ?? DEFAULT_RELAY_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_RELAY_BATCH_SIZE;
  const store: ServiceStore = serviceStore(options.service ?? "booking");
  const service = options.service ?? "booking";
  const logger = (options.logger ?? silentLogger).child({ component: "outbox-relay" });
  const cap = options.maxPermanentFailures ?? DEFAULT_MAX_PERMANENT_FAILURES;
  const now = options.now ?? Date.now;

  /** Publishes one claimed row and records the outcome on it; false when the publish failed. */
  async function publishRow(
    tx: TransactionClient,
    row: ClaimedRow,
    failedRows: FailedRow[],
  ): Promise<boolean> {
    const log = logger.child({ outboxId: row.id, ...logBindingsFor(row.payload) });
    try {
      await options.bus.publish({
        subject: `ta.${row.eventType}`,
        data: serialise(row.payload),
        msgId: row.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof PermanentPublishError)) {
        log.warn({ err: error, eventType: row.eventType }, "outbox publish failed; will retry");
        await store.recordPublishFailure(tx, row.id, message);
        return false;
      }
      const outcome = await recordPermanentFailure(tx, store, {
        id: row.id,
        error: message,
        cap,
        at: new Date(now()),
      });
      if (outcome.failed) {
        failedRows.push({ row, attempts: outcome.attempts, lastError: message });
      } else {
        log.warn(
          { err: error, eventType: row.eventType, attempts: outcome.attempts, cap },
          "outbox publish failed permanently; will retry until the cap",
        );
      }
      return false;
    }
    await store.markPublished(tx, row.id);
    log.info({ eventType: row.eventType }, "outbox event published");
    return true;
  }

  async function tick(): Promise<number> {
    const failedRows: FailedRow[] = [];
    const published = await options.prisma.$transaction(
      async (tx) => {
        // The table name comes from the closed ServiceName set, never from input.
        const rows = await tx.$queryRawUnsafe<ClaimedRow[]>(
          `SELECT "id", "aggregateType", "aggregateId", "eventType", "payload"
          FROM ${store.outboxTable} AS outbox
          WHERE "status" = 'PENDING'
            AND NOT EXISTS (
              SELECT 1 FROM ${store.outboxTable} earlier
              WHERE earlier."status" = 'PENDING'
                AND earlier."aggregateType" = outbox."aggregateType"
                AND earlier."aggregateId" = outbox."aggregateId"
                AND (earlier."createdAt", earlier."id") < (outbox."createdAt", outbox."id"))
          ORDER BY "createdAt", "id"
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
          batchSize,
        );

        let published = 0;
        for (const row of rows) {
          if (await publishRow(tx, row, failedRows)) {
            published += 1;
          }
        }
        return published;
      },
      { timeout: CLAIM_TRANSACTION_TIMEOUT_MS },
    );
    // The alert, once per transition: only after the FAILED status committed, so a rolled-back
    // tick (which reclaims the row and fails it again) cannot log the same transition twice.
    // Never the payload: it may hold buyer contact data (ticket 51).
    for (const { row, attempts, lastError } of failedRows) {
      logger.error(
        {
          service,
          outboxId: row.id,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          eventType: row.eventType,
          attempts,
          lastError,
        },
        "outbox event FAILED: permanent publish failures reached the cap",
      );
    }
    return published;
  }

  const reporter = createFailureReporter({
    logger,
    now: options.now ?? Date.now,
    failureMessage: "outbox relay tick failed",
    recoveryMessage: "outbox relay recovered",
  });

  const loop = createBackgroundLoop(async () => {
    try {
      await tick();
      reporter.succeeded();
    } catch (error) {
      // Claim, mark or commit failed (database down, broken query): the transaction rolled back,
      // rows stay PENDING and the next tick retries.
      reporter.failed(error);
    }
    await sleep(intervalMs);
  });

  return { tick, ...loop };
}
