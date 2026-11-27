import { randomUUID } from "node:crypto";
import { envelopeSchema, paymentRefundRequestedPayloadSchema } from "@ticketarena/contracts";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { bookingTestBed, freshBuyer, NOW } from "./testing";

// The refund migrations run before the new worker replaces the old one, and an emergency rollback
// runs the old worker on the migrated schema again (docs/operations/deployment.md). Meanwhile the
// old worker writes refund obligations in its own shape: a ledger row without `refundReason` and
// `refundLastRequestedAt`, and an `unknown_order` refund as an outbox row only. Each reconciler
// pass first catches those up; these tests write the old worker's rows as it writes them.
const database = setupTestDatabase();
const { db, at, freeSeats } = bookingTestBed(database);

const REQUESTED_AT = new Date("2027-03-01T12:10:00.000Z");
const afterMinutes = (minutes: number) => new Date(REQUESTED_AT.getTime() + minutes * 60_000);
const requestEnvelope = envelopeSchema(paymentRefundRequestedPayloadSchema);

/** An expired order, as the sweeper leaves it, for a ledger row to belong to. */
async function expiredOrder() {
  const buyer = freshBuyer();
  const { eventId, seatIds } = await freeSeats(1);
  const hold = await at(NOW).holdSeats(buyer, eventId, seatIds);
  const order = await at(NOW).placeOrder(
    buyer,
    hold.id,
    { email: "alice@example.com" },
    randomUUID(),
  );
  await at(new Date(order.paymentDeadline.getTime() + 61_000)).sweepExpired();
  return { order, hold };
}

/** The old worker's `payment.refund_requested` outbox row, as its saga wrote it. */
async function oldRequest(input: {
  paymentId: string;
  orderId: string;
  reason: string;
  correlationId: string;
  occurredAt: Date;
  holdId?: string;
}): Promise<void> {
  await db().outboxEvent.create({
    data: {
      id: randomUUID(),
      aggregateType: "order_payment",
      aggregateId: input.paymentId,
      eventType: "payment.refund_requested",
      createdAt: input.occurredAt,
      payload: {
        id: randomUUID(),
        type: "payment.refund_requested",
        version: 1,
        occurredAt: input.occurredAt.toISOString(),
        correlationId: input.correlationId,
        causationId: randomUUID(),
        orderId: input.orderId,
        ...(input.holdId === undefined ? {} : { holdId: input.holdId }),
        payload: {
          paymentId: input.paymentId,
          orderId: input.orderId,
          amount: 4200,
          currency: "EUR",
          reason: input.reason,
          // Only an unknown_order request has no buyer to tell.
          ...(input.reason === "unknown_order" ? {} : { contact: { email: "alice@example.com" } }),
        },
      },
    },
  });
}

/** The old worker's ledger refund obligation: no `refundReason`, no `refundLastRequestedAt`. */
async function oldLedgerRow(paymentId: string, orderId: string): Promise<void> {
  await db().$executeRaw`
    INSERT INTO order_payments ("paymentId", "orderId", amount, currency, "capturedAt", disposition,
      "refundRequestedAt")
    VALUES (${paymentId}::uuid, ${orderId}::uuid, 4200, 'EUR', ${NOW}, 'REFUND_REQUESTED',
      ${REQUESTED_AT})`;
}

async function requestsFor(paymentId: string) {
  const rows = await db().outboxEvent.findMany({
    where: { eventType: "payment.refund_requested", aggregateId: paymentId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => requestEnvelope.parse(row.payload));
}

describe("reconcileRefunds catches up refund obligations the old worker wrote", () => {
  test("a ledger row without a reason or a last request gets its request's reason and is re-emitted once stale", async () => {
    const { order, hold } = await expiredOrder();
    const paymentId = randomUUID();
    await oldLedgerRow(paymentId, order.id);
    await oldRequest({
      paymentId,
      orderId: order.id,
      reason: "late_delivery",
      correlationId: hold.correlationId,
      occurredAt: REQUESTED_AT,
      holdId: hold.id,
    });

    await at(afterMinutes(1)).reconcileRefunds();

    expect(await db().orderPayment.findUniqueOrThrow({ where: { paymentId } })).toMatchObject({
      disposition: "REFUND_REQUESTED",
      refundReason: "late_delivery",
      refundRequestedAt: REQUESTED_AT,
      refundLastRequestedAt: REQUESTED_AT,
      refundAttempts: 0,
    });

    const result = await at(afterMinutes(10)).reconcileRefunds();

    expect(result.reEmitted).toContain(paymentId);
    const [, again] = await requestsFor(paymentId);
    expect(again?.payload).toMatchObject({ paymentId, reason: "late_delivery" });
  });

  test("a ledger row whose request is gone takes the reason its order's status implies", async () => {
    const { order } = await expiredOrder();
    const paymentId = randomUUID();
    await oldLedgerRow(paymentId, order.id);

    await at(afterMinutes(1)).reconcileRefunds();

    expect(await db().orderPayment.findUniqueOrThrow({ where: { paymentId } })).toMatchObject({
      refundReason: "order_expired",
      refundLastRequestedAt: REQUESTED_AT,
    });
  });

  test("an unknown_order request with no obligation gets one from its earliest request, once", async () => {
    const paymentId = randomUUID();
    const orderId = randomUUID();
    const correlationId = randomUUID();
    for (const minutes of [0, 3]) {
      await oldRequest({
        paymentId,
        orderId,
        reason: "unknown_order",
        correlationId,
        occurredAt: afterMinutes(minutes),
      });
    }

    await at(afterMinutes(5)).reconcileRefunds();
    await at(afterMinutes(6)).reconcileRefunds();

    expect(await db().orphanRefundObligation.findMany({ where: { paymentId } })).toEqual([
      {
        paymentId,
        orderId,
        amount: 4200,
        currency: "EUR",
        // The request carries no capture time: its first request is the historical proxy.
        capturedAt: REQUESTED_AT,
        status: "REFUND_REQUESTED",
        refundRequestedAt: REQUESTED_AT,
        correlationId,
        refundAttempts: 0,
        refundLastRequestedAt: REQUESTED_AT,
      },
    ]);
    expect(await requestsFor(paymentId)).toHaveLength(2);

    const result = await at(afterMinutes(10)).reconcileRefunds();
    expect(result.reEmitted).toContain(paymentId);
  });

  test("leaves an obligation that already exists as it is, even a closed one", async () => {
    const paymentId = randomUUID();
    const orderId = randomUUID();
    const correlationId = randomUUID();
    await db().orphanRefundObligation.create({
      data: {
        paymentId,
        orderId,
        amount: 4200,
        currency: "EUR",
        capturedAt: NOW,
        status: "REFUNDED",
        refundRequestedAt: NOW,
        correlationId,
        refundLastRequestedAt: NOW,
      },
    });
    await oldRequest({
      paymentId,
      orderId,
      reason: "unknown_order",
      correlationId,
      occurredAt: REQUESTED_AT,
    });
    const before = await db().orphanRefundObligation.findUniqueOrThrow({ where: { paymentId } });

    await at(afterMinutes(30)).reconcileRefunds();

    expect(await db().orphanRefundObligation.findUniqueOrThrow({ where: { paymentId } })).toEqual(
      before,
    );
    expect(await requestsFor(paymentId)).toHaveLength(1);
  });
});
