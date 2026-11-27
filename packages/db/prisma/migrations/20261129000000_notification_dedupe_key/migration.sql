-- One notification per (dedupe key, channel). A refund step is keyed by its payment and template,
-- not by its event: Payment re-announces a refund under new event ids so Booking can recover a lost
-- confirmation, and each re-announcement must not message the buyer again.
--
-- Nullable so a worker from before this migration, which inserts no key, keeps working during the
-- deploy and after a rollback; NULLs never conflict, so its rows are simply not deduplicated.
-- Existing rows are keyed by their source event (`event:<id>`, the key the worker gives a
-- non-refund event), which is what they were unique on; a refund announced before this migration
-- may therefore be messaged once more if Payment re-announces it later.
ALTER TABLE "notification"."notifications" ADD COLUMN "dedupeKey" TEXT;

UPDATE "notification"."notifications" SET "dedupeKey" = 'event:' || "sourceEventId";

CREATE UNIQUE INDEX "notifications_dedupeKey_channel_key"
    ON "notification"."notifications"("dedupeKey", "channel");
