import { randomUUID } from "node:crypto";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeEach, describe, expect, test } from "vitest";
import { type Buyer, HoldExpiredError, SeatUnavailableError } from "./booking-service";
import {
  block,
  bookingTestBed,
  freshBuyer,
  NOW,
  rowLock,
  settledUnlessBlocked,
  waitUntilBlocked,
} from "./testing";

const database = setupTestDatabase();
const { db, at, freeSeats, service } = bookingTestBed(database);

const ONE_MINUTE = 60_000;
const contact = { email: "alice@example.com" };

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

async function aliceHolds(count = 1) {
  const { eventId, seatIds } = await freeSeats(count);
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
    const [target] = (await freeSeats(1, { eventId })).seatIds;
    if (target === undefined) {
      throw new Error("seed has no free seat left");
    }
    // While the lock is held, the target joins Alice's hold: the snapshot saw it AVAILABLE.
    const lock = await block(db(), rowLock("seats", [target]), {
      what: "the seat lock",
      afterRelease: (tx) =>
        tx.$executeRaw`UPDATE seats SET status = 'HELD', "holdId" = ${hold.id}::uuid,
        "claimBuyerKey" = ${alice.buyerKey} WHERE id = ${target}::uuid`,
    });
    const clock = fakeClock(new Date(hold.holdExpiresAt.getTime() - ONE_MINUTE));
    const call = service({ clock }).holdSeats(bob, eventId, [target]);
    try {
      await waitUntilBlocked(db(), lock.pid, {
        what: "holdSeats waiting on the seat lock",
        against: call,
      });
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
    const lock = await block(db(), rowLock("seats", [seatIds[0] ?? ""]), {
      what: "the seats row lock",
    });
    const clock = fakeClock(new Date(NOW.getTime() + ONE_MINUTE));
    const call = service({ clock })
      .placeOrder(alice, hold.id, contact, randomUUID())
      .then(
        () => "placed",
        (error: unknown) => error,
      );
    try {
      await waitUntilBlocked(db(), lock.pid, {
        what: "placeOrder waiting on the seat lock",
        against: call,
      });
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
    const lock = await block(db(), rowLock("holds", [hold.id]), {
      what: "the holds row lock",
    });
    try {
      const outcome = await settledUnlessBlocked(
        db(),
        lock.pid,
        at(hold.holdExpiresAt).sweepExpired(),
      );

      expect(outcome).not.toBe("blocked");
      expect(outcome).toMatchObject({
        status: "fulfilled",
        value: { expiredHoldIds: expect.any(Array) },
      });
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
    const lock = await block(db(), rowLock("seats", [seatIds[0] ?? ""]), {
      what: "the seats row lock",
    });
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
      await waitUntilBlocked(db(), lock.pid, {
        what: "placeOrder waiting on the seat lock",
        against: placing,
      });
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
    const lock = await block(db(), rowLock("seats", [seatIds[0] ?? ""]), {
      what: "the seats row lock",
    });
    const sweeping = at(hold.holdExpiresAt).sweepExpired();
    let placing: Promise<unknown> = Promise.resolve();
    try {
      // The sweeper owns the hold lock and waits on the seat; placeOrder then queues on the hold.
      const [sweeper] = await waitUntilBlocked(db(), lock.pid, {
        what: "the sweeper waiting on the seat lock",
        against: sweeping,
      });
      placing = at(new Date(NOW.getTime() + ONE_MINUTE))
        .placeOrder(alice, hold.id, contact, randomUUID())
        .then(
          () => "placed",
          (error: unknown) => error,
        );
      await waitUntilBlocked(db(), sweeper?.pid ?? -1, {
        what: "placeOrder waiting on the hold lock the sweeper owns",
        against: placing,
      });
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
