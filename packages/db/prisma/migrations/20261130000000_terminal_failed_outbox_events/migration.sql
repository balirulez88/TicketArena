-- Terminal FAILED outbox events (ADR 0022, ticket 59). Each service's outbox gets the count of
-- permanent publish failures towards the relay's cap and the time a row became FAILED, plus an
-- append-only history of permanent failures and status changes per outbox row. Existing rows are
-- PENDING or PUBLISHED, so they start with no permanent failure and no failedAt.

ALTER TABLE "outbox_events" ADD COLUMN "failedAt" TIMESTAMPTZ(3),
ADD COLUMN "permanentFailures" INTEGER NOT NULL DEFAULT 0;

-- A row is FAILED exactly when it records when it failed.
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_failed_at_check"
    CHECK (("status" = 'FAILED') = ("failedAt" IS NOT NULL));

ALTER TABLE "payment"."outbox_events" ADD COLUMN "failedAt" TIMESTAMPTZ(3),
ADD COLUMN "permanentFailures" INTEGER NOT NULL DEFAULT 0;

-- A row is FAILED exactly when it records when it failed.
ALTER TABLE "payment"."outbox_events" ADD CONSTRAINT "outbox_events_failed_at_check"
    CHECK (("status" = 'FAILED') = ("failedAt" IS NOT NULL));

ALTER TABLE "notification"."outbox_events" ADD COLUMN "failedAt" TIMESTAMPTZ(3),
ADD COLUMN "permanentFailures" INTEGER NOT NULL DEFAULT 0;

-- A row is FAILED exactly when it records when it failed.
ALTER TABLE "notification"."outbox_events" ADD CONSTRAINT "outbox_events_failed_at_check"
    CHECK (("status" = 'FAILED') = ("failedAt" IS NOT NULL));

CREATE TABLE "outbox_event_history" (
    "id" BIGSERIAL NOT NULL,
    "outboxId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "attempt" INTEGER NOT NULL,
    "error" TEXT,
    "operator" TEXT,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_event_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_event_history_kind_check"
        CHECK ("kind" IN ('PUBLISH_FAILED', 'STATUS_CHANGED')),
    -- A status change names both ends; a publish failure names neither and carries its error.
    CONSTRAINT "outbox_event_history_status_check" CHECK (
        ("kind" = 'STATUS_CHANGED' AND "fromStatus" IN ('PENDING', 'PUBLISHED', 'FAILED')
            AND "toStatus" IN ('PENDING', 'PUBLISHED', 'FAILED'))
        OR ("kind" = 'PUBLISH_FAILED' AND "fromStatus" IS NULL AND "toStatus" IS NULL
            AND "error" IS NOT NULL))
);

CREATE INDEX "outbox_event_history_outboxId_id_idx" ON "outbox_event_history"("outboxId", "id");

ALTER TABLE "outbox_event_history" ADD CONSTRAINT "outbox_event_history_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payment"."outbox_event_history" (
    "id" BIGSERIAL NOT NULL,
    "outboxId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "attempt" INTEGER NOT NULL,
    "error" TEXT,
    "operator" TEXT,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_event_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_event_history_kind_check"
        CHECK ("kind" IN ('PUBLISH_FAILED', 'STATUS_CHANGED')),
    -- A status change names both ends; a publish failure names neither and carries its error.
    CONSTRAINT "outbox_event_history_status_check" CHECK (
        ("kind" = 'STATUS_CHANGED' AND "fromStatus" IN ('PENDING', 'PUBLISHED', 'FAILED')
            AND "toStatus" IN ('PENDING', 'PUBLISHED', 'FAILED'))
        OR ("kind" = 'PUBLISH_FAILED' AND "fromStatus" IS NULL AND "toStatus" IS NULL
            AND "error" IS NOT NULL))
);

CREATE INDEX "outbox_event_history_outboxId_id_idx" ON "payment"."outbox_event_history"("outboxId", "id");

ALTER TABLE "payment"."outbox_event_history" ADD CONSTRAINT "outbox_event_history_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "payment"."outbox_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "notification"."outbox_event_history" (
    "id" BIGSERIAL NOT NULL,
    "outboxId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "attempt" INTEGER NOT NULL,
    "error" TEXT,
    "operator" TEXT,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_event_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_event_history_kind_check"
        CHECK ("kind" IN ('PUBLISH_FAILED', 'STATUS_CHANGED')),
    -- A status change names both ends; a publish failure names neither and carries its error.
    CONSTRAINT "outbox_event_history_status_check" CHECK (
        ("kind" = 'STATUS_CHANGED' AND "fromStatus" IN ('PENDING', 'PUBLISHED', 'FAILED')
            AND "toStatus" IN ('PENDING', 'PUBLISHED', 'FAILED'))
        OR ("kind" = 'PUBLISH_FAILED' AND "fromStatus" IS NULL AND "toStatus" IS NULL
            AND "error" IS NOT NULL))
);

CREATE INDEX "outbox_event_history_outboxId_id_idx" ON "notification"."outbox_event_history"("outboxId", "id");

ALTER TABLE "notification"."outbox_event_history" ADD CONSTRAINT "outbox_event_history_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "notification"."outbox_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
