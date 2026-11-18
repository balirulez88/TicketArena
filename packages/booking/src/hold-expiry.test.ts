import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  type Buyer,
  createBookingService,
  HoldExpiredError,
  SeatUnavailableError,
} from "./booking-service";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
const ONE_MINUTE = 60_000;
const NO_WAIT_BUDGET_MS = 1_500;
const contact = { email: "alice@example.com" };

function freshBuyer(): Buyer {
  const key = randomUUID().replaceAll("-", "");
  return { sessionId: key, buyerKey: key };
}

// Fresh per test: the buyer limit counts a buyer's seats across the shared database.
let alice: Buyer = freshBuyer();
let bob: Buyer = freshBuyer();

beforeEach(() => {
  alice = freshBuyer();
  bob = freshBuyer();
});

/** The fake clock: tests move it while a call waits on a lock. */
function fakeClock(at: Date) {
  const clock = { at, now: () => clock.at };
  return clock;
}

function service(clock: { now: () => Date }) {
  return createBookingService({ db: db(), clock, newId: randomUUID });
}

function at(when: Date) {
  return service({ now: () => when });
}

async function demoEventId(): Promise<string> {
  return (await db().event.findFirstOrThrow({ where: { demo: true } })).id;
}

async function freeSeatIds(eventId: string, count: number): Promise<string[]> {
  const seats = await db().seat.findMany({
    where: { eventId, status: "AVAILABLE" },
    orderBy: { id: "asc" },
    take: count,
  });
  return seats.map((seat) => seat.id);
}

async function aliceHolds(count = 1) {
  const eventId = await demoEventId();
  const seatIds = await freeSeatIds(eventId, count);
  const hold = await at(NOW).holdSeats(alice, eventId, seatIds);
  return { eventId, seatIds, hold };
}

function seat(id: string) {
  return db().seat.findUniqueOrThrow({ where: { id } });
}

function holdStatus(id: string) {
  return db()
    .hold.findUniqueOrThrow({ where: { id } })
    .then((hold) => hold.status);
}

function expiredEvents(holdId: string) {
  return db().outboxEvent.findMany({ where: { aggregateId: holdId, eventType: "hold.expired" } });
}

/** Resolves with the outcome, or "blocked" if the call is still waiting after the budget. */
function settleWithin<T>(call: Promise<T>) {
  return Promise.race([
    call.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    new Promise<"blocked">((resolve) => setTimeout(resolve, NO_WAIT_BUDGET_MS, "blocked")),
  ]);
}

