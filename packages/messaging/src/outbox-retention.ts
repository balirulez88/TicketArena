import type { PrismaClient } from "@ticketarena/db";
import { type ServiceName, serviceStore } from "./service-store.js";

/**
 * How long outbox rows and `processed_messages` are kept (ADR 0011 retention invariant): longer
 * than the stream's 7-day `max_age`, so recovery can always reach past the stream.
 */
export const RETENTION_MS = 14 * 86_400_000;

/** Rows one DELETE removes at most, so a large backlog never holds locks for long. */
export const DEFAULT_RETENTION_BATCH_SIZE = 1_000;

export interface PruneRetentionOptions {
  readonly prisma: PrismaClient;
  readonly now: Date;
  /** Defaults to `RETENTION_MS`. */
  readonly retentionMs?: number;
  readonly batchSize?: number;
}

export interface PrunedRows {
  readonly outbox: number;
  readonly processed: number;
}

// `publishedAt` (every outbox) and the payment and notification `processedAt` are `timestamp`
// columns that Prisma fills with UTC wall time; booking's `processedAt` is `timestamptz`. The
// cutoff ($1) is a `timestamptz`, converted to UTC wall time where the column has no zone.
const PROCESSED_AT_IS_TIMESTAMPTZ: Readonly<Record<ServiceName, boolean>> = {
  booking: true,
  payment: false,
  notification: false,
};

/**
 * Booking keeps a `payment.refund_requested` for an unknown order until its orphan refund
 * obligation exists: during a refund cutover the previous worker writes that refund as its outbox
 * row only, and the reconciler's catch-up creates the obligation from it (ticket 70,
 * `refund-reconciler.ts`). Once the obligation exists the outbox row is never read again.
 */
const KEEP_FOR_REFUND_CUTOVER = `
  AND NOT (e."eventType" = 'payment.refund_requested'
    AND e."payload" -> 'payload' ->> 'reason' = 'unknown_order'
    AND NOT EXISTS (
      SELECT 1 FROM "public"."orphan_refund_obligations" r
      WHERE r."paymentId"::text = e."aggregateId"))`;

/**
 * The retention job: deletes, in every service schema, the outbox rows `PUBLISHED` more than the
 * retention ago and the `processed_messages` rows processed more than the retention ago.
 *
 * Never deleted: a `PENDING` row (its event is not delivered yet), a `FAILED` row and any row with
 * `outbox_event_history` (ADR 0022: a FAILED row and the audit of every row that ever failed or was
 * requeued or re-published are kept; the history's CASCADE therefore never fires), and the refund
 * requests above. A row is aged by `publishedAt`, the time its message entered the stream, so a row
 * outlives its stream copy by at least seven days and recovery can re-publish it.
 */
export async function pruneRetention(
  options: PruneRetentionOptions,
): Promise<Record<ServiceName, PrunedRows>> {
  const cutoff = new Date(options.now.getTime() - (options.retentionMs ?? RETENTION_MS));
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const prune = async (service: ServiceName): Promise<PrunedRows> => {
    const store = serviceStore(service);
    const outbox = await deleteInBatches(
      options.prisma,
      `DELETE FROM ${store.outboxTable} WHERE "id" IN (
         SELECT e."id" FROM ${store.outboxTable} e
         WHERE e."status" = 'PUBLISHED'
           AND e."publishedAt" < ($1::timestamptz AT TIME ZONE 'UTC')
           AND NOT EXISTS (SELECT 1 FROM ${store.historyTable} h WHERE h."outboxId" = e."id")
           ${service === "booking" ? KEEP_FOR_REFUND_CUTOVER : ""}
         LIMIT $2)`,
      cutoff,
      batchSize,
    );
    const processedCutoff = PROCESSED_AT_IS_TIMESTAMPTZ[service]
      ? "$1::timestamptz"
      : "($1::timestamptz AT TIME ZONE 'UTC')";
    const processed = await deleteInBatches(
      options.prisma,
      `DELETE FROM ${store.processedTable} WHERE ctid = ANY(ARRAY(
         SELECT ctid FROM ${store.processedTable}
         WHERE "processedAt" < ${processedCutoff}
         LIMIT $2))`,
      cutoff,
      batchSize,
    );
    return { outbox, processed };
  };
  // One service after another: the job is background work and need not compete for connections.
  return {
    booking: await prune("booking"),
    payment: await prune("payment"),
    notification: await prune("notification"),
  };
}

async function deleteInBatches(
  prisma: PrismaClient,
  sql: string,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await prisma.$executeRawUnsafe(sql, cutoff, batchSize);
    total += deleted;
    if (deleted < batchSize) {
      return total;
    }
  }
}
