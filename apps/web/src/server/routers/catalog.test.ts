import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCaller } from "./_app";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

function caller() {
  return createCaller({
    now: () => new Date("2027-03-01T12:00:00.000Z"),
    principal: { kind: "guest", sessionId: "0123456789abcdef0123456789abcdef" },
    db: db(),
  });
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  await seedCatalog(db(), new Date("2027-03-01T12:00:00.000Z"));
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("events.list", () => {
  test("lists seeded events by on-sale time with their venue and one demo event", async () => {
    const events = await caller().events.list();

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.demo)).toHaveLength(1);
    expect(events.map((event) => event.onSaleAt.getTime())).toEqual(
      events.map((event) => event.onSaleAt.getTime()).sort((a, b) => a - b),
    );
    expect(events[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      venueName: expect.any(String),
      queueOpensAt: expect.any(Date),
      queueClosesAt: expect.any(Date),
    });
  });
});

describe("events.get", () => {
  test("returns the event with the price of each section in minor units", async () => {
    const [first] = await caller().events.list();
    const event = await caller().events.get({ eventId: first?.id ?? "" });

    expect(event.id).toBe(first?.id);
    expect(event.sections.length).toBeGreaterThan(0);
    for (const section of event.sections) {
      expect(Number.isInteger(section.priceMinor)).toBe(true);
      expect(section.currency).toBe("EUR");
    }
  });

  test("an unknown event id is NOT_FOUND", async () => {
    await expect(caller().events.get({ eventId: UNKNOWN_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("a malformed event id is rejected naming the field", async () => {
    const failure = await caller()
      .events.get({ eventId: "nope" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TRPCError);
    expect(failure).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("eventId"),
    });
  });
});

describe("seats.map", () => {
  test("returns every seat of the event with status, section, row, number and section price", async () => {
    const [first] = await caller().events.list();
    const eventId = first?.id ?? "";
    const seatCount = await db().seat.count({ where: { eventId } });

    const map = await caller().seats.map({ eventId });

    expect(map.eventId).toBe(eventId);
    expect(map.seats).toHaveLength(seatCount);
    expect(map.seats[0]).toEqual({
      id: expect.any(String),
      section: expect.any(String),
      row: expect.any(String),
      number: expect.any(Number),
      status: "AVAILABLE",
      priceMinor: expect.any(Number),
      currency: "EUR",
    });
  });

  test("reflects a seat that is no longer available", async () => {
    const [first] = await caller().events.list();
    const eventId = first?.id ?? "";
    const seat = await db().seat.findFirstOrThrow({ where: { eventId } });
    await db().seat.update({ where: { id: seat.id }, data: { status: "SOLD" } });

    const map = await caller().seats.map({ eventId });

    expect(map.seats.find((candidate) => candidate.id === seat.id)?.status).toBe("SOLD");
  });

  test("an unknown event id is NOT_FOUND", async () => {
    await expect(caller().seats.map({ eventId: UNKNOWN_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
