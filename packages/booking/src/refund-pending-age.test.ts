import { randomUUID } from "node:crypto";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { createPaymentSagaHandler } from "./payment-saga";
import { bookingTestBed, freshBuyer, NOW } from "./testing";

// A database of its own: the age is the oldest open obligation across the whole database.
const database = setupTestDatabase();
const { db, at, freeSeats } = bookingTestBed(database);

const minute = 60_000;
const FIRST_REQUEST = new Date("2027-03-01T12:00:00.000Z");
const later = (minutes: number) => new Date(FIRST_REQUEST.getTime() + minutes * minute);

/** An orphan refund obligation recorded by the saga at `when` (a capture for an unknown order). */
async function orphanObligationAt(when: Date): Promise<string> {
  const paymentId = randomUUID();
  const orderId = randomUUID();
  const saga = createPaymentSagaHandler({ clock: { now: () => when }, newId: randomUUID });
  const data = JSON.stringify({
    id: randomUUID(),
    type: "payment.succeeded",
    version: 1,
    occurredAt: when.toISOString(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    orderId,
    payload: {
      paymentId,
      orderId,
      attemptNo: 1,
      amount: 1000,
      currency: "EUR",
      capturedAt: when.toISOString(),
    },
  });
  await db().$transaction((tx) => saga(tx, { data }, { emit: async () => undefined }));
  return paymentId;
}

/** A ledger refund obligation recorded at `when`: an on-time capture reaching an expired order. */
async function ledgerObligationAt(when: Date): Promise<string> {
  const buyer = freshBuyer();
  const { eventId, seatIds } = await freeSeats(1);
  const hold = await at(NOW).holdSeats(buyer, eventId, seatIds);
  const order = await at(NOW).placeOrder(buyer, hold.id, { email: "a@example.com" }, randomUUID());
  await at(new Date(order.paymentDeadline.getTime() + minute)).sweepExpired();
  const paymentId = randomUUID();
  const saga = createPaymentSagaHandler({ clock: { now: () => when }, newId: randomUUID });
  const data = JSON.stringify({
    id: randomUUID(),
    type: "payment.succeeded",
    version: 1,
    occurredAt: when.toISOString(),
    correlationId: hold.correlationId,
    causationId: randomUUID(),
    orderId: order.id,
    payload: {
      paymentId,
      orderId: order.id,
      attemptNo: 1,
      amount: order.totalMinor,
      currency: order.currency,
      capturedAt: order.paymentDeadline.toISOString(),
    },
  });
  await db().$transaction((tx) => saga(tx, { data }, { emit: async () => undefined }));
  return paymentId;
}

describe("refundPendingAgeMax (refund_pending_age_max)", () => {
  test("is 0 while no refund obligation is open", async () => {
    expect(await at(later(0)).refundPendingAgeMax()).toBe(0);
  });

  test("is the age of the oldest open obligation's first request, re-emits and MANUAL_REVIEW included", async () => {
    const oldest = await orphanObligationAt(FIRST_REQUEST);
    await orphanObligationAt(later(5));

    expect(await at(later(7)).refundPendingAgeMax()).toBe(7 * minute);

    // Re-emits and the escalation do not make an obligation younger: the money is still owed.
    for (const minutes of [10, 20, 30, 40]) {
      await at(later(minutes)).reconcileRefunds();
    }
    expect(
      (await db().orphanRefundObligation.findUniqueOrThrow({ where: { paymentId: oldest } }))
        .status,
    ).toBe("MANUAL_REVIEW");
    expect(await at(later(45)).refundPendingAgeMax()).toBe(45 * minute);
  });

  test("leaves REFUNDED obligations out and never reads a negative age", async () => {
    await db().orphanRefundObligation.updateMany({ data: { status: "REFUNDED" } });
    await orphanObligationAt(later(60));

    expect(await at(later(61)).refundPendingAgeMax()).toBe(minute);
    expect(await at(later(59)).refundPendingAgeMax()).toBe(0);
  });

  test("counts the ledger's open obligations as well", async () => {
    await db().orphanRefundObligation.updateMany({ data: { status: "REFUNDED" } });
    const paymentId = await ledgerObligationAt(later(100));

    expect((await db().orderPayment.findUniqueOrThrow({ where: { paymentId } })).disposition).toBe(
      "REFUND_REQUESTED",
    );
    expect(await at(later(103)).refundPendingAgeMax()).toBe(3 * minute);
  });
});
