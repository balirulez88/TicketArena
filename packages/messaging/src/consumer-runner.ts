import { type Logger, logBindingsFor, silentLogger } from "@ticketarena/contracts";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import { createBackgroundLoop, sleep } from "./background-loop.js";
import { createEmitCausedEvent, type EmitCausedEvent } from "./caused-event.js";
import type { MessageBus, ReceivedMessage } from "./message-bus.js";
import { type ServiceName, serviceStore } from "./service-store.js";

const PG_UNIQUE_VIOLATION = "P2002";
// ADR 0011 transient-failure schedule, indexed by delivery count; the last entry repeats.
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000];
const FETCH_BATCH = 10;
// JetStream rejects pull requests that expire sooner than one second.
const FETCH_EXPIRES_MS = 1_000;

export interface HandlerContext {
  /** Writes an outbox event caused by the handled message (ids derived, same transaction). */
  readonly emit: EmitCausedEvent;
}

/**
 * What a handler returns when the message must not count as processed: the runner rolls the
 * transaction back (no `processed_messages` row, no outbox writes) and redelivers later.
 * `retry`: the state the message needs is not reached yet. `poison`: the message can never be
 * applied; ADR 0011 routes it to the DLQ, which does not exist yet, so until then it is logged as
 * an error and redelivered on the same delayed schedule, never terminated without a DLQ copy.
 */
export interface HandlerOutcome {
  readonly outcome: "retry" | "poison";
  /** A reason code, logged with the message. */
  readonly reason: string;
}

export interface ConsumerRunnerOptions {
  readonly bus: MessageBus;
  readonly prisma: PrismaClient;
  /** Whose `processed_messages` and outbox the handler runs against; defaults to booking. */
  readonly service?: ServiceName;
  /** Durable name; also the `consumer` half of the `processed_messages` key. */
  readonly consumer: string;
  readonly filterSubject: string;
  /**
   * Runs before the transaction opens, on every delivery including duplicates, for slow work
   * that needs no database (e.g. a provider's latency): awaited inside the transaction it would
   * hold a pooled connection idle and could outlast the interactive-transaction timeout, turning
   * one slow message into endless redelivery. It must be safe to repeat; it never decides
   * whether the message is a duplicate. A throw naks the message like a handler failure.
   */
  readonly beforeTransaction?: (message: ReceivedMessage) => Promise<void>;
  /**
   * Receives the transaction that also holds the dedupe row, so state and checkpoint commit
   * together. Resolving to a `HandlerOutcome` rolls that transaction back (see there).
   */
  readonly handler: (
    tx: TransactionClient,
    message: ReceivedMessage,
    context: HandlerContext,
  ) => Promise<HandlerOutcome | undefined>;
  readonly logger?: Logger;
  readonly ackWaitMs?: number;
  readonly retryDelayMs?: (deliveryCount: number) => number;
}

export interface ConsumerRunner {
  /** Fetches and processes one batch; resolves to the number of messages received. */
  pollOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

/** Thrown inside the transaction to roll it back when the dedupe row already exists. */
class AlreadyProcessed extends Error {}

/** Thrown inside the transaction to roll it back when the handler returned an outcome. */
class Deferred extends Error {
  constructor(readonly result: HandlerOutcome) {
    super(`${result.outcome}: ${result.reason}`);
  }
}

export async function createConsumerRunner(
  options: ConsumerRunnerOptions,
): Promise<ConsumerRunner> {
  const subscription = await options.bus.subscribe({
    stream: "main",
    consumer: options.consumer,
    filterSubject: options.filterSubject,
    ...(options.ackWaitMs === undefined ? {} : { ackWaitMs: options.ackWaitMs }),
  });
  const logger = (options.logger ?? silentLogger).child({ consumer: options.consumer });
  const store = serviceStore(options.service ?? "booking");
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;

  async function process(message: ReceivedMessage): Promise<void> {
    const messageId = message.msgId;
    const log = logger.child({ messageId, ...logBindingsFor(parseJson(message.data)) });
    if (messageId === undefined) {
      // Without an id there is no safe dedupe key, and an empty or shared one would make
      // unrelated messages look like duplicates. Redelivery cannot fix it: stop it here.
      log.error({ subject: message.subject }, "message has no Nats-Msg-Id; terminated");
      message.term("missing Nats-Msg-Id");
      return;
    }
    try {
      await options.beforeTransaction?.(message);
      await options.prisma.$transaction(async (tx) => {
        try {
          await store.insertProcessed(tx, {
            consumer: options.consumer,
            messageId,
            streamSeq: BigInt(message.streamSeq),
          });
        } catch (error) {
          // Only THIS insert may mean "duplicate": a unique violation from the handler is a
          // real failure and must be retried, not acked.
          throw isUniqueViolation(error) ? new AlreadyProcessed() : error;
        }
        const result = await options.handler(tx, message, {
          emit: createEmitCausedEvent(tx, parseJson(message.data), store),
        });
        if (result !== undefined) {
          throw new Deferred(result);
        }
      });
    } catch (error) {
      settleFailure(message, error, log);
      return;
    }
    log.info({ subject: message.subject }, "message handled");
    message.ack();
  }

  /** Every path that does not commit ends in an ack (duplicate) or a delayed nak, never `term`. */
  function settleFailure(message: ReceivedMessage, error: unknown, log: Logger): void {
    const deliveryCount = message.deliveryCount;
    if (error instanceof AlreadyProcessed) {
      log.info({}, "duplicate message skipped");
      message.ack();
      return;
    }
    if (error instanceof Deferred) {
      const { outcome, reason } = error.result;
      if (outcome === "poison") {
        log.error({ reason, deliveryCount }, "poison message; no DLQ yet, retrying");
      } else {
        log.info({ reason, deliveryCount }, "message not applicable yet; retrying");
      }
    } else {
      log.error({ err: error, deliveryCount }, "handler failed; retrying");
    }
    message.nak(retryDelayMs(deliveryCount));
  }

  async function pollOnce(): Promise<number> {
    const messages = await subscription.fetch({
      maxMessages: FETCH_BATCH,
      expiresMs: FETCH_EXPIRES_MS,
    });
    for (const message of messages) {
      await process(message);
    }
    return messages.length;
  }

  const loop = createBackgroundLoop(async () => {
    try {
      await pollOnce();
    } catch {
      // A broker or database outage must not kill the loop; the next poll retries.
      await sleep(FETCH_EXPIRES_MS);
    }
  });

  return { pollOnce, ...loop };
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function defaultRetryDelayMs(deliveryCount: number): number {
  const index = Math.min(Math.max(deliveryCount, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index] ?? 0;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === PG_UNIQUE_VIOLATION
  );
}
