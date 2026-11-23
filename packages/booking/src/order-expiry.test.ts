import { randomUUID } from "node:crypto";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeEach, describe, expect, test } from "vitest";
import {
  type Buyer,
  type Contact,
  LimitExceededError,
  SeatUnavailableError,
} from "./booking-service";
import { block, bookingTestBed, freshBuyer, NOW, rowLock, settledUnlessBlocked } from "./testing";

const database = setupTestDatabase();
const { db, at, freeSeats } = bookingTestBed(database);

const ONE_MINUTE = 60_000;
const SETTLEMENT_GRACE_MS = 60_000;
const contact: Contact = { email: "alice@example.com", phone: "+36301234567" };

let alice: Buyer = freshBuyer();
let bob: Buyer = freshBuyer();

beforeEach(() => {
  alice = freshBuyer();
  bob = freshBuyer();
});

function plus(when: Date, ms: number): Date {
  return new Date(when.getTime() + ms);
}

/** Alice holds `count` seats at NOW and places the order at `placedAt`. */
async function aliceOrders(count = 1, placedAt = plus(NOW, ONE_MINUTE)) {
  const { eventId, seatIds } = await freeSeats(count);
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
    const lock = await block(db(), rowLock("orders", [order.id]), { what: "the order lock" });
    try {
      const outcome = await settledUnlessBlocked(db(), lock.pid, at(expiresAt).sweepExpired());

      expect(outcome).not.toBe("blocked");
      expect(outcome).not.toMatchObject({ status: "rejected" });
      expect(outcome).toMatchObject({ status: "fulfilled" });
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
    const { eventId, seatIds } = await freeSeats(1);
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
    const more = (await freeSeats(3, { eventId })).seatIds;
    await expect(
      at(plus(NOW, 2 * ONE_MINUTE)).holdSeats(alice, eventId, more),
    ).rejects.toBeInstanceOf(LimitExceededError);

    await at(expiresAt).sweepExpired();

    const hold = await at(expiresAt).holdSeats(alice, eventId, more);
    expect(hold.seatIds).toEqual(more);
  });
});
