import { type Logger, logBindingsFor, silentLogger } from "@ticketarena/contracts";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import { createBackgroundLoop, sleep } from "./background-loop.js";
import type { MessageBus } from "./message-bus.js";
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

/**
 * Publishes committed outbox rows (ADR 0003). Rows are claimed with `FOR UPDATE SKIP LOCKED` in
 * the same transaction that marks them, so concurrent relays take disjoint rows and a crash
 * before commit leaves them PENDING. The resulting redelivery is absorbed by `Nats-Msg-Id` and
 * by consumer dedupe (ADR 0007).
 *
 * Only the oldest PENDING row of each aggregate is claimable. A row held by an in-flight relay
 * (or one that failed) is still PENDING, so no relay can publish a later row of that aggregate
 * ahead of it. The cost is one row per aggregate per tick.
 */
export function createOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const intervalMs = options.intervalMs ?? DEFAULT_RELAY_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_RELAY_BATCH_SIZE;
  const store: ServiceStore = serviceStore(options.service ?? "booking");
  const logger = (options.logger ?? silentLogger).child({ component: "outbox-relay" });

  /** Publishes one claimed row and records the outcome on it; false when the publish failed. */
  async function publishRow(tx: TransactionClient, row: ClaimedRow): Promise<boolean> {
    const log = logger.child({ outboxId: row.id, ...logBindingsFor(row.payload) });
    try {
      await options.bus.publish({
        subject: `ta.${row.eventType}`,
        data: JSON.stringify(row.payload),
        msgId: row.id,
      });
    } catch (error) {
      log.warn({ err: error, eventType: row.eventType }, "outbox publish failed; will retry");
      await store.recordPublishFailure(
        tx,
        row.id,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
    await store.markPublished(tx, row.id);
    log.info({ eventType: row.eventType }, "outbox event published");
    return true;
  }

  async function tick(): Promise<number> {
    return options.prisma.$transaction(
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
          if (await publishRow(tx, row)) {
            published += 1;
          }
        }
        return published;
      },
      { timeout: CLAIM_TRANSACTION_TIMEOUT_MS },
    );
  }

  const loop = createBackgroundLoop(async () => {
    try {
      await tick();
    } catch {
      // Database or broker outage: rows stay PENDING and the next tick retries.
    }
    await sleep(intervalMs);
  });

  return { tick, ...loop };
}