/** Polls until at least `count` backends of this test database are waiting on a lock. */
async function waitForLockWaiters(count: number) {
  await expect
    .poll(
      async () => {
        const [row] = await db().$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        return Number(row?.waiting ?? 0);
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(count);
}

/**
 * Holds a row lock on `table`/`id` in another transaction until `release` is called; `beforeCommit`
 * runs inside that transaction just before it commits.
 */
async function lockRowElsewhere(
  table: "seats" | "holds",
  id: string,
  beforeCommit?: (tx: Pick<PrismaClient, "$executeRaw">) => Promise<unknown>,
) {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let locked: () => void = () => undefined;
  const lockTaken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const transaction = db().$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE`, id);
      locked();
      await gate;
      await beforeCommit?.(tx);
    },
    { timeout: 30_000 },
  );
  await lockTaken;
  return {
    release: async () => {
      open();
      await transaction;
    },
  };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("holdSeats lazy expiry", () => {
  test("AT-07: an expired hold's seat can be held by another buyer before the sweeper runs", async () => {
    const { eventId, seatIds, hold } = await aliceHolds();

    const taken = await at(hold.holdExpiresAt).holdSeats(bob, eventId, seatIds);

    expect(taken).toMatchObject({ status: "HELD", seatIds });
    expect(await seat(seatIds[0] ?? "")).toMatchObject({
      status: "HELD",
      holdId: taken.id,
      claimBuyerKey: bob.buyerKey,
    });
    // The sweeper has not run: the abandoned hold is still HELD, it just no longer owns the seat.
    expect(await holdStatus(hold.id)).toBe("HELD");
  });

  test("a hold is still valid one millisecond before holdExpiresAt", async () => {
    const { eventId, seatIds, hold } = await aliceHolds();

    await expect(
      at(new Date(hold.holdExpiresAt.getTime() - 1)).holdSeats(bob, eventId, seatIds),
    ).rejects.toBeInstanceOf(SeatUnavailableError);
    expect(await seat(seatIds[0] ?? "")).toMatchObject({ holdId: hold.id });
  });

  test("decides expiry with T read after the seat locks, not before the lock wait", async () => {
    const { eventId, hold } = await aliceHolds();
    const [target] = await freeSeatIds(eventId, 1);
    if (target === undefined) {
      throw new Error("seed has no free seat left");
    }
    // While the lock is held, the target joins Alice's hold: the snapshot saw it AVAILABLE.
    const lock = await lockRowElsewhere(
      "seats",
      target,
      (tx) =>
        tx.$executeRaw`UPDATE seats SET status = 'HELD', "holdId" = ${hold.id}::uuid,
        "claimBuyerKey" = ${alice.buyerKey} WHERE id = ${target}::uuid`,
    );
    const clock = fakeClock(new Date(hold.holdExpiresAt.getTime() - ONE_MINUTE));
    const call = service(clock).holdSeats(bob, eventId, [target]);
    try {
      await waitForLockWaiters(1);
      clock.at = hold.holdExpiresAt;
    } finally {
      await lock.release();
    }

    const taken = await call;
    expect(await seat(target)).toMatchObject({ status: "HELD", holdId: taken.id });
  });
});

describe("placeOrder and expiry", () => {
  test("AT-08: the clock moved past holdExpiresAt while placeOrder waits on a lock gives HOLD_EXPIRED", async () => {
    const { seatIds, hold } = await aliceHolds();
    const lock = await lockRowElsewhere("seats", seatIds[0] ?? "");
    const clock = fakeClock(new Date(NOW.getTime() + ONE_MINUTE));
    const call = service(clock)
      .placeOrder(alice, hold.id, contact, randomUUID())
      .then(
        () => "placed",
        (error: unknown) => error,
      );
    try {
      await waitForLockWaiters(1);
      clock.at = hold.holdExpiresAt;
    } finally {
      await lock.release();
    }

    expect(await call).toBeInstanceOf(HoldExpiredError);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
    expect(await seat(seatIds[0] ?? "")).toMatchObject({ status: "HELD", holdId: hold.id });
  });

  test("AT-11: placeOrder refuses when a seat's holdId no longer matches its hold", async () => {
    const { eventId, seatIds, hold } = await aliceHolds();
    // Another instance whose clock is ahead takes the seat over lazily.
    const taken = await at(hold.holdExpiresAt).holdSeats(bob, eventId, seatIds);

    // Alice's instance still believes the hold is valid; the seat ownership check refuses it.
    await expect(
      at(new Date(NOW.getTime() + ONE_MINUTE)).placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(SeatUnavailableError);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
    expect(await seat(seatIds[0] ?? "")).toMatchObject({ status: "HELD", holdId: taken.id });
  });

  test("placeOrder on a hold the sweeper already expired returns HOLD_EXPIRED", async () => {
    const { hold } = await aliceHolds();
    await at(hold.holdExpiresAt).sweepExpired();

    await expect(
      at(new Date(NOW.getTime() + ONE_MINUTE)).placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(HoldExpiredError);
  });
});

describe("sweepExpired", () => {
  test("at T = holdExpiresAt moves the hold to EXPIRED, frees its seats and writes hold.expired", async () => {
    const { seatIds, hold } = await aliceHolds(2);

    const result = await at(hold.holdExpiresAt).sweepExpired();

    expect(result.expiredHoldIds).toContain(hold.id);
    expect(await holdStatus(hold.id)).toBe("EXPIRED");
    const seats = await db().seat.findMany({
      where: { id: { in: seatIds } },
      orderBy: { id: "asc" },
    });
    expect(seats.map((s) => [s.status, s.holdId, s.claimBuyerKey])).toEqual([
      ["AVAILABLE", null, null],
      ["AVAILABLE", null, null],
    ]);
    const events = await expiredEvents(hold.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: "hold",
      payload: {
        type: "hold.expired",
        version: 1,
        occurredAt: hold.holdExpiresAt.toISOString(),
        correlationId: hold.correlationId,
        causationId: null,
        holdId: hold.id,
        payload: { holdId: hold.id, seatIds },
      },
    });
  });

  test("leaves a hold alone one millisecond before holdExpiresAt", async () => {
    const { seatIds, hold } = await aliceHolds();

    const result = await at(new Date(hold.holdExpiresAt.getTime() - 1)).sweepExpired();

    expect(result.expiredHoldIds).not.toContain(hold.id);
    expect(await holdStatus(hold.id)).toBe("HELD");
    expect(await seat(seatIds[0] ?? "")).toMatchObject({ status: "HELD", holdId: hold.id });
    expect(await expiredEvents(hold.id)).toHaveLength(0);
  });

  test("does not free a seat another hold took over lazily", async () => {
    const { eventId, seatIds, hold } = await aliceHolds();
    const taken = await at(hold.holdExpiresAt).holdSeats(bob, eventId, seatIds);

    await at(hold.holdExpiresAt).sweepExpired();

    expect(await holdStatus(hold.id)).toBe("EXPIRED");
    expect(await seat(seatIds[0] ?? "")).toMatchObject({ status: "HELD", holdId: taken.id });
    const [event] = await expiredEvents(hold.id);
    expect(event?.payload).toMatchObject({ payload: { holdId: hold.id, seatIds: [] } });
  });

  test("skips a hold locked by another transaction without waiting for it", async () => {
    const { hold } = await aliceHolds();
    const lock = await lockRowElsewhere("holds", hold.id);
    try {
      const outcome = await settleWithin(at(hold.holdExpiresAt).sweepExpired());

      expect(outcome).not.toBe("blocked");
      expect(outcome).toMatchObject({ value: { expiredHoldIds: expect.any(Array) } });
      expect(outcome).not.toMatchObject({ value: { expiredHoldIds: [hold.id] } });
    } finally {
      await lock.release();
    }
    expect(await holdStatus(hold.id)).toBe("HELD");
  });
});

describe("AT-09: placeOrder and the sweeper on the same hold", () => {
  test("placeOrder first: an order, the hold is not expired and the sweeper never matches it", async () => {
    const { seatIds, hold } = await aliceHolds();
    const lock = await lockRowElsewhere("seats", seatIds[0] ?? "");
    // placeOrder's instance reads a time just before expiry; the sweeper's reads one after. The
    // order's paymentDeadline + grace then lies past the sweeper's T, so the order stays pending.
    const placing = at(new Date(hold.holdExpiresAt.getTime() - ONE_MINUTE)).placeOrder(
      alice,
      hold.id,
      contact,
      randomUUID(),
    );
    let swept: { expiredHoldIds: readonly string[] } | undefined;
    try {
      // placeOrder now owns the hold lock and waits on the seat.
      await waitForLockWaiters(1);
      swept = await at(hold.holdExpiresAt).sweepExpired();
    } finally {
      await lock.release();
    }
    const order = await placing;
    const sweptAgain = await at(hold.holdExpiresAt).sweepExpired();

    expect(order).toMatchObject({ holdId: hold.id, status: "PENDING_PAYMENT" });
    expect(swept?.expiredHoldIds).not.toContain(hold.id);
    expect(sweptAgain.expiredHoldIds).not.toContain(hold.id);
    expect(await holdStatus(hold.id)).toBe("ORDERED");
    expect(await seat(seatIds[0] ?? "")).toMatchObject({ status: "IN_CHECKOUT", holdId: hold.id });
    expect(await expiredEvents(hold.id)).toHaveLength(0);
  });

  test("sweeper first: HOLD_EXPIRED, the seats are freed and no order exists", async () => {
    const { seatIds, hold } = await aliceHolds();
    const lock = await lockRowElsewhere("seats", seatIds[0] ?? "");
    const sweeping = at(hold.holdExpiresAt).sweepExpired();
    let placing: Promise<unknown> = Promise.resolve();
    try {
      // The sweeper owns the hold lock and waits on the seat; placeOrder then queues on the hold.
      await waitForLockWaiters(1);
      placing = at(new Date(NOW.getTime() + ONE_MINUTE))
        .placeOrder(alice, hold.id, contact, randomUUID())
        .then(
          () => "placed",
          (error: unknown) => error,
        );
      await waitForLockWaiters(2);
    } finally {
      await lock.release();
    }

    expect((await sweeping).expiredHoldIds).toContain(hold.id);
    expect(await placing).toBeInstanceOf(HoldExpiredError);
    expect(await holdStatus(hold.id)).toBe("EXPIRED");
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
    expect(await seat(seatIds[0] ?? "")).toMatchObject({ status: "AVAILABLE", holdId: null });
    expect(await expiredEvents(hold.id)).toHaveLength(1);
  });
});
