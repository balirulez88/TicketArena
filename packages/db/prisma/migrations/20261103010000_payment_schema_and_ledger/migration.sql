-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "payment";

-- CreateEnum
CREATE TYPE "OrderPaymentDisposition" AS ENUM ('APPLIED', 'REFUND_REQUESTED', 'MANUAL_REVIEW', 'REFUNDED');

-- CreateEnum
CREATE TYPE "payment"."OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "payment"."PaymentAttemptStatus" AS ENUM ('ATTEMPTING', 'CAPTURED', 'FAILED');

-- CreateTable
CREATE TABLE "order_payments" (
    "paymentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "disposition" "OrderPaymentDisposition" NOT NULL,
    "refundRequestedAt" TIMESTAMPTZ(3),
    "refundAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_payments_pkey" PRIMARY KEY ("paymentId")
);

-- CreateTable
CREATE TABLE "payment"."outbox_events" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "payment"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."processed_messages" (
    "consumer" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "streamSeq" BIGINT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("consumer","messageId")
);

-- CreateTable
CREATE TABLE "payment"."payment_attempts" (
    "paymentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" "payment"."PaymentAttemptStatus" NOT NULL,
    "capturedAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("paymentId"),
    CONSTRAINT "payment_attempts_captured_iff_capturedAt" CHECK (("status" = 'CAPTURED') = ("capturedAt" IS NOT NULL)),
    CONSTRAINT "payment_attempts_failed_iff_failureReason" CHECK (("status" = 'FAILED') = ("failureReason" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "order_payments_orderId_idx" ON "order_payments"("orderId");

-- CreateIndex (hand-written: Prisma cannot express a partial unique index)
CREATE UNIQUE INDEX "order_payments_orderId_applied_key" ON "order_payments"("orderId") WHERE "disposition" = 'APPLIED';

-- CreateIndex
CREATE INDEX "outbox_events_status_createdAt_idx" ON "payment"."outbox_events"("status", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_idx" ON "payment"."outbox_events"("aggregateType", "aggregateId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_orderId_attemptNo_key" ON "payment"."payment_attempts"("orderId", "attemptNo");

-- AddForeignKey
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
