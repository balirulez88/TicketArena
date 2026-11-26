import { DEFAULT_BOOKING_TIMEOUTS } from "@ticketarena/booking";
import { NOW, testClients, withClient } from "@ticketarena/booking/testing";
import { silentLogger } from "@ticketarena/contracts";
import { seedCatalog } from "@ticketarena/db/seed";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { TRPCError } from "@trpc/server";
import { beforeAll, describe, expect, test } from "vitest";
import { createCaller } from "./_app";

// Runs in declaration order and shuffled (vitest.config.ts): no test may rely on another's writes.
const database = setupTestDatabase();
const { db } = testClients(database);

function caller() {
  return createCaller({
    now: () => NOW,
    principal: { kind: "guest", sessionId: "0123456789abcdef0123456789abcdef" },
    isAdmin: false,
    bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
    db,
    logger: silentLogger,
    metrics: () => ({ increment: async () => undefined }),
    metricsReader: () => {
      throw new Error("metrics are not read here");
    },
    metricsReset: () => {
      throw new Error("metrics are not reset here");
    },
    rateLimiter: () => {
      throw new Error("nothing is rate-limited here");
    },
    queueStore: () => Promise.reject(new Error("the queue is not used here")),
    random: { next: () => 0 },
    admissionTokens: {
      issue: () => Promise.reject(new Error("admission is not used here")),
      read: () => Promise.reject(new Error("admission is not used here")),
    },
  });
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  await withClient(database, (seeding) => seedCatalog(seeding, NOW));
});

/** Every seat of the event back to the seeded state, so a test asserts only what it set up. */
async function resetSeats(eventId: string): Promise<void> {
  await db().seat.updateMany({
    where: { eventId },
    data: { status: "AVAILABLE", holdId: null, claimBuyerKey: null },
  });
}

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
    await resetSeats(eventId);
    const seatCount = await db().seat.count({ where: { eventId } });

    const map = await caller().seats.map({ eventId });

    expect(map.eventId).toBe(eventId);
    expect(map.seats).toHaveLength(seatCount);
    expect(map.seats.filter((seat) => seat.status !== "AVAILABLE")).toEqual([]);
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
    await resetSeats(eventId);
    // Chosen explicitly: the last seat in map order.
    const seat = (await caller().seats.map({ eventId })).seats.at(-1);
    if (seat === undefined) {
      throw new Error("the event has no seats");
    }
    await db().seat.update({ where: { id: seat.id }, data: { status: "SOLD" } });

    try {
      const map = await caller().seats.map({ eventId });

      expect(map.seats.find((candidate) => candidate.id === seat.id)?.status).toBe("SOLD");
      expect(map.seats.filter((candidate) => candidate.status === "SOLD")).toHaveLength(1);
    } finally {
      await resetSeats(eventId);
    }
  });

  test("an unknown event id is NOT_FOUND", async () => {
    await expect(caller().seats.map({ eventId: UNKNOWN_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
