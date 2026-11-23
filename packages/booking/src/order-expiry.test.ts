import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  type Buyer,
  type Contact,
  createBookingService,
  LimitExceededError,
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
const SETTLEMENT_GRACE_MS = 60_000;
const NO_WAIT_BUDGET_MS = 1_500;
const contact: Contact = { email: "alice@example.com", phone: "+36301234567" };

function freshBuyer(): Buyer {
  const key = randomUUID().replaceAll("-", "");
  return { sessionId: key, buyerKey: key };
}

let alice: Buyer = freshBuyer();
let bob: Buyer = freshBuyer();

beforeEach(() => {
  alice = freshBuyer();
  bob = freshBuyer();
});

function at(when: Date) {
  return createBookingService({ db: db(), clock: { now: () => when }, newId: randomUUID });
}

function plus(when: Date, ms: number): Date {
  return new Date(when.getTime() + ms);
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

/** Alice holds `count` seats at NOW and places the order at `placedAt`. */
async function aliceOrders(count = 1, placedAt = plus(NOW, ONE_MINUTE)) {
  const eventId = await demoEventId();
  const seatIds = await freeSeatIds(eventId, count);
  const hold = await at(NOW).holdSeats(alice, eventId, seatIds);
  const order = await at(placedAt).placeOrder(alice, hold.id, contact, randomUUID());
  return {
    eventId,
    seatIds,
    hold,
    order,
    expiresAt: plus(order.paymentDeadline, SETTLEMENT_GRACE_MS),
  };
}

function seatsOf(seatIds: readonly string[]) {
  return db()
    .seat.findMany({ where: { id: { in: [...seatIds] } }, orderBy: { id: "asc" } })
    .then((seats) => seats.map((s) => [s.status, s.holdId, s.claimBuyerKey]));
}

function orderStatus(id: string) {
  return db()
    .order.findUniqueOrThrow({ where: { id } })
    .then((order) => order.status);
}

function expiredEvents(orderId: string) {
  return db().outboxEvent.findMany({ where: { aggregateId: orderId, eventType: "order.expired" } });
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

/** Holds a row lock on the order in another transaction until `release` is called. */
async function lockOrderElsewhere(orderId: string) {
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
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      locked();
      await gate;
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

describe("sweepExpired and orders", () => {
  test("at paymentDeadline + 60s expires the order, frees its seats and writes order.expired with the contact", async () => {
    const { seatIds, hold, order, expiresAt } = await aliceOrders(2);

    const result = await at(expiresAt).sweepExpired();

    expect(result.expiredOrderIds).toContain(order.id);
    expect(await orderStatus(order.id)).toBe("EXPIRED");
    expect(await seatsOf(seatIds)).toEqual([
      ["AVAILABLE", null, null],
      ["AVAILABLE", null, null],
    ]);
    const events = await expiredEvents(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: "order",
      payload: {
        type: "order.expired",
        version: 1,
        occurredAt: expiresAt.toISOString(),
        correlationId: hold.correlationId,
        causationId: null,
        holdId: hold.id,
        orderId: order.id,
        payload: { orderId: order.id, contact },
      },
    });
  });

  test("leaves the order and its IN_CHECKOUT seats alone one millisecond before paymentDeadline + 60s", async () => {
    const { seatIds, hold, order, expiresAt } = await aliceOrders();

    const result = await at(plus(expiresAt, -1)).sweepExpired();

    expect(result.expiredOrderIds).not.toContain(order.id);
    expect(await orderStatus(order.id)).toBe("PENDING_PAYMENT");
    expect(await seatsOf(seatIds)).toEqual([["IN_CHECKOUT", hold.id, alice.buyerKey]]);
    expect(await expiredEvents(order.id)).toHaveLength(0);
  });

  test("expires an order once: a second sweep finds nothing to do", async () => {
    const { order, expiresAt } = await aliceOrders();
    await at(expiresAt).sweepExpired();

    const again = await at(plus(expiresAt, ONE_MINUTE)).sweepExpired();

    expect(again.expiredOrderIds).not.toContain(order.id);
    expect(await expiredEvents(order.id)).toHaveLength(1);
  });

  test("skips an order locked by another transaction without waiting; its seats stay IN_CHECKOUT", async () => {
    const { seatIds, hold, order, expiresAt } = await aliceOrders();
    const lock = await lockOrderElsewhere(order.id);
    try {
      const outcome = await settleWithin(at(expiresAt).sweepExpired());

      expect(outcome).not.toBe("blocked");
      expect(outcome).not.toMatchObject({ error: expect.anything() });
      expect(outcome).not.toMatchObject({ value: { expiredOrderIds: [order.id] } });
    } finally {
      await lock.release();
    }
    expect(await orderStatus(order.id)).toBe("PENDING_PAYMENT");
    expect(await seatsOf(seatIds)).toEqual([["IN_CHECKOUT", hold.id, alice.buyerKey]]);
  });

  test("never expires an order that already left PENDING_PAYMENT", async () => {
    const { seatIds, hold, order, expiresAt } = await aliceOrders();
    // The saga's confirmation, reduced to the rows the sweeper reads.
    await db().$transaction([
      db().order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } }),
      db().seat.updateMany({ where: { id: { in: seatIds } }, data: { status: "SOLD" } }),
    ]);

    const result = await at(expiresAt).sweepExpired();

    expect(result.expiredOrderIds).not.toContain(order.id);
    expect(await orderStatus(order.id)).toBe("CONFIRMED");
    expect(await seatsOf(seatIds)).toEqual([["SOLD", hold.id, alice.buyerKey]]);
    expect(await expiredEvents(order.id)).toHaveLength(0);
  });
});

