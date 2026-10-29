-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_status_createdAt_idx" ON "outbox_events"("status", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_idx" ON "outbox_events"("aggregateType", "aggregateId");

