import type { PrismaClient } from "@ticketarena/db";

// The admin's read-only view over every service's outbox (ADR 0009: every integration event
// starts as an outbox row, so the outboxes together are the event log). The three tables share
// one shape; the SQL runs against this closed list of names only, never against input.

export const OUTBOX_SERVICES = ["booking", "payment", "notification"] as const;

export type OutboxService = (typeof OUTBOX_SERVICES)[number];

const OUTBOX_TABLES: Readonly<Record<OutboxService, string>> = {
  booking: '"public"."outbox_events"',
  payment: '"payment"."outbox_events"',
  notification: '"notification"."outbox_events"',
};

export interface FeedCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * One outbox row as the feed shows it. The payload is left out on purpose: it carries buyer
 * contact details, and the dashboard needs only what happened to which booking, and when.
 */
export interface FeedEntry {
  readonly id: string;
  readonly service: OutboxService;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** From the envelope; `null` only for a row whose payload is not an envelope. */
  readonly correlationId: string | null;
  readonly status: "PENDING" | "PUBLISHED" | "FAILED";
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface FeedQuery {
  /** Entries strictly after it; without one, the newest `limit` entries. */
  readonly after?: FeedCursor | undefined;
  readonly limit: number;
  /** Only one booking's saga. */
  readonly correlationId?: string | undefined;
}

/**
 * Entries in `(createdAt, id)` order, oldest first. Each branch reads its own index
 * `(createdAt, id)` up to `limit` rows, so the union never holds more than three pages.
 *
 * `createdAt` is the writing transaction's start, so a row can commit after a later-stamped one
 * has been read: a poll that has moved its cursor past it does not show it. The feed is a view for
 * people, not a delivery log; the outbox and the relay are the delivery guarantee.
 */
export async function readOutboxFeed(db: PrismaClient, query: FeedQuery): Promise<FeedEntry[]> {
  const params: unknown[] = [query.limit];
  const conditions: string[] = [];
  if (query.after !== undefined) {
    params.push(query.after.createdAt.toISOString(), query.after.id);
    // `createdAt` is a UTC timestamp without a zone, as Prisma writes it.
    conditions.push(
      `("createdAt", "id") > ($${params.length - 1}::timestamptz AT TIME ZONE 'UTC', $${params.length}::uuid)`,
    );
  }
  if (query.correlationId !== undefined) {
    params.push(query.correlationId);
    conditions.push(`"payload" ->> 'correlationId' = $${params.length}`);
  }
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  // The first page is the tail of the log, so it reads backwards and is reversed below.
  const direction = query.after === undefined ? "DESC" : "ASC";
  const branches = OUTBOX_SERVICES.map(
    (service) => `(
      SELECT "id"::text AS "id", '${service}' AS "service", "eventType", "aggregateType",
             "aggregateId", "payload" ->> 'correlationId' AS "correlationId",
             "status"::text AS "status", "createdAt", "publishedAt"
      FROM ${OUTBOX_TABLES[service]}
      ${where}
      ORDER BY "createdAt" ${direction}, "id" ${direction}
      LIMIT $1)`,
  );
  const rows = await db.$queryRawUnsafe<FeedEntry[]>(
    `SELECT * FROM (${branches.join(" UNION ALL ")}) feed
     ORDER BY "createdAt" ${direction}, "id" ${direction}
     LIMIT $1`,
    ...params,
  );
  return direction === "DESC" ? rows.reverse() : rows;
}

/**
 * Outbox lag per service: how long its oldest `PENDING` row has waited at `now`, in ms; 0 when
 * none waits. A caller clock behind the database's reads 0, never a negative age.
 */
export async function measureOutboxLags(
  db: PrismaClient,
  now: Date,
): Promise<Record<OutboxService, number>> {
  const rows = await db.$queryRawUnsafe<{ service: OutboxService; oldest: Date | null }[]>(
    OUTBOX_SERVICES.map(
      (service) =>
        `SELECT '${service}' AS "service", min("createdAt") AS "oldest"
         FROM ${OUTBOX_TABLES[service]} WHERE "status" = 'PENDING'`,
    ).join(" UNION ALL "),
  );
  const lag = (service: OutboxService) => {
    const oldest = rows.find((row) => row.service === service)?.oldest ?? null;
    return oldest === null ? 0 : Math.max(0, now.getTime() - oldest.getTime());
  };
  return { booking: lag("booking"), payment: lag("payment"), notification: lag("notification") };
}
