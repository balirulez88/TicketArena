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

export interface ConsumerRunnerOptions {
  readonly bus: MessageBus;
  readonly prisma: PrismaClient;
  /** Whose `processed_messages` and outbox the handler runs against; defaults to booking. */
  readonly service?: ServiceName;
  /** Durable name; also the `consumer` half of the `processed_messages` key. */
  readonly consumer: string;
  readonly filterSubject: string;
  /** Receives the transaction that also holds the dedupe row, so state and checkpoint commit together. */
  readonly handler: (
    tx: TransactionClient,
    message: ReceivedMessage,
    context: HandlerContext,
  ) => Promise<void>;
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
        await options.handler(tx, message, {
          emit: createEmitCausedEvent(tx, parseJson(message.data), store),
        });
      });
    } catch (error) {
      if (error instanceof AlreadyProcessed) {
        log.info({}, "duplicate message skipped");
        message.ack();
      } else {
        log.error({ err: error, deliveryCount: message.deliveryCount }, "handler failed; retrying");
        message.nak(retryDelayMs(message.deliveryCount));
      }
      return;
    }
    log.info({ subject: message.subject }, "message handled");
    message.ack();
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
