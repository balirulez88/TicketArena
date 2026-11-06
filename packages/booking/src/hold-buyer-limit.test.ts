import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");

function buyer(n: number): Buyer {
  const key = n.toString(16).padStart(32, "0");
  return { sessionId: key, buyerKey: key };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

async function freeSeats(count: number) {
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  const seats = await db().seat.findMany({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "asc" },
    take: count,
  });
  return { eventId: event.id, seatIds: seats.map((seat) => seat.id) };
}

function service() {
  return createBookingService({ db: db(), clock: { now: () => NOW }, newId: randomUUID });
}

describe("buyer limit", () => {
  test("two parallel 4-seat holds by one buyer: one wins, one is LIMIT_EXCEEDED", async () => {
    const eight = await freeSeats(8);
    const a = { eventId: eight.eventId, seatIds: eight.seatIds.slice(0, 4) };
    const b = { eventId: eight.eventId, seatIds: eight.seatIds.slice(4) };
    const results = await Promise.allSettled([
      service().holdSeats(buyer(10), a.eventId, a.seatIds),
      service().holdSeats(buyer(10), b.eventId, b.seatIds),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  test("seats in checkout still count: hold 4, place order, a further 3 is refused", async () => {
    const first = await freeSeats(4);
    const hold = await service().holdSeats(buyer(11), first.eventId, first.seatIds);
    await service().placeOrder(buyer(11), hold.id, { email: "a@example.com" }, randomUUID());
    const more = await freeSeats(3);
    await expect(service().holdSeats(buyer(11), more.eventId, more.seatIds)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect(await db().seat.count({ where: { id: { in: more.seatIds }, status: "HELD" } })).toBe(0);
  });

  test("a refused limit leaves room for a smaller hold", async () => {
    const first = await freeSeats(4);
    await service().holdSeats(buyer(12), first.eventId, first.seatIds);
    const rest = await freeSeats(2);
    const hold = await service().holdSeats(buyer(12), rest.eventId, rest.seatIds);
    expect(hold.seatIds).toHaveLength(2);
  });
});

describe("buyer limit counting", () => {
  test("a refused limit is counted as limit_exceeded", async () => {
    const counted: string[] = [];
    const counting = createBookingService({
      db: db(),
      clock: { now: () => NOW },
      newId: randomUUID,
      metrics: {
        increment: (metric) => {
          counted.push(metric);
          return Promise.resolve();
        },
      },
    });
    const first = await freeSeats(4);
    await counting.holdSeats(buyer(20), first.eventId, first.seatIds);
    const more = await freeSeats(3);

    await expect(counting.holdSeats(buyer(20), more.eventId, more.seatIds)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect(counted).toEqual(["hold_ok", "limit_exceeded"]);
  });

  test("seats of an expired hold no longer count", async () => {
    const first = await freeSeats(6);
    await service().holdSeats(buyer(21), first.eventId, first.seatIds);
    const later = createBookingService({
      db: db(),
      clock: { now: () => new Date(NOW.getTime() + 11 * 60_000) },
      newId: randomUUID,
    });
    const more = await freeSeats(1);

    const hold = await later.holdSeats(buyer(21), more.eventId, more.seatIds);

    expect(hold.seatIds).toHaveLength(1);
  });

  test("sold seats count towards the limit", async () => {
    const sold = await freeSeats(5);
    await db().seat.updateMany({
      where: { id: { in: sold.seatIds } },
      data: { status: "SOLD", claimBuyerKey: buyer(22).buyerKey },
    });
    const two = await freeSeats(2);
    await expect(service().holdSeats(buyer(22), two.eventId, two.seatIds)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    const hold = await service().holdSeats(buyer(22), two.eventId, two.seatIds.slice(0, 1));
    expect(hold.seatIds).toHaveLength(1);
  });
});

/** Two buyers race {s1,s2,s3} against {s5,s4,s3}: opposite orders, one shared seat. */
async function raceOverlapping(round: number) {
  const { eventId, seatIds } = await freeSeats(5);
  const [s1, s2, s3, s4, s5] = seatIds;
  const forward = [s1, s2, s3].filter((id): id is string => id !== undefined);
  const backward = [s5, s4, s3].filter((id): id is string => id !== undefined);
  const results = await Promise.allSettled([
    service().holdSeats(buyer(100 + round * 2), eventId, forward),
    service().holdSeats(buyer(101 + round * 2), eventId, backward),
  ]);
  return { seatIds, forward, backward, results };
}

describe("overlapping multi-seat holds (AT-02)", () => {
  test("opposite-order overlapping sets from different buyers: one wins, the loser holds nothing", async () => {
    for (let round = 0; round < 8; round++) {
      const { seatIds, forward, backward, results } = await raceOverlapping(round);

      const [first, second] = results;
      const forwardWon = first?.status === "fulfilled";
      expect([first?.status, second?.status].sort()).toEqual(["fulfilled", "rejected"]);
      const loser = forwardWon ? second : first;
      expect(loser?.status === "rejected" && loser.reason).toMatchObject({
        code: "SEAT_UNAVAILABLE",
      });
      const held = await db().seat.findMany({
        where: { id: { in: seatIds }, status: "HELD" },
        select: { id: true },
      });
      expect(held.map((seat) => seat.id).sort()).toEqual(
        [...(forwardWon ? forward : backward)].sort(),
      );
      // Free the seats so eight rounds fit in the small demo venue.
      await db().seat.updateMany({
        where: { id: { in: seatIds } },
        data: { status: "AVAILABLE", holdId: null, claimBuyerKey: null },
      });
    }
  });
});

describe("buyer lock order (ADR 0005)", () => {
  const sleep = (ms: number) =>
    new Promise<"pending">((resolve) => setTimeout(resolve, ms, "pending"));

  /** Holds the buyer's advisory lock in a foreign transaction until `release` is called. */
  async function holdBuyerLock(eventId: string, buyerKey: string) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const finished = db().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${eventId}:${buyerKey}`}, 0))`;
      locked();
      await gate;
    });
    await acquired;
    return { release, finished };
  }

  test("holdSeats waits on the buyer lock before touching any seat row", async () => {
    const { eventId, seatIds } = await freeSeats(2);
    const lock = await holdBuyerLock(eventId, buyer(30).buyerKey);

    const pending = service().holdSeats(buyer(30), eventId, seatIds);
    expect(await Promise.race([pending.then(() => "done"), sleep(400)])).toBe("pending");
    // NOWAIT fails if the waiting hold already row-locked a seat.
    const probe = await db().$transaction(
      (tx) =>
        tx.$queryRaw`SELECT id FROM seats WHERE id = ANY(${seatIds}::uuid[]) FOR UPDATE NOWAIT`,
    );
    expect(probe).toHaveLength(2);

    lock.release();
    await lock.finished;
    expect((await pending).seatIds).toHaveLength(2);
  });

  test("placeOrder takes the same buyer lock", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(buyer(31), eventId, seatIds);
    const lock = await holdBuyerLock(eventId, buyer(31).buyerKey);

    const pending = service().placeOrder(
      buyer(31),
      hold.id,
      { email: "a@example.com" },
      randomUUID(),
    );
    expect(await Promise.race([pending.then(() => "done"), sleep(400)])).toBe("pending");

    lock.release();
    await lock.finished;
    expect((await pending).status).toBe("PENDING_PAYMENT");
  });
});
