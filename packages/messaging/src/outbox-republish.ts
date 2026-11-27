import type { PrismaClient } from "@ticketarena/db";
import { type ServiceName, serviceStore } from "./service-store.js";

/** A re-publish the input does not allow; nothing was changed. */
export class OutboxRepublishRefused extends Error {
  override readonly name = "OutboxRepublishRefused";
}

export interface RepublishInput {
  readonly service: ServiceName;
  /** Rows whose `publishedAt` is in `[publishedFrom, publishedTo)` are re-published. */
  readonly publishedFrom: Date;
  readonly publishedTo: Date;
  /** Who re-publishes and why; both are recorded in each row's history. */
  readonly operator: string;
  readonly reason: string;
  /** When the re-publish happened; defaults to the current time. */
  readonly at?: Date;
}

/**
 * Recovery beyond the stream (ADR 0011 consumer recovery, rule "beyond stream retention"; runbook:
 * docs/messaging/consumer-recovery.md): every `PUBLISHED` row of the service's outbox whose
 * message entered the stream in the range becomes `PENDING` again, and the relay publishes it once
 * more under its original id (`Nats-Msg-Id`), so every consumer that already processed it
 * deduplicates it in `processed_messages`. The range is on `publishedAt`, the time the message
 * entered the stream, which is what a broker data loss or a consumer's lag is measured in.
 *
 * Only `PUBLISHED` rows move: a `PENDING` row is already on its way, and a `FAILED` row leaves
 * only by the audited `requeueFailedOutboxEvent` (ADR 0022). `publishedAt` is cleared (the row is
 * no longer published) and `permanentFailures` restarts at 0, as on a requeue; `attempts`,
 * `lastError` and the payload are kept. Each row gets a `PUBLISHED` -> `PENDING` history entry
 * with the operator and reason, in the same transaction as the move. Resolves to the rows moved.
 */
export async function republishOutboxEvents(
  prisma: PrismaClient,
  input: RepublishInput,
): Promise<number> {
  if (input.operator.trim() === "" || input.reason.trim() === "") {
    throw new OutboxRepublishRefused("a re-publish needs an operator and a reason");
  }
  if (!(input.publishedFrom.getTime() < input.publishedTo.getTime())) {
    throw new OutboxRepublishRefused(
      `the range [${input.publishedFrom.toISOString()}, ${input.publishedTo.toISOString()}) is empty`,
    );
  }
  const store = serviceStore(input.service);
  // `publishedAt` is a `timestamp` column holding UTC wall time; the bounds are converted to it.
  return prisma.$executeRawUnsafe(
    `WITH moved AS (
       UPDATE ${store.outboxTable}
       SET "status" = 'PENDING', "publishedAt" = NULL, "permanentFailures" = 0
       WHERE "status" = 'PUBLISHED'
         AND "publishedAt" >= ($1::timestamptz AT TIME ZONE 'UTC')
         AND "publishedAt" < ($2::timestamptz AT TIME ZONE 'UTC')
       RETURNING "id", "attempts")
     INSERT INTO ${store.historyTable}
       ("outboxId", "kind", "fromStatus", "toStatus", "attempt", "operator", "reason", "at")
     SELECT "id", 'STATUS_CHANGED', 'PUBLISHED', 'PENDING', "attempts", $3, $4, $5::timestamptz
     FROM moved`,
    input.publishedFrom,
    input.publishedTo,
    input.operator,
    input.reason,
    input.at ?? new Date(),
  );
}
