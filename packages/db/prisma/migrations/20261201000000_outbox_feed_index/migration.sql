-- The admin live feed reads every outbox by the cursor ("createdAt", "id") (ADR 0009); this index
-- serves both the newest-first first page and each page after a cursor without a sort or scan.

-- CreateIndex
CREATE INDEX "outbox_events_createdAt_id_idx" ON "outbox_events"("createdAt", "id");

-- CreateIndex
CREATE INDEX "outbox_events_createdAt_id_idx" ON "payment"."outbox_events"("createdAt", "id");

-- CreateIndex
CREATE INDEX "outbox_events_createdAt_id_idx" ON "notification"."outbox_events"("createdAt", "id");
