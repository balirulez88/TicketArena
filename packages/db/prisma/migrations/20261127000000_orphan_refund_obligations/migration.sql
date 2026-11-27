-- CreateEnum
CREATE TYPE "OrphanRefundStatus" AS ENUM ('REFUND_REQUESTED', 'REFUNDED');

-- CreateTable
CREATE TABLE "orphan_refund_obligations" (
    "paymentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "OrphanRefundStatus" NOT NULL,
    "refundRequestedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orphan_refund_obligations_pkey" PRIMARY KEY ("paymentId")
);

-- Backfill (hand-written): until this migration the outbox row was the only record of an
-- unknown_order refund, so every such request becomes an open obligation; money is never
-- forgotten. The request carries no capture time, so `capturedAt` takes the earliest request's
-- `occurredAt`, the saga's T, which is never before the capture: a historical proxy, not the
-- capture time. Booking cannot tell from its own schema whether Payment already refunded it, so it
-- stays REFUND_REQUESTED: the reconciler's re-emit refunds nothing twice (payment.refunds is unique
-- per paymentId), and Payment answers it by announcing the executed refund again, which closes the
-- obligation as REFUNDED. Requests the previous worker writes after this migration are caught up
-- by the reconciler (docs/operations/deployment.md, "Refund cutover").
INSERT INTO "orphan_refund_obligations"
    ("paymentId", "orderId", "amount", "currency", "capturedAt", "status", "refundRequestedAt")
SELECT DISTINCT ON ("aggregateId")
    ("payload" -> 'payload' ->> 'paymentId')::uuid,
    ("payload" -> 'payload' ->> 'orderId')::uuid,
    ("payload" -> 'payload' ->> 'amount')::integer,
    "payload" -> 'payload' ->> 'currency',
    ("payload" ->> 'occurredAt')::timestamptz,
    'REFUND_REQUESTED',
    ("payload" ->> 'occurredAt')::timestamptz
FROM "outbox_events"
WHERE "eventType" = 'payment.refund_requested'
  AND "payload" -> 'payload' ->> 'reason' = 'unknown_order'
ORDER BY "aggregateId", "createdAt"
ON CONFLICT ("paymentId") DO NOTHING;
