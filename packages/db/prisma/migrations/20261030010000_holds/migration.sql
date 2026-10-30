-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('HELD', 'ORDERED', 'RELEASED', 'EXPIRED');

-- CreateTable
CREATE TABLE "holds" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "buyerKey" TEXT NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'HELD',
    "holdExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "correlationId" UUID NOT NULL,

    CONSTRAINT "holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "holds_eventId_buyerKey_idx" ON "holds"("eventId", "buyerKey");

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "holds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holds" ADD CONSTRAINT "holds_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

