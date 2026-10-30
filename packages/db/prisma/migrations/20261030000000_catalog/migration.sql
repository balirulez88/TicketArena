-- CreateEnum
CREATE TYPE "SeatStatus" AS ENUM ('AVAILABLE', 'HELD', 'IN_CHECKOUT', 'SOLD');

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rows" (
    "id" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "onSaleAt" TIMESTAMPTZ(3) NOT NULL,
    "queueOpensAt" TIMESTAMPTZ(3) NOT NULL,
    "queueClosesAt" TIMESTAMPTZ(3) NOT NULL,
    "demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seats" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "rowId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "SeatStatus" NOT NULL DEFAULT 'AVAILABLE',
    "holdId" UUID,
    "claimBuyerKey" TEXT,

    CONSTRAINT "seats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sections_venueId_name_key" ON "sections"("venueId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "rows_sectionId_label_key" ON "rows"("sectionId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "events_name_key" ON "events"("name");

-- CreateIndex
CREATE INDEX "seats_eventId_status_idx" ON "seats"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "seats_eventId_rowId_number_key" ON "seats"("eventId", "rowId", "number");

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rows" ADD CONSTRAINT "rows_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "rows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

