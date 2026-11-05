import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type BookingMetric, type Buyer, createBookingService } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
const bob: Buyer = { sessionId: "b".repeat(32), buyerKey: "b".repeat(32) };
const FAST_PATH_BUDGET_MS = 1_500;
const alice: Buyer = { sessionId: "a".repeat(32), buyerKey: "a".repeat(32) };

async function freeSeat(eventId: string) {
  return db().seat.findFirstOrThrow({
    where: { eventId, status: "AVAILABLE" },
    orderBy: { id: "desc" },
  });
}

/** Resolves with the rejection (or "held") unless the call is still waiting after the budget. */
function settleWithin(call: Promise<unknown>) {
  return Promise.race([
    call.then(
      () => "held" as const,
      (error: unknown) => error,
    ),
    new Promise<"blocked">((resolve) => setTimeout(resolve, FAST_PATH_BUDGET_MS, "blocked")),
  ]);
}

function recordingMetrics() {
  const calls: BookingMetric[] = [];
  return {
    calls,
    // Never settles: proves the booking does not wait on metrics.
    metrics: {
      increment: (metric: BookingMetric) => {
        calls.push(metric);
        return new Promise<void>(() => undefined);
      },
    },
  };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

/** Holds a row lock on `seatId` in another transaction until the returned `release` is called. */
async function lockSeatElsewhere(seatId: string, thenSetStatus?: "SOLD") {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: (backendPid: number) => void = () => undefined;
  const lockTaken = new Promise<number>((resolve) => {
    locked = resolve;
  });
  const transaction = db().$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seatId}::uuid FOR UPDATE`;
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (backend === undefined) {
        throw new Error("pg_backend_pid() returned no row");
      }
      locked(backend.pid);
      await gate;
      if (thenSetStatus !== undefined) {
        await tx.seat.update({ where: { id: seatId }, data: { status: thenSetStatus } });
      }
    },
    { timeout: 30_000 },
  );
  const lockerPid = await lockTaken;
  return {
    /**
     * Resolves once another backend is queued behind this lock. holdSeats reads its lock-free
     * snapshot before it opens the locking transaction, so from then on the snapshot has already
     * seen the seat as it was before `release` changes it: no timing assumption is left.
     */
    waitForWaiter: () =>
      expect
        .poll(
          async () => {
            const [row] = await db().$queryRaw<{ waiting: bigint }[]>`
              SELECT count(*) AS waiting FROM pg_stat_activity
              WHERE ${lockerPid}::int = ANY(pg_blocking_pids(pid))`;
            return Number(row?.waiting ?? 0);
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0),
    release: async () => {
      release();
      await transaction;
    },
  };
}

describe("holdSeats snapshot fast path", () => {
  test.each(["SOLD", "IN_CHECKOUT"] as const)(
    "a %s seat is SEAT_UNAVAILABLE without waiting on a lock held by another transaction",
    async (status) => {
      const event = await db().event.findFirstOrThrow({ where: { demo: true } });
      const seat = await db().seat.findFirstOrThrow({
        where: { eventId: event.id, status: "AVAILABLE" },
        orderBy: { id: "desc" },
      });
      await db().seat.update({ where: { id: seat.id }, data: { status } });
      const lock = await lockSeatElsewhere(seat.id);
      const service = createBookingService({
        db: db(),
        clock: { now: () => NOW },
        newId: randomUUID,
      });

      try {
        const outcome = await Promise.race([
          service.holdSeats(bob, event.id, [seat.id]).then(
            () => "held" as const,
            (error: unknown) => error,
          ),
          new Promise<"blocked">((resolve) => setTimeout(resolve, FAST_PATH_BUDGET_MS, "blocked")),
        ]);

        expect(outcome).not.toBe("blocked");
        expect(outcome).toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds: [seat.id] });
      } finally {
        await lock.release();
      }
    },
  );
});

describe("holdSeats HELD seats and expiry", () => {
  test("an unexpired HELD seat is SEAT_UNAVAILABLE without waiting on a lock", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await freeSeat(event.id);
    const clock = { now: () => NOW };
    await createBookingService({ db: db(), clock, newId: randomUUID }).holdSeats(alice, event.id, [
      seat.id,
    ]);
    const lock = await lockSeatElsewhere(seat.id);
    const service = createBookingService({ db: db(), clock, newId: randomUUID });
    try {
      const outcome = await settleWithin(service.holdSeats(bob, event.id, [seat.id]));
      expect(outcome).toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds: [seat.id] });
    } finally {
      await lock.release();
    }
  });

  test("an expired HELD seat is not refused by the snapshot: the call goes on to wait for the lock", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await freeSeat(event.id);
    await createBookingService({
      db: db(),
      clock: { now: () => NOW },
      newId: randomUUID,
    }).holdSeats(alice, event.id, [seat.id]);
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const lock = await lockSeatElsewhere(seat.id);
    const service = createBookingService({
      db: db(),
      clock: { now: () => later },
      newId: randomUUID,
    });
    const call = service.holdSeats(bob, event.id, [seat.id]);
    try {
      expect(await settleWithin(call)).toBe("blocked");
    } finally {
      await lock.release();
      await call.catch(() => undefined);
    }
  });
});

describe("holdSeats metrics on the fast path and the race", () => {
  test("a snapshot refusal counts seat_unavailable only, without waiting on metrics", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await freeSeat(event.id);
    await db().seat.update({ where: { id: seat.id }, data: { status: "SOLD" } });
    const { calls, metrics } = recordingMetrics();
    const service = createBookingService({
      db: db(),
      clock: { now: () => NOW },
      newId: randomUUID,
      metrics,
    });
    expect(await settleWithin(service.holdSeats(bob, event.id, [seat.id]))).toMatchObject({
      code: "SEAT_UNAVAILABLE",
    });
    expect(calls).toEqual(["seat_unavailable"]);
  });

  test("a seat taken between snapshot and lock counts race_lost only", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await freeSeat(event.id);
    const lock = await lockSeatElsewhere(seat.id, "SOLD");
    const { calls, metrics } = recordingMetrics();
    const service = createBookingService({
      db: db(),
      clock: { now: () => NOW },
      newId: randomUUID,
      metrics,
    });
    const settled = service.holdSeats(bob, event.id, [seat.id]).then(
      () => "held" as const,
      (error: unknown) => error,
    );
    try {
      await lock.waitForWaiter();
    } finally {
      await lock.release();
    }
    expect(await settled).toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds: [seat.id] });
    expect(calls).toEqual(["race_lost"]);
  });

  // Until lazy expiry lands (TD-013, ticket 14) the locked step refuses an expired HELD seat that
  // the snapshot let through. Nobody changed the seat in between, so no race was lost.
  test("an expired HELD seat refused under the lock counts seat_unavailable, not race_lost", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await freeSeat(event.id);
    await createBookingService({
      db: db(),
      clock: { now: () => NOW },
      newId: randomUUID,
    }).holdSeats(alice, event.id, [seat.id]);
    const { calls, metrics } = recordingMetrics();
    const service = createBookingService({
      db: db(),
      clock: { now: () => new Date(NOW.getTime() + 24 * 60 * 60 * 1000) },
      newId: randomUUID,
      metrics,
    });
    expect(await settleWithin(service.holdSeats(bob, event.id, [seat.id]))).toMatchObject({
      code: "SEAT_UNAVAILABLE",
      seatIds: [seat.id],
    });
    expect(calls).toEqual(["seat_unavailable"]);
  });

  test("a seat id outside the event counts seat_unavailable, not race_lost", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const unknownSeatId = randomUUID();
    const { calls, metrics } = recordingMetrics();
    const service = createBookingService({
      db: db(),
      clock: { now: () => NOW },
      newId: randomUUID,
      metrics,
    });
    expect(await settleWithin(service.holdSeats(bob, event.id, [unknownSeatId]))).toMatchObject({
      code: "SEAT_UNAVAILABLE",
      seatIds: [unknownSeatId],
    });
    expect(calls).toEqual(["seat_unavailable"]);
  });
});
