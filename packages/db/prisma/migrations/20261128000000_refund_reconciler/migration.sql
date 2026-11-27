-- Refund reconciler (ticket 23): what re-emitting a refund obligation and escalating it to manual
-- review needs on both tables that hold obligations.

-- AlterEnum: an orphan obligation escalates as a ledger row does. Not used in this migration, so
-- adding the value inside its transaction is safe.
ALTER TYPE "OrphanRefundStatus" ADD VALUE 'MANUAL_REVIEW' BEFORE 'REFUNDED';

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('late_capture', 'late_delivery', 'order_expired', 'order_cancelled', 'order_confirmed', 'amount_mismatch');

-- AlterTable
ALTER TABLE "order_payments" ADD COLUMN "refundReason" "RefundReason",
ADD COLUMN "refundLastRequestedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "orphan_refund_obligations" ADD COLUMN "correlationId" UUID,
ADD COLUMN "refundAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "refundLastRequestedAt" TIMESTAMPTZ(3);

-- Backfill (hand-written). Until now the reason and the correlation id of a refund request lived
-- only in its outbox row, which retention will delete, so they are copied from the payment's
-- earliest request. A ledger row whose request is gone gets the reason its order's status implies
-- (the saga's own rule); an orphan whose request is gone starts a trace keyed by its payment id.
-- Every open obligation counts as last requested when it was first requested.
UPDATE "order_payments" AS p
SET "refundRequestedAt" = COALESCE(p."refundRequestedAt", p."capturedAt"),
    "refundLastRequestedAt" = COALESCE(p."refundRequestedAt", p."capturedAt"),
    "refundReason" = COALESCE(
      (SELECT (e."payload" -> 'payload' ->> 'reason')::"RefundReason"
       FROM "outbox_events" e
       WHERE e."eventType" = 'payment.refund_requested'
         AND e."aggregateId" = p."paymentId"::text
         AND e."payload" -> 'payload' ->> 'reason' <> 'unknown_order'
       ORDER BY e."createdAt"
       LIMIT 1),
      (SELECT CASE o."status"::text
                WHEN 'EXPIRED' THEN 'order_expired'
                WHEN 'CANCELLED' THEN 'order_cancelled'
                WHEN 'CONFIRMED' THEN 'order_confirmed'
                ELSE 'amount_mismatch'
              END::"RefundReason"
       FROM "orders" o WHERE o."id" = p."orderId"))
WHERE p."disposition" <> 'APPLIED';

UPDATE "orphan_refund_obligations" AS r
SET "refundLastRequestedAt" = r."refundRequestedAt",
    "correlationId" = COALESCE(
      (SELECT (e."payload" ->> 'correlationId')::uuid
       FROM "outbox_events" e
       WHERE e."eventType" = 'payment.refund_requested'
         AND e."aggregateId" = r."paymentId"::text
         AND e."payload" ->> 'correlationId' IS NOT NULL
       ORDER BY e."createdAt"
       LIMIT 1),
      r."paymentId");

ALTER TABLE "orphan_refund_obligations" ALTER COLUMN "correlationId" SET NOT NULL,
ALTER COLUMN "refundLastRequestedAt" SET NOT NULL;

-- A refund obligation always carries what its re-emit needs (hand-written: Prisma cannot express a
-- CHECK); APPLIED is the only disposition without one.
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_refund_obligation_complete" CHECK (
  "disposition" = 'APPLIED'
  OR ("refundReason" IS NOT NULL AND "refundRequestedAt" IS NOT NULL AND "refundLastRequestedAt" IS NOT NULL)
);

-- CreateIndex (hand-written: Prisma cannot express a partial index). The reconciler and
-- refund_pending_age_max read only open obligations, a small slice of a ledger that grows with
-- every order.
CREATE INDEX "order_payments_open_refund_idx" ON "order_payments"("refundLastRequestedAt") WHERE "disposition" IN ('REFUND_REQUESTED', 'MANUAL_REVIEW');
