import { createHash } from "node:crypto";
import { type Logger, logBindingsFor, silentLogger } from "@ticketarena/contracts";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import { createBackgroundLoop, sleep } from "./background-loop.js";
import { createEmitCausedEvent, type EmitCausedEvent } from "./caused-event.js";
import { type DeadLetter, deadLetterCopies } from "./dead-letter.js";
import { createFailureReporter } from "./failure-reporter.js";
import type { MessageBus, PublishAck, ReceivedMessage } from "./message-bus.js";
import { type ServiceName, serviceStore } from "./service-store.js";

const PG_UNIQUE_VIOLATION = "P2002";
// ADR 0011 transient-failure schedule, indexed by delivery count. Past the 4th delivery the last
// entry repeats; ending retries is the DLQ gate's job (deliveryCount > 5), not this table's.
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000];
// ADR 0011 application budget: deliveries past it go to the DLQ before the handler runs.
const RETRY_BUDGET = 5;
// ADR 0011: a DLQ publish that fails is retried after 2 min; the message is never `term`ed
// without a confirmed DLQ copy.
const DLQ_FAILURE_DELAY_MS = 120_000;
const FETCH_BATCH = 10;
// JetStream rejects pull requests that expire sooner than one second.
const FETCH_EXPIRES_MS = 1_000;

export interface HandlerContext {
  /** Writes an outbox event caused by the handled message (ids derived, same transaction). */
  readonly emit: EmitCausedEvent;
}

/**
 * What a handler returns when the message must not count as processed: the runner rolls the
 * transaction back (no `processed_messages` row, no outbox writes). `retry`: the state the
 * message needs is not reached yet; it is redelivered on the delayed schedule. `poison`: the
 * message can never be applied; it is dead-lettered (ADR 0011).
 */
export interface HandlerOutcome {
  readonly outcome: "retry" | "poison";
  /** A reason code, logged with the message. */
  readonly reason: string;
}

