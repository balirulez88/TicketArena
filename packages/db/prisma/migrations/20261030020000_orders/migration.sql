-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "holdId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "buyerKey" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "totalMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "paymentDeadline" TIMESTAMPTZ(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "correlationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "seatId" UUID NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_holdId_key" ON "orders"("holdId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_sessionId_idempotencyKey_key" ON "orders"("sessionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_orderId_seatId_key" ON "order_lines"("orderId", "seatId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
