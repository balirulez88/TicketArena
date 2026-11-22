import { randomUUID } from "node:crypto";
import type { CausedEventInput } from "@ticketarena/contracts";
import {
  createPrismaClient,
  type PrismaClient,
  seedCatalog,
  type TransactionClient,
} from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService } from "./booking-service";
import { createPaymentSagaHandler, type SagaMetric } from "./payment-saga";

// AT-18, AT-19 and AT-22 (spec: Saga and money). Delivery time is the one clock shared by the
// sweeper and the saga, so "delivered at X" means both run at X; the capture time is the
// provider's, carried in the event. The mismatch of AT-22 is a hand-built `payment.succeeded`:
// the mock provider always charges the order's own total.

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const PLACED_AT = new Date("2027-03-01T12:00:00.000Z");
const SETTLEMENT_GRACE_MS = 60_000;

beforeAll(async () => {
  await seedCatalog(db(), PLACED_AT);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

function buyer(char: string): Buyer {
  return { sessionId: char.repeat(32), buyerKey: char.repeat(32) };
}

async function pendingOrder(who: Buyer) {
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  const seat = await db().seat.findFirstOrThrow({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "asc" },
  });
  const booking = createBookingService({
    db: db(),
    clock: { now: () => PLACED_AT },
    newId: randomUUID,
  });
  const hold = await booking.holdSeats(who, event.id, [seat.id]);
  const order = await booking.placeOrder(
    who,
    hold.id,
    { email: "grace@example.com" },
    randomUUID(),
  );
  return { order, seatId: seat.id, eventId: event.id };
}

function paymentSucceeded(
  order: { id: string; totalMinor: number; currency: string },
  payload: { capturedAt: Date; amount?: number; currency?: string },
) {
  const paymentId = randomUUID();
  return {
    paymentId,
    message: {
      data: JSON.stringify({
        id: randomUUID(),
        type: "payment.succeeded",
        version: 1,
        occurredAt: payload.capturedAt.toISOString(),
        correlationId: randomUUID(),
        causationId: randomUUID(),
        orderId: order.id,
        payload: {
          paymentId,
          orderId: order.id,
          attemptNo: 1,
          amount: payload.amount ?? order.totalMinor,
          currency: payload.currency ?? order.currency,
          capturedAt: payload.capturedAt.toISOString(),
        },
      }),
    },
  };
}

/** Writes each event to the transaction's outbox, as the consumer runner's `emit` does. */
function outboxEmit(tx: TransactionClient) {
  return async (event: CausedEventInput) => {
    const { aggregateType, aggregateId, ...envelope } = event;
    await tx.outboxEvent.create({
      data: {
        id: event.id,
        aggregateType,
        aggregateId,
        eventType: event.type,
        payload: JSON.parse(JSON.stringify(envelope)),
      },
    });
  };
}

/**
 * Delivers `message` at `deliveredAt`: the sweeper runs first at that time (as it would have by
 * then), then the saga handles the payment with the same clock.
 */
async function deliverAt(deliveredAt: Date, message: { data: string }) {
  const counted: { metric: SagaMetric; eventId: string }[] = [];
  const clock = { now: () => deliveredAt };
  await createBookingService({ db: db(), clock, newId: randomUUID }).sweepExpired();
  const saga = createPaymentSagaHandler({
    clock,
    newId: randomUUID,
    metrics: {
      increment: async (metric, eventId) => {
        counted.push({ metric, eventId });
      },
    },
  });
  const outcome = await db().$transaction((tx) => saga(tx, message, { emit: outboxEmit(tx) }));
  return { outcome, counted };
}

function outboxFor(orderId: string) {
  return db().outboxEvent.findMany({
    where: { payload: { path: ["orderId"], equals: orderId } },
    orderBy: { createdAt: "asc" },
  });
}

describe("settlement grace: an on-time capture delivered late", () => {
  test("AT-18: delivered after the grace → order EXPIRED, refund requested (late_delivery), late_delivery_refund incremented", async () => {
    const { order, seatId, eventId } = await pendingOrder(buyer("a"));
    const { paymentId, message } = paymentSucceeded(order, { capturedAt: order.paymentDeadline });
    const deliveredAt = new Date(order.paymentDeadline.getTime() + SETTLEMENT_GRACE_MS + 1_000);

    const { outcome, counted } = await deliverAt(deliveredAt, message);

    expect(outcome).toBeUndefined();
    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "EXPIRED",
    );
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("AVAILABLE");
    expect(await db().orderPayment.findMany({ where: { orderId: order.id } })).toMatchObject([
      {
        paymentId,
        disposition: "REFUND_REQUESTED",
        capturedAt: order.paymentDeadline,
        refundRequestedAt: deliveredAt,
      },
    ]);
    const refunds = (await outboxFor(order.id)).filter(
      (row) => row.eventType === "payment.refund_requested",
    );
    expect(refunds).toMatchObject([
      { aggregateId: paymentId, payload: { payload: { paymentId, reason: "late_delivery" } } },
    ]);
    expect(counted).toEqual([{ metric: "late_delivery_refund", eventId }]);
  });

  test("AT-19: delivered within the grace → CONFIRMED, ledger APPLIED, seat SOLD", async () => {
    const { order, seatId } = await pendingOrder(buyer("b"));
    const { paymentId, message } = paymentSucceeded(order, { capturedAt: order.paymentDeadline });
    const deliveredAt = new Date(order.paymentDeadline.getTime() + SETTLEMENT_GRACE_MS - 1_000);

    const { outcome, counted } = await deliverAt(deliveredAt, message);

    expect(outcome).toBeUndefined();
    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "CONFIRMED",
    );
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("SOLD");
    expect(await db().orderPayment.findMany({ where: { orderId: order.id } })).toMatchObject([
      { paymentId, disposition: "APPLIED" },
    ]);
    expect((await outboxFor(order.id)).map((row) => row.eventType)).toEqual([
      "order.placed",
      "order.confirmed",
    ]);
    expect(counted).toEqual([]);
  });
});

describe("amount or currency mismatch", () => {
  test.each([
    ["amount", "c", (total: number) => ({ amount: total - 1 })],
    ["currency", "d", () => ({ currency: "HUF" })],
  ] as const)(
    "AT-22: a %s mismatch → refund requested (amount_mismatch), never confirmation",
    async (_field, char, mismatch) => {
      const { order, seatId } = await pendingOrder(buyer(char));
      const { paymentId, message } = paymentSucceeded(order, {
        capturedAt: PLACED_AT,
        ...mismatch(order.totalMinor),
      });

      const { outcome } = await deliverAt(PLACED_AT, message);

      expect(outcome).toBeUndefined();
      expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "PENDING_PAYMENT",
      );
      expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
        "IN_CHECKOUT",
      );
      expect(await db().orderPayment.findMany({ where: { orderId: order.id } })).toMatchObject([
        { paymentId, disposition: "REFUND_REQUESTED" },
      ]);
      const outbox = await outboxFor(order.id);
      expect(outbox.map((row) => row.eventType)).toEqual([
        "order.placed",
        "payment.refund_requested",
      ]);
      expect(outbox[1]).toMatchObject({
        payload: { payload: { paymentId, reason: "amount_mismatch" } },
      });
    },
  );
});