/** Structurally what a zod schema's `safeParse` offers, so this package need not depend on zod. */
export interface MessageSchema {
  safeParse(value: unknown): {
    readonly success: boolean;
    readonly error?: { readonly message: string } | undefined;
  };
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
   * The envelope schema per `version` this consumer understands. When given, the DLQ gate
   * dead-letters a message that is not JSON, carries a version not listed, or fails its
   * version's schema, before `beforeTransaction` and the handler see it. Without it the gate
   * checks only the retry budget.
   */
  readonly schemas?: Readonly<Record<number, MessageSchema>>;
  /**
   * Runs before the transaction opens, on every delivery including duplicates, for slow work
   * that must not hold the transaction (e.g. a provider's latency or call; it may commit its own
   * short writes, never the dedupe row): awaited inside the transaction it would
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
  /** Delay for the `nak` of a failed delivery; defaults to the ADR 0011 schedule. */
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
      // unrelated messages look like duplicates. Redelivery cannot fix it: dead-letter it.
      await deadLetter(
        message,
        missingIdDlqId(options.consumer, message),
        { cause: "missing_msg_id", message: "message has no Nats-Msg-Id" },
        log,
      );
      return;
    }
    // The gate runs before any consumer code, so a message that crashes the process on every
    // delivery still reaches the DLQ once its budget is spent (ADR 0011).
    const rejection = gate(message);
    if (rejection !== undefined) {
      await deadLetter(message, `dlq:${options.consumer}:${messageId}`, rejection, log);
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
      if (error instanceof Deferred && error.result.outcome === "poison") {
        // The transaction has rolled back, so the DLQ copy is the only trace the message leaves.
        await deadLetter(
          message,
          `dlq:${options.consumer}:${messageId}`,
          { cause: "handler_poison", message: error.result.reason },
          log,
        );
        return;
      }
      settleFailure(message, error, log);
      return;
    }
    log.info({ subject: message.subject }, "message handled");
    message.ack();
  }

  function gate(message: ReceivedMessage): DeadLetter["error"] | undefined {
    // JetStream's deliveryCount is the only attempt counter (ADR 0011): it also counts crashes and
    // AckWait expiries, and survives restarts, which an in-process counter would not.
    if (message.deliveryCount > RETRY_BUDGET) {
      return {
        cause: "retry_budget_exhausted",
        message: `delivery ${message.deliveryCount} exceeds the retry budget of ${RETRY_BUDGET}`,
      };
    }
    return options.schemas === undefined ? undefined : checkSchema(options.schemas, message.data);
  }

  /**
   * Publishes the DLQ copy (every part of it) and `term`s only after each PubAck. The DLQ id is
   * derived from the message, never random, so a crash between PubAck and `term` republishes
   * the same ids and the broker stores no second copy, but only inside the DLQ stream's
   * duplicate window (10 min): a redelivery later than that stores another copy. A failed
   * publish naks with 2 min, never terms.
   */
  async function deadLetter(
    message: ReceivedMessage,
    dlqId: string,
    error: DeadLetter["error"],
    log: Logger,
  ): Promise<void> {
    const deliveryCount = message.deliveryCount;
    const copies = deadLetterCopies(
      {
        consumer: options.consumer,
        subject: message.subject,
        streamSeq: message.streamSeq,
        deliveryCount,
        error,
        envelope: message.data,
      },
      dlqId,
      options.bus.maxPayloadBytes?.(),
    );
    const acks: PublishAck[] = [];
    try {
      // One at a time: a failure stops the rest, and the redelivery republishes them all.
      for (const copy of copies) {
        acks.push(await options.bus.publish(copy));
      }
    } catch (publishError) {
      log.error(
        { err: publishError, cause: error.cause, deliveryCount, delayMs: DLQ_FAILURE_DELAY_MS },
        "DLQ publish failed; retrying",
      );
      message.nak(DLQ_FAILURE_DELAY_MS);
      return;
    }
    log.error(
      {
        cause: error.cause,
        reason: error.message,
        deliveryCount,
        dlqId,
        parts: acks.length,
        dlqStreamSeq: acks[0]?.streamSeq,
        duplicate: acks.every((ack) => ack.duplicate),
      },
      "message dead-lettered",
    );
    message.term(`dead-lettered: ${error.cause}`);
  }

  /** Every other failure ends in an ack (duplicate) or a delayed nak, never `term`. */
  function settleFailure(message: ReceivedMessage, error: unknown, log: Logger): void {
    const deliveryCount = message.deliveryCount;
    if (error instanceof AlreadyProcessed) {
      log.info({}, "duplicate message skipped");
      message.ack();
      return;
    }
    const delayMs = retryDelayMs(deliveryCount);
    if (error instanceof Deferred) {
      log.info(
        { reason: error.result.reason, deliveryCount, delayMs },
        "message not applicable yet; retrying",
      );
    } else {
      log.error({ err: error, deliveryCount, delayMs }, "handler failed; retrying");
    }
    // Always a delayed nak, never a bare one: JetStream redelivers a plain nak immediately.
    message.nak(delayMs);
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

  const reporter = createFailureReporter({
    logger,
    now: Date.now,
    failureMessage: "consumer poll failed",
    recoveryMessage: "consumer poll recovered",
  });

  const loop = createBackgroundLoop(async () => {
    try {
      await pollOnce();
      reporter.succeeded();
    } catch (error) {
      // A broker or database outage must not kill the loop; the next poll retries.
      reporter.failed(error);
      await sleep(FETCH_EXPIRES_MS);
    }
  });

  return { pollOnce, ...loop };
}

/**
 * The DLQ id of a message without `Nats-Msg-Id`: its main-stream sequence, which a redelivery
 * keeps, plus a digest of its data, so a stream recreated inside the duplicate window (sequences
 * restart) cannot make an unrelated message look like a duplicate copy and be termed unkept.
 */
function missingIdDlqId(consumer: string, message: ReceivedMessage): string {
  const digest = createHash("sha256").update(message.data).digest("hex").slice(0, 16);
  return `dlq:${consumer}:main:${message.streamSeq}:${digest}`;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function checkSchema(
  schemas: Readonly<Record<number, MessageSchema>>,
  data: string,
): DeadLetter["error"] | undefined {
  const raw = parseJson(data);
  if (raw === undefined) {
    return { cause: "schema_invalid", message: "message data is not JSON" };
  }
  const version =
    typeof raw === "object" && raw !== null && "version" in raw ? raw.version : undefined;
  const schema = typeof version === "number" ? schemas[version] : undefined;
  if (schema === undefined) {
    return {
      cause: "unknown_version",
      message: `no schema for envelope version ${String(version)}`,
    };
  }
  const result = schema.safeParse(raw);
  return result.success
    ? undefined
    : { cause: "schema_invalid", message: result.error?.message ?? "schema validation failed" };
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
