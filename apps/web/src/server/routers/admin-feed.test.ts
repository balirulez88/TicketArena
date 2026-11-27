import { randomUUID } from "node:crypto";
import { testClients } from "@ticketarena/booking/testing";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeEach, describe, expect, test } from "vitest";
import { adminCaller } from "../testing/admin-caller";

// admin.feed (spec: Admin dashboard; ADR 0009): the union of every service's outbox, read by the
// cursor (createdAt, id), so one booking's saga can be followed across services by correlationId.
const database = setupTestDatabase();
const { db } = testClients(database);

const NOW = new Date("2027-03-01T12:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

type Service = "booking" | "payment" | "notification";
type Status = "PENDING" | "PUBLISHED" | "FAILED";

interface Row {
  readonly id: string;
  readonly service: Service;
  readonly eventType: string;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly status?: Status;
}

/** Writes an outbox row as its service's relay would find it, with an envelope as its payload. */
async function outboxRow(row: Row): Promise<void> {
  const status = row.status ?? "PUBLISHED";
  const data = {
    id: row.id,
    aggregateType: "order",
    aggregateId: row.correlationId,
    eventType: row.eventType,
    payload: {
      id: row.id,
      type: row.eventType,
      correlationId: row.correlationId,
      contact: { email: "buyer@example.com" },
    },
    status,
    createdAt: row.createdAt,
    publishedAt: status === "PUBLISHED" ? row.createdAt : null,
    ...(status === "FAILED" ? { failedAt: row.createdAt, permanentFailures: 5 } : {}),
  };
  if (row.service === "booking") {
    await db().outboxEvent.create({ data });
  } else if (row.service === "payment") {
    await db().paymentOutboxEvent.create({ data });
  } else {
    await db().notificationOutboxEvent.create({ data });
  }
}

/** What the feed shows of a row: never its payload, which carries buyer contact details. */
function entryOf(row: Row) {
  const status = row.status ?? "PUBLISHED";
  return {
    id: row.id,
    service: row.service,
    eventType: row.eventType,
    aggregateType: "order",
    aggregateId: row.correlationId,
    correlationId: row.correlationId,
    status,
    createdAt: row.createdAt,
    publishedAt: status === "PUBLISHED" ? row.createdAt : null,
  };
}

/** Ids sorted so that, on a createdAt tie, the order by id is known. */
function sortedIds(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID()).sort();
}

beforeEach(async () => {
  await db().outboxEvent.deleteMany();
  await db().paymentOutboxEvent.deleteMany();
  await db().notificationOutboxEvent.deleteMany();
});

const admin = () => adminCaller(db, NOW);

/** One booking's saga across the three outboxes, plus another booking interleaved with it. */
async function twoSagas() {
  const saga = randomUUID();
  const other = randomUUID();
  const ids = sortedIds(6);
  const rows: Row[] = [
    {
      id: ids[0] ?? "",
      service: "booking",
      eventType: "seat.held",
      correlationId: saga,
      createdAt: at(1),
    },
    {
      id: ids[1] ?? "",
      service: "booking",
      eventType: "seat.held",
      correlationId: other,
      createdAt: at(2),
    },
    {
      id: ids[2] ?? "",
      service: "booking",
      eventType: "order.placed",
      correlationId: saga,
      createdAt: at(3),
    },
    {
      id: ids[3] ?? "",
      service: "payment",
      eventType: "payment.succeeded",
      correlationId: saga,
      createdAt: at(4),
    },
    // A tie on createdAt: the id decides.
    {
      id: ids[4] ?? "",
      service: "booking",
      eventType: "order.confirmed",
      correlationId: saga,
      createdAt: at(5),
      status: "PENDING",
    },
    {
      id: ids[5] ?? "",
      service: "notification",
      eventType: "notification.sent",
      correlationId: saga,
      createdAt: at(5),
      status: "FAILED",
    },
  ];
  // Written out of order: the feed orders them, not the insert.
  for (const row of [...rows].reverse()) {
    await outboxRow(row);
  }
  return { saga, other, rows };
}

describe("admin.feed", () => {
  test("without a cursor is the newest entries of every outbox, oldest first, with their status", async () => {
    const { rows } = await twoSagas();

    const page = await admin().admin.feed({ limit: 4 });

    expect(page.entries).toEqual(rows.slice(2).map(entryOf));
    expect(page.nextCursor).toEqual({ createdAt: at(5), id: rows[5]?.id });
  });

  test("after a cursor is only what follows it by (createdAt, id), however many outboxes hold it", async () => {
    const { rows } = await twoSagas();

    const first = await admin().admin.feed({
      cursor: { createdAt: at(1), id: rows[0]?.id ?? "" },
      limit: 3,
    });
    expect(first.entries).toEqual(rows.slice(1, 4).map(entryOf));
    expect(first.nextCursor).toEqual({ createdAt: at(4), id: rows[3]?.id });

    const second = await admin().admin.feed({ cursor: first.nextCursor ?? undefined, limit: 3 });
    expect(second.entries).toEqual(rows.slice(4).map(entryOf));

    // Nothing new yet: the poll keeps its cursor.
    const third = await admin().admin.feed({ cursor: second.nextCursor ?? undefined, limit: 3 });
    expect(third).toEqual({ entries: [], nextCursor: second.nextCursor });
  });

  test("filtered by correlationId is one booking's saga across the services", async () => {
    const { saga, rows } = await twoSagas();

    const page = await admin().admin.feed({ correlationId: saga, limit: 50 });

    expect(page.entries).toEqual(rows.filter((row) => row.correlationId === saga).map(entryOf));
  });

  test("an empty outbox is an empty page with no cursor", async () => {
    expect(await admin().admin.feed({})).toEqual({ entries: [], nextCursor: null });
  });

  test("rejects a limit over 200 and a malformed cursor, naming the field", async () => {
    await expect(admin().admin.feed({ limit: 201 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("limit"),
    });
    await expect(
      admin().admin.feed({ cursor: { createdAt: NOW, id: "not-a-uuid" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("id") });
  });

  test("is UNAUTHORIZED without the admin cookie", async () => {
    await expect(adminCaller(db, NOW, { isAdmin: false }).admin.feed({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