describe("AT-10: checkout keeps seats", () => {
  test("IN_CHECKOUT seats outlive the hold expiry and are freed only at paymentDeadline + grace", async () => {
    const eventId = await demoEventId();
    const seatIds = await freeSeatIds(eventId, 1);
    const hold = await at(NOW).holdSeats(alice, eventId, seatIds);
    // Placed one minute before the hold would expire: the payment deadline lies beyond it.
    const order = await at(plus(hold.holdExpiresAt, -ONE_MINUTE)).placeOrder(
      alice,
      hold.id,
      contact,
      randomUUID(),
    );
    const expiresAt = plus(order.paymentDeadline, SETTLEMENT_GRACE_MS);
    const afterHoldExpiry = plus(hold.holdExpiresAt, ONE_MINUTE);
    expect(afterHoldExpiry.getTime()).toBeLessThan(expiresAt.getTime());

    // Lazy expiry does not take them over.
    await expect(at(afterHoldExpiry).holdSeats(bob, eventId, seatIds)).rejects.toBeInstanceOf(
      SeatUnavailableError,
    );
    // Neither does the sweeper, before the grace has passed.
    const early = await at(plus(expiresAt, -1)).sweepExpired();
    expect(early.expiredHoldIds).not.toContain(hold.id);
    expect(early.expiredOrderIds).not.toContain(order.id);
    expect(await seatsOf(seatIds)).toEqual([["IN_CHECKOUT", hold.id, alice.buyerKey]]);

    await at(expiresAt).sweepExpired();

    expect(await seatsOf(seatIds)).toEqual([["AVAILABLE", null, null]]);
    const taken = await at(expiresAt).holdSeats(bob, eventId, seatIds);
    expect(taken).toMatchObject({ status: "HELD", seatIds });
  });
});

describe("AT-04: no double counting", () => {
  test("after the order expires, the buyer's usage drops", async () => {
    const { eventId, expiresAt } = await aliceOrders(4);
    const more = await freeSeatIds(eventId, 3);
    await expect(
      at(plus(NOW, 2 * ONE_MINUTE)).holdSeats(alice, eventId, more),
    ).rejects.toBeInstanceOf(LimitExceededError);

    await at(expiresAt).sweepExpired();

    const hold = await at(expiresAt).holdSeats(alice, eventId, more);
    expect(hold.seatIds).toEqual(more);
  });
});
