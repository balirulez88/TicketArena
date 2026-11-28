import type { PrismaClient } from "@ticketarena/db";
import type { ConsumerAdmin, ConsumerStart, StoredMessageRef } from "./consumer-admin.js";
import { RETENTION_MS } from "./outbox-retention.js";
import { type ServiceName, serviceStore } from "./service-store.js";

// How many scanned message ids one processed_messages lookup checks.
const CHECK_BATCH = 500;

/** The ADR 0011 recovery rule that chose the start, in the order they are tried. */
export type RecoveryRule = "ack_floor" | "checkpoint" | "earliest";

export interface RecreateConsumerOptions {
  readonly admin: ConsumerAdmin;
  readonly prisma: PrismaClient;
  /** Whose `processed_messages` the consumer records in; defaults to booking. */
  readonly service?: ServiceName;
  readonly consumer: string;
  /** The consumer's filter subject as the worker subscribes it. */
  readonly filterSubject: string;
  /** Decides only whether the checkpoint is reliable, never where delivery starts. */
  readonly now: Date;
  /**
   * Treat the ack floor as unavailable. It counts terminated (dead-lettered) messages as settled,
   * so replaying a dead-lettered message after a fix needs the checkpoint scan instead.
   */
  readonly ignoreAckFloor?: boolean;
  /** How long `processed_messages` rows are kept; defaults to the retention job's 14 days. */
  readonly processedRetentionMs?: number;
}

export interface RecreateConsumerResult {
  readonly rule: RecoveryRule;
  /** The first stream sequence the recreated consumer delivers. */
  readonly startSeq: number;
}

/**
 * Recreates a durable consumer of the main stream so that no unprocessed message is skipped
 * (ADR 0011, spec: Consumer recovery). The rules, in order:
 *
 * 1. Ack floor available: start at `ack_floor + 1`. Everything at or below it is settled.
 * 2. Otherwise, if `processed_messages` is a reliable checkpoint (its retention covers the
 *    stream's first retained message): scan the retained stream with the consumer's filter and
 *    start at the first message without a row. Messages are processed out of order, so the
 *    highest processed sequence says nothing about the ones below it; only this scan does.
 * 3. Otherwise: replay from the earliest retained message.
 *
 * A start is never derived from a timestamp: `now` only judges whether rule 2 may be used.
 * Every rule may redeliver processed messages; `processed_messages` absorbs them. The worker
 * must not run the consumer while it is recreated (runbook: docs/messaging/consumer-recovery.md).
 */
export async function recreateConsumer(
  options: RecreateConsumerOptions,
): Promise<RecreateConsumerResult> {
  const { admin, consumer, filterSubject } = options;
  const existing = await admin.consumerState(consumer);
  const decided = await decideStart(options, existing);
  if (existing !== undefined) {
    await admin.deleteConsumer(consumer);
  }
  await admin.createConsumer({ consumer, filterSubject, start: decided.start });
  return { rule: decided.rule, startSeq: decided.startSeq };
}

async function decideStart(
  options: RecreateConsumerOptions,
  existing: Awaited<ReturnType<ConsumerAdmin["consumerState"]>>,
): Promise<{ rule: RecoveryRule; start: ConsumerStart; startSeq: number }> {
  // An ack floor counted under another filter says nothing about this filter's messages.
  if (
    existing !== undefined &&
    options.ignoreAckFloor !== true &&
    existing.filterSubject === options.filterSubject
  ) {
    const seq = existing.ackFloorStreamSeq + 1;
    return { rule: "ack_floor", start: { seq }, startSeq: seq };
  }
  const stream = await options.admin.streamState();
  const retentionMs = options.processedRetentionMs ?? RETENTION_MS;
  // A row is deleted only once it is older than the retention, and a message is processed after
  // it was stored, so every retained message newer than the cutoff still has its row if processed.
  const reliable =
    stream.firstTimestamp === null ||
    stream.firstTimestamp.getTime() >= options.now.getTime() - retentionMs;
  if (!reliable) {
    return { rule: "earliest", start: "earliest", startSeq: stream.firstSeq };
  }
  const seq =
    (await firstUnprocessed(options, stream.firstSeq, stream.lastSeq)) ?? stream.lastSeq + 1;
  return { rule: "checkpoint", start: { seq }, startSeq: seq };
}

/** The first retained matching message without a `processed_messages` row for the consumer. */
async function firstUnprocessed(
  options: RecreateConsumerOptions,
  fromSeq: number,
  toSeq: number,
): Promise<number | undefined> {
  let batch: StoredMessageRef[] = [];
  try {
    for await (const message of options.admin.scan(options.filterSubject, fromSeq, toSeq)) {
      batch.push(message);
      if (batch.length >= CHECK_BATCH) {
        const found = await firstWithoutRow(options, batch);
        if (found !== undefined) {
          return found;
        }
        batch = [];
      }
    }
  } catch (error) {
    // The scan fails rather than end short (a short scan would skip messages); the consumer is
    // still untouched here, so the operator can simply rerun.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Recreating consumer "${options.consumer}" failed: ${reason}`, {
      cause: error,
    });
  }
  return batch.length === 0 ? undefined : firstWithoutRow(options, batch);
}

async function firstWithoutRow(
  options: RecreateConsumerOptions,
  batch: readonly StoredMessageRef[],
): Promise<number | undefined> {
  const ids = batch.flatMap((message) => (message.msgId === undefined ? [] : [message.msgId]));
  const rows = await options.prisma.$queryRawUnsafe<{ messageId: string }[]>(
    `SELECT "messageId" FROM ${serviceStore(options.service ?? "booking").processedTable}
     WHERE "consumer" = $1 AND "messageId" = ANY($2::text[])`,
    options.consumer,
    ids,
  );
  const processed = new Set(rows.map((row) => row.messageId));
  // A message without an id is never processed (the runner terminates it); resuming there only
  // replays, which is safe.
  return batch.find((message) => message.msgId === undefined || !processed.has(message.msgId))
    ?.streamSeq;
}
