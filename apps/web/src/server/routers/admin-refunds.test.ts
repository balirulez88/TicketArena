import { randomUUID } from "node:crypto";
import { createPaymentSagaHandler } from "@ticketarena/booking";
import { bookingTestBed, freshBuyer, NOW } from "@ticketarena/booking/testing";
import { envelopeSchema, paymentRefundRequestedPayloadSchema } from "@ticketarena/contracts";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { adminCaller } from "../testing/admin-caller";

// admin.stuckRefunds and admin.retryRefund (spec: Admin dashboard): every open refund obligation
// with its age, and the operator's retry of one in MANUAL_REVIEW (decided for ticket 23).
// A database of its own: the list is every open obligation in the database.
const database = setupTestDatabase();
const { db, at, freeSeats } = bookingTestBed(database);

const minute = 60_000;
const FIRST_REQUEST = new Date("2027-03-01T12:00:00.000Z");
const later = (minutes: number) => new Date(FIRST_REQUEST.getTime() + minutes * minute);
const requestEnvelope = envelopeSchema(paymentRefundRequestedPayloadSchema);

/** `payment.succeeded` handled by the real saga at `when`. */
async function capture(
  when: Date,
  ids: { paymentId: string; orderId: string; correlationId: string },
  amount: number,
  capturedAt: Date,
): Promise<void> {
  const saga = createPaymentSagaHandler({ clock: { now: () => when }, newId: randomUUID });
  const data = JSON.stringify({
    id: randomUUID(),
    type: "payment.succeeded",
    version: 1,
    occurredAt: when.toISOString(),
    correlationId: ids.correlationId,
    causationId: randomUUID(),
    orderId: ids.orderId,
    payload: {
      ...ids,
      attemptNo: 1,
      amount,
      currency: "EUR",
      capturedAt: capturedAt.toISOString(),
    },
  });
  await db().$transaction((tx) => saga(tx, { data }, { emit: async () => undefined }));
}

/** An orphan refund obligation recorded at `when`: a capture for an order booking never had. */
async function orphanObligationAt(when: Date): Promise<string> {
  const paymentId = randomUUID();
  await capture(
    when,
    { paymentId, orderId: randomUUID(), correlationId: randomUUID() },
    1000,
    when,
  );
  return paymentId;
}

/** A ledger refund obligation recorded at `when`: an on-time capture reaching an expired order. */
async function ledgerObligationAt(when: Date): Promise<{ paymentId: string; orderId: string }> {
  const buyer = freshBuyer();
  const { eventId, seatIds } = await freeSeats(1);
  const hold = await at(NOW).holdSeats(buyer, eventId, seatIds);
  const order = await at(NOW).placeOrder(buyer, hold.id, { email: "a@example.com" }, randomUUID());
  await at(new Date(order.paymentDeadline.getTime() + minute)).sweepExpired();
  const paymentId = randomUUID();
  await capture(
    when,
    { paymentId, orderId: order.id, correlationId: hold.correlationId },
    order.totalMinor,
    order.paymentDeadline,
  );
  return { paymentId, orderId: order.id };
}

/** Reconciler passes until the obligations still open from FIRST_REQUEST are in MANUAL_REVIEW. */
async function escalate(): Promise<void> {
  for (const minutes of [10, 20, 30, 40]) {
    await at(later(minutes)).reconcileRefunds();
  }
}

const admin = (when: Date) => adminCaller(db, when);

describe("admin.stuckRefunds and admin.retryRefund", () => {
  test("lists REFUND_REQUESTED and MANUAL_REVIEW obligations, oldest first, with their age; a retry re-emits one", async () => {
    // Nothing is open yet.
    expect(await admin(FIRST_REQUEST).admin.stuckRefunds()).toEqual([]);

    const stuck = await orphanObligationAt(FIRST_REQUEST);
    await escalate();
    const ledger = await ledgerObligationAt(later(41));
    const refunded = await orphanObligationAt(later(42));
    await db().orphanRefundObligation.update({
      where: { paymentId: refunded },
      data: { status: "REFUNDED" },
    });

    const list = await admin(later(50)).admin.stuckRefunds();

    expect(list).toEqual([
      expect.objectContaining({
        paymentId: stuck,
        status: "MANUAL_REVIEW",
        orphan: true,
        refundAttempts: 3,
        refundRequestedAt: FIRST_REQUEST,
        ageMs: 50 * minute,
      }),
      expect.objectContaining({
        paymentId: ledger.paymentId,
        orderId: ledger.orderId,
        status: "REFUND_REQUESTED",
        orphan: false,
        refundAttempts: 0,
        refundRequestedAt: later(41),
        refundLastRequestedAt: later(41),
        ageMs: 9 * minute,
      }),
    ]);
    expect(await admin(later(50)).admin.stuckRefunds({ limit: 1 })).toHaveLength(1);

    const retried = await admin(later(55)).admin.retryRefund({ paymentId: stuck });

    expect(retried).toMatchObject({
      paymentId: stuck,
      status: "REFUND_REQUESTED",
      refundAttempts: 0,
      refundRequestedAt: FIRST_REQUEST,
      refundLastRequestedAt: later(55),
    });
    const requests = await db().outboxEvent.findMany({
      where: { eventType: "payment.refund_requested", aggregateId: stuck },
      orderBy: { createdAt: "asc" },
    });
    expect(requestEnvelope.parse(requests.at(-1)?.payload).occurredAt).toBe(
      later(55).toISOString(),
    );
    expect((await admin(later(56)).admin.stuckRefunds())[0]).toMatchObject({
      paymentId: stuck,
      status: "REFUND_REQUESTED",
      ageMs: 56 * minute,
    });
  });

  test("a retry of an obligation not in MANUAL_REVIEW is PRECONDITION_FAILED naming the payment", async () => {
    const paymentId = await orphanObligationAt(later(100));

    await expect(admin(later(101)).admin.retryRefund({ paymentId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining(paymentId),
      cause: expect.objectContaining({ code: "REFUND_NOT_IN_MANUAL_REVIEW" }),
    });
  });

  test("a retry for a payment without a refund obligation is NOT_FOUND naming the payment", async () => {
    const paymentId = randomUUID();

    await expect(admin(later(101)).admin.retryRefund({ paymentId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining(paymentId),
    });
  });

  test("rejects a malformed payment id and an out-of-range limit", async () => {
    await expect(
      admin(later(0)).admin.retryRefund({ paymentId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("paymentId") });
    await expect(admin(later(0)).admin.stuckRefunds({ limit: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("limit"),
    });
  });

  test("both are UNAUTHORIZED without the admin cookie", async () => {
    const guest = adminCaller(db, NOW, { isAdmin: false });

    await expect(guest.admin.stuckRefunds()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(guest.admin.retryRefund({ paymentId: randomUUID() })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
