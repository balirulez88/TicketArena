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
  /**
   * Holds the buyer's advisory lock in a foreign transaction until `release` is called, so the
   * service's requests for that buyer queue behind it where the test can observe them.
   */
  async function holdBuyerLock(eventId: string, buyerKey: string) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: (pid: number) => void = () => undefined;
    const acquired = new Promise<number>((resolve) => {
      locked = resolve;
    });
    const finished = db().$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${eventId}:${buyerKey}`}, 0))`;
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (backend === undefined) {
          throw new Error("pg_backend_pid() returned no row");
        }
        locked(backend.pid);
        await gate;
      },
      { timeout: 30_000 },
    );
    const lockerPid = await acquired;
    return {
      /**
       * Resolves once `count` backends wait, behind this transaction, on an advisory lock: the
       * buyer lock. Postgres reports the wait itself, so no timing assumption is involved. A
       * request that skipped the buyer lock never shows up here and the poll times out.
       */
      waitForBuyerLockWaiters: (count: number) =>
        expect
          .poll(
            async () => {
              const [row] = await db().$queryRaw<{ waiting: bigint }[]>`
                SELECT count(DISTINCT pid) AS waiting FROM pg_locks
                WHERE locktype = 'advisory' AND NOT granted
                  AND ${lockerPid}::int = ANY(pg_blocking_pids(pid))`;
              return Number(row?.waiting ?? 0);
            },
            { timeout: 10_000 },
          )
          .toBe(count),
      release: async () => {
        release();
        await finished;
      },
    };
  }

  /** NOWAIT fails at once if a request queued on the buyer lock already row-locked any of these. */
  function lockRowsNowait(holdIds: string[], seatIds: string[]) {
    return db().$transaction(async (tx) => {
      const holds = await tx.$queryRaw<unknown[]>`
        SELECT id FROM holds WHERE id = ANY(${holdIds}::uuid[]) FOR UPDATE NOWAIT`;
      const seats = await tx.$queryRaw<unknown[]>`
        SELECT id FROM seats WHERE id = ANY(${seatIds}::uuid[]) FOR UPDATE NOWAIT`;
      return { holds: holds.length, seats: seats.length };
    });
  }

  test("holdSeats waits on the buyer lock before touching any seat row", async () => {
    const { eventId, seatIds } = await freeSeats(2);
    const lock = await holdBuyerLock(eventId, buyer(30).buyerKey);

    const pending = service().holdSeats(buyer(30), eventId, seatIds);
    try {
      await lock.waitForBuyerLockWaiters(1);
      expect(await lockRowsNowait([], seatIds)).toEqual({ holds: 0, seats: 2 });
    } finally {
      await lock.release();
    }
    expect((await pending).seatIds).toHaveLength(2);
  });

  test("placeOrder waits on the buyer lock before locking the hold or its seats", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(buyer(31), eventId, seatIds);
    const lock = await holdBuyerLock(eventId, buyer(31).buyerKey);

    const pending = service().placeOrder(
      buyer(31),
      hold.id,
      { email: "a@example.com" },
      randomUUID(),
    );
    try {
      await lock.waitForBuyerLockWaiters(1);
      expect(await lockRowsNowait([hold.id], seatIds)).toEqual({ holds: 1, seats: 1 });
    } finally {
      await lock.release();
    }
    expect((await pending).status).toBe("PENDING_PAYMENT");
  });

  // TD-026: a hold and an order of one buyer, in flight together, queue on the buyer lock with no
  // row lock taken, so neither can deadlock the other and each decides on the other's committed
  // result. Whichever runs first, the outcome is the same, which is what the assertions check.
  test.each([
    { held: 2, more: 2, refused: false },
    { held: 4, more: 3, refused: true },
  ])(
    "a hold of $more seats racing the order of a $held-seat hold queues on the buyer lock (limit refused: $refused)",
    async ({ held, more, refused }) => {
      const who = buyer(40 + held);
      const first = await freeSeats(held);
      const hold = await service().holdSeats(who, first.eventId, first.seatIds);
      const extra = await freeSeats(more);
      const lock = await holdBuyerLock(first.eventId, who.buyerKey);

      const order = service().placeOrder(who, hold.id, { email: "a@example.com" }, randomUUID());
      const second = service().holdSeats(who, extra.eventId, extra.seatIds);
      const settled = Promise.allSettled([order, second]);
      try {
        await lock.waitForBuyerLockWaiters(2);
        expect(await lockRowsNowait([hold.id], [...first.seatIds, ...extra.seatIds])).toEqual({
          holds: 1,
          seats: held + more,
        });
      } finally {
        await lock.release();
      }
      const [placed, again] = await settled;

      expect(placed).toMatchObject({ status: "fulfilled", value: { status: "PENDING_PAYMENT" } });
      expect(
        await db().seat.count({ where: { id: { in: first.seatIds }, status: "IN_CHECKOUT" } }),
      ).toBe(held);
      if (refused) {
        expect(again).toMatchObject({ status: "rejected", reason: { code: "LIMIT_EXCEEDED" } });
        expect(
          await db().seat.count({
            where: {
              id: { in: extra.seatIds },
              OR: [{ status: { not: "AVAILABLE" } }, { holdId: { not: null } }],
            },
          }),
        ).toBe(0);
      } else {
        expect(again).toMatchObject({ status: "fulfilled", value: { seatIds: expect.any(Array) } });
        expect(
          await db().seat.count({ where: { id: { in: extra.seatIds }, status: "HELD" } }),
        ).toBe(more);
      }
    },
  );
});
