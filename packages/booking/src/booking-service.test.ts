import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService, SeatUnavailableError } from "./booking-service";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
const alice: Buyer = { sessionId: "a".repeat(32), buyerKey: "a".repeat(32) };
const bob: Buyer = { sessionId: "b".repeat(32), buyerKey: "b".repeat(32) };

function service(now = NOW) {
  return createBookingService({ db: db(), clock: { now: () => now }, newId: randomUUID });
}

async function freshSeats(count: number) {
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  const seats = await db().seat.findMany({
    where: { eventId: event.id, status: "AVAILABLE" },
    take: count,
    orderBy: { id: "asc" },
  });
  return { eventId: event.id, seatIds: seats.map((seat) => seat.id) };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("holdSeats", () => {
  test("holds an available seat for 10 minutes after the clock reading", async () => {
    const { eventId, seatIds } = await freshSeats(1);

    const hold = await service().holdSeats(alice, eventId, seatIds);

    expect(hold.holdExpiresAt).toEqual(new Date("2027-03-01T12:10:00.000Z"));
    expect(hold.status).toBe("HELD");
    expect(hold.seatIds).toEqual(seatIds);
    const seat = await db().seat.findUniqueOrThrow({ where: { id: seatIds[0] ?? "" } });
    expect(seat).toMatchObject({
      status: "HELD",
      holdId: hold.id,
      claimBuyerKey: alice.buyerKey,
    });
  });

  test("writes a seat.held outbox event with the hold's correlationId in the same commit", async () => {
    const { eventId, seatIds } = await freshSeats(1);

    const hold = await service().holdSeats(alice, eventId, seatIds);

    const rows = await db().outboxEvent.findMany({ where: { aggregateId: hold.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "seat.held", status: "PENDING" });
    expect(rows[0]?.payload).toMatchObject({
      id: rows[0]?.id,
      type: "seat.held",
      correlationId: hold.correlationId,
      causationId: null,
      holdId: hold.id,
      occurredAt: NOW.toISOString(),
      payload: {
        holdId: hold.id,
        eventId,
        seatIds,
        holdExpiresAt: "2027-03-01T12:10:00.000Z",
      },
    });
  });

  test("mints a different correlationId for each hold", async () => {
    const { eventId, seatIds } = await freshSeats(2);

    const first = await service().holdSeats(alice, eventId, [seatIds[0] ?? ""]);
    const second = await service().holdSeats(alice, eventId, [seatIds[1] ?? ""]);

    expect(first.correlationId).not.toBe(second.correlationId);
  });

  test("a held seat is SEAT_UNAVAILABLE naming its id, and nothing is written", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    await service().holdSeats(alice, eventId, seatIds);
    const holdsBefore = await db().hold.count();
    const outboxBefore = await db().outboxEvent.count();

    const failure = await service()
      .holdSeats(bob, eventId, seatIds)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SeatUnavailableError);
    expect(failure).toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds });
    expect(await db().hold.count()).toBe(holdsBefore);
    expect(await db().outboxEvent.count()).toBe(outboxBefore);
  });

  test("a seat of another event is SEAT_UNAVAILABLE", async () => {
    const { seatIds } = await freshSeats(1);
    const other = await db().event.findFirstOrThrow({ where: { demo: false } });

    await expect(service().holdSeats(alice, other.id, seatIds)).rejects.toMatchObject({
      code: "SEAT_UNAVAILABLE",
      seatIds,
    });
  });

  test("two concurrent holds of one seat: exactly one wins", async () => {
    const { eventId, seatIds } = await freshSeats(1);

    const results = await Promise.allSettled([
      service().holdSeats(alice, eventId, seatIds),
      service().holdSeats(bob, eventId, seatIds),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [loser] = results.filter((result) => result.status === "rejected");
    expect(loser?.reason).toBeInstanceOf(SeatUnavailableError);
  });

  test("reads the clock after taking the seat lock", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    const seatId = seatIds[0] ?? "";
    let readAfterLockRelease = false;
    let lockHeld = true;
    const clock = {
      now: () => {
        readAfterLockRelease = !lockHeld;
        return NOW;
      },
    };
    const blocker = db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seatId}::uuid FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 300));
      lockHeld = false;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await createBookingService({ db: db(), clock, newId: randomUUID }).holdSeats(
      alice,
      eventId,
      seatIds,
    );
    await blocker;

    expect(readAfterLockRelease).toBe(true);
  });
});

describe("getHold", () => {
  test("returns the hold to its owner", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);

    expect(await service().getHold(alice, hold.id)).toEqual(hold);
  });

  test("returns null to another buyer and for an unknown id", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);

    expect(await service().getHold(bob, hold.id)).toBeNull();
    expect(await service().getHold(alice, randomUUID())).toBeNull();
  });
});
