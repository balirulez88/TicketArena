import { randomUUID } from "node:crypto";
import {
  createBookingService,
  createPaymentSagaHandler,
  type SagaMetrics,
} from "@ticketarena/booking";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { seedCatalog } from "@ticketarena/db/seed";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceConsumers } from "./consumers.js";
import { createMockNotificationProvider } from "./notification/index.js";
import { startWorker } from "./worker.js";

const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus;
let sequence = 0;

const NOW = new Date();
/** The sweeper expires an unpaid order at its payment deadline plus this settlement grace. */
const SETTLEMENT_GRACE_MS = 60_000;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  await seedCatalog(prisma, NOW);
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

function bookingAt(now: () => Date) {
  return createBookingService({ db: prisma, clock: { now }, newId: randomUUID });
}

/** A fresh buyer's `PENDING_PAYMENT` order for one free seat of the demo event. */
async function pendingOrder(email = "buyer@example.com") {
  sequence += 1;
  const key = randomUUID().replaceAll("-", "");
  const buyer = { sessionId: key, buyerKey: key };
  const event = await prisma.event.findFirstOrThrow({ where: { demo: true } });
  const seat = await prisma.seat.findFirstOrThrow({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "asc" },
  });
  const booking = bookingAt(() => new Date());
  const hold = await booking.holdSeats(buyer, event.id, [seat.id]);
  const order = await booking.placeOrder(buyer, hold.id, { email }, randomUUID());
  return { order, seatId: seat.id, eventId: event.id };
}

/** Lets the sweeper run once the order's deadline plus grace has passed: the order is EXPIRED. */
async function sweepAfterGrace(order: { paymentDeadline: Date }) {
  const sweepAt = new Date(order.paymentDeadline.getTime() + SETTLEMENT_GRACE_MS + 1_000);
  await bookingAt(() => sweepAt).sweepExpired();
}

function paymentSucceeded(
  order: { id: string; totalMinor: number; currency: string },
  overrides: { capturedAt: Date; amount?: number; currency?: string },
) {
  const paymentId = randomUUID();
  const envelope = {
    id: randomUUID(),
    type: "payment.succeeded",
    version: 1,
    occurredAt: overrides.capturedAt.toISOString(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    orderId: order.id,
    payload: {
      paymentId,
      orderId: order.id,
      attemptNo: 1,
      amount: overrides.amount ?? order.totalMinor,
      currency: overrides.currency ?? order.currency,
      capturedAt: overrides.capturedAt.toISOString(),
    },
  };
  return { paymentId, envelope };
}

function recordingMetrics() {
  const counted: { metric: string; eventId: string }[] = [];
  const metrics: SagaMetrics = {
    increment: async (metric, eventId) => {
      counted.push({ metric, eventId });
    },
  };
  return { counted, metrics };
}

/**
 * The booking saga behind a real consumer runner on a subject of its own, with `deliveredAt` as
 * the saga's clock: delivery time is what the sweeper and the grace period are about, capture
 * time (in the event) is what decides "on time". `dropFirstAcks` simulates a crash between commit
 * and ack: the broker redelivers the same message (same event id).
 */
async function sagaRunner(deliveredAt: () => Date, options: { dropFirstAcks?: number } = {}) {
  sequence += 1;
  const subject = `ta.payment.late-delivery-case${sequence}`;
  const consumer = `booking-saga-late-delivery-case${sequence}`;
  const { counted, metrics } = recordingMetrics();
  let acksToDrop = options.dropFirstAcks ?? 0;
  const crashingBus: MessageBus = {
    ensureTopology: () => bus.ensureTopology(),
    publish: (input) => bus.publish(input),
    close: () => bus.close(),
    subscribe: async (spec) => {
      const subscription = await bus.subscribe(spec);
      return {
        fetch: async (fetchOptions) =>
          (await subscription.fetch(fetchOptions)).map((message) => ({
            ...message,
            ack: () => {
              if (acksToDrop > 0) {
                acksToDrop -= 1;
                return;
              }
              message.ack();
            },
          })),
      };
    },
  };
  const runner = await createConsumerRunner({
    bus: crashingBus,
    prisma,
    service: "booking",
    consumer,
    filterSubject: subject,
    ackWaitMs: 500,
    handler: createPaymentSagaHandler({
      clock: { now: deliveredAt },
      newId: randomUUID,
      metrics,
    }),
  });
  const deliver = async (envelope: { id: string }) => {
    await bus.publish({ subject, data: JSON.stringify(envelope), msgId: envelope.id });
    await runner.pollOnce();
  };
  return { runner, deliver, counted, consumer };
}

function statusOf(orderId: string) {
  return prisma.order.findUniqueOrThrow({ where: { id: orderId } }).then((order) => order.status);
}

function ledgerOf(orderId: string) {
  return prisma.orderPayment.findMany({
    where: { orderId },
    select: { paymentId: true, disposition: true, refundReason: true },
  });
}

function bookingEventsOf(orderId: string, eventType: string) {
  return prisma.outboxEvent.findMany({
    where: { eventType, payload: { path: ["orderId"], equals: orderId } },
  });
}

describe("on time is capture time, not delivery time", () => {
  it.each([
    ["before", -1_000],
    ["exactly at", 0],
  ])(
    "AT-19: a capture %s the deadline delivered within grace confirms the order",
    async (_when, offsetMs) => {
      const { order, seatId } = await pendingOrder();
      const deliveredAt = new Date(order.paymentDeadline.getTime() + SETTLEMENT_GRACE_MS / 2);
      const saga = await sagaRunner(() => deliveredAt);
      const payment = paymentSucceeded(order, {
        capturedAt: new Date(order.paymentDeadline.getTime() + offsetMs),
      });

      await saga.deliver(payment.envelope);

      expect(await statusOf(order.id)).toBe("CONFIRMED");
      expect(await ledgerOf(order.id)).toEqual([
        { paymentId: payment.paymentId, disposition: "APPLIED", refundReason: null },
      ]);
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("SOLD");
      expect(await bookingEventsOf(order.id, "payment.refund_requested")).toEqual([]);
      expect(saga.counted).toEqual([]);
    },
  );

  it("AT-18: an on-time capture delivered after grace leaves the order EXPIRED, refunds it once and counts late_delivery_refund once", async () => {
    const { order, seatId, eventId } = await pendingOrder();
    await sweepAfterGrace(order);
    const deliveredAt = new Date(order.paymentDeadline.getTime() + 2 * SETTLEMENT_GRACE_MS);
    const saga = await sagaRunner(() => deliveredAt);
    const payment = paymentSucceeded(order, {
      capturedAt: new Date(order.paymentDeadline.getTime() - 1_000),
    });

    await saga.deliver(payment.envelope);

    expect(await statusOf(order.id)).toBe("EXPIRED");
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
      "AVAILABLE",
    );
    expect(await ledgerOf(order.id)).toEqual([
      {
        paymentId: payment.paymentId,
        disposition: "REFUND_REQUESTED",
        refundReason: "late_delivery",
      },
    ]);
    expect(await bookingEventsOf(order.id, "payment.refund_requested")).toMatchObject([
      {
        aggregateId: payment.paymentId,
        payload: { payload: { paymentId: payment.paymentId, reason: "late_delivery" } },
      },
    ]);
    expect(await bookingEventsOf(order.id, "order.confirmed")).toEqual([]);
    expect(saga.counted).toEqual([{ metric: "late_delivery_refund", eventId }]);
  });
});

describe("two distinct payments for one order", () => {
  it.each([
    ["first", 0],
    ["second", 1],
  ] as const)(
    "AT-21: applies whichever is delivered first (the %s captured) and refunds the other once",
    async (_label, firstIndex) => {
      const { order } = await pendingOrder();
      const capturedAt = new Date(order.paymentDeadline.getTime() - 60_000);
      const saga = await sagaRunner(() => capturedAt);
      const payments = [
        paymentSucceeded(order, { capturedAt }),
        paymentSucceeded(order, { capturedAt }),
      ];
      const applied = payments[firstIndex];
      const refunded = payments[1 - firstIndex];
      if (applied === undefined || refunded === undefined) {
        throw new Error("two payments expected");
      }

      await saga.deliver(applied.envelope);
      await saga.deliver(refunded.envelope);

      expect(await statusOf(order.id)).toBe("CONFIRMED");
      const ledger = await ledgerOf(order.id);
      expect(ledger.filter((entry) => entry.disposition === "APPLIED")).toEqual([
        { paymentId: applied.paymentId, disposition: "APPLIED", refundReason: null },
      ]);
      expect(ledger.filter((entry) => entry.disposition !== "APPLIED")).toEqual([
        {
          paymentId: refunded.paymentId,
          disposition: "REFUND_REQUESTED",
          refundReason: "order_confirmed",
        },
      ]);
      expect(
        (await bookingEventsOf(order.id, "payment.refund_requested")).map((row) => row.aggregateId),
      ).toEqual([refunded.paymentId]);
      expect(await bookingEventsOf(order.id, "order.confirmed")).toHaveLength(1);
    },
  );

  it("AT-21: applies exactly one of two payments delivered concurrently and refunds the other once", async () => {
    const { order } = await pendingOrder();
    const capturedAt = new Date(order.paymentDeadline.getTime() - 60_000);
    const payments = [
      paymentSucceeded(order, { capturedAt }),
      paymentSucceeded(order, { capturedAt }),
    ];
    const sagas = await Promise.all(payments.map(() => sagaRunner(() => capturedAt)));

    await Promise.all(payments.map((payment, index) => sagas[index]?.deliver(payment.envelope)));

    expect(await statusOf(order.id)).toBe("CONFIRMED");
    const ledger = await ledgerOf(order.id);
    expect(ledger.map((entry) => entry.disposition).sort()).toEqual([
      "APPLIED",
      "REFUND_REQUESTED",
    ]);
    const refunded = ledger.find((entry) => entry.disposition === "REFUND_REQUESTED");
    expect(
      (await bookingEventsOf(order.id, "payment.refund_requested")).map((row) => row.aggregateId),
    ).toEqual([refunded?.paymentId]);
    expect(await bookingEventsOf(order.id, "order.confirmed")).toHaveLength(1);
  });
});

describe("amount or currency mismatch", () => {
  it.each([
    ["amount", { amount: 1 }],
    ["currency", { currency: "USD" }],
  ] as const)(
    "AT-22: a capture with the wrong %s is refunded and never confirms the order",
    async (_field, mismatch) => {
      const { order, seatId } = await pendingOrder();
      const capturedAt = new Date(order.paymentDeadline.getTime() - 60_000);
      const saga = await sagaRunner(() => capturedAt);
      const payment = paymentSucceeded(order, { capturedAt, ...mismatch });

      await saga.deliver(payment.envelope);

      expect(await statusOf(order.id)).toBe("PENDING_PAYMENT");
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
        "IN_CHECKOUT",
      );
      expect(await ledgerOf(order.id)).toEqual([
        {
          paymentId: payment.paymentId,
          disposition: "REFUND_REQUESTED",
          refundReason: "amount_mismatch",
        },
      ]);
      expect(await bookingEventsOf(order.id, "payment.refund_requested")).toHaveLength(1);
      expect(await bookingEventsOf(order.id, "order.confirmed")).toEqual([]);
    },
  );
});

describe("duplicate delivery of the same payment event", () => {
  it("confirms once on a broker redelivery (same event id): no refund, no counter, no second outbox event", async () => {
    const { order } = await pendingOrder();
    const capturedAt = new Date(order.paymentDeadline.getTime() - 60_000);
    const saga = await sagaRunner(() => capturedAt, { dropFirstAcks: 1 });
    const payment = paymentSucceeded(order, { capturedAt });

    await saga.deliver(payment.envelope);
    // The first ack was lost, so the broker redelivers the same message after ackWait.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await saga.runner.pollOnce();

    expect(
      await prisma.processedMessage.findMany({
        where: { consumer: saga.consumer },
        select: { messageId: true },
      }),
    ).toEqual([{ messageId: payment.envelope.id }]);
    expect(await statusOf(order.id)).toBe("CONFIRMED");
    expect(await ledgerOf(order.id)).toEqual([
      { paymentId: payment.paymentId, disposition: "APPLIED", refundReason: null },
    ]);
    expect(await bookingEventsOf(order.id, "payment.refund_requested")).toEqual([]);
    expect(
      await prisma.outboxEvent.count({
        where: { payload: { path: ["causationId"], equals: payment.envelope.id } },
      }),
    ).toBe(1);
    expect(saga.counted).toEqual([]);
  });

  it("counts late_delivery_refund once and requests one refund when a late delivery is redelivered", async () => {
    const { order, eventId } = await pendingOrder();
    await sweepAfterGrace(order);
    const deliveredAt = new Date(order.paymentDeadline.getTime() + 2 * SETTLEMENT_GRACE_MS);
    const saga = await sagaRunner(() => deliveredAt, { dropFirstAcks: 1 });
    const payment = paymentSucceeded(order, {
      capturedAt: new Date(order.paymentDeadline.getTime() - 1_000),
    });

    await saga.deliver(payment.envelope);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await saga.runner.pollOnce();

    expect(await prisma.processedMessage.count({ where: { consumer: saga.consumer } })).toBe(1);
    expect(await bookingEventsOf(order.id, "payment.refund_requested")).toHaveLength(1);
    expect(saga.counted).toEqual([{ metric: "late_delivery_refund", eventId }]);
  });
});

describe("hold -> order -> worker -> +double@", () => {
  it("AT-21: confirms with one APPLIED payment and refunds the second charge exactly once", async () => {
    const { order, seatId } = await pendingOrder("buyer+double@example.com");
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      relay: { intervalMs: 20 },
      consumers: createServiceConsumers({
        prisma,
        clock: { now: () => new Date(), sleep: async () => undefined },
        random: { next: () => 0 },
        newId: randomUUID,
        notificationProvider: createMockNotificationProvider(),
      }),
    });
    try {
      await expect
        .poll(async () => (await ledgerOf(order.id)).map((entry) => entry.disposition).sort(), {
          timeout: 15_000,
        })
        .toEqual(["APPLIED", "REFUNDED"]);

      expect(await statusOf(order.id)).toBe("CONFIRMED");
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("SOLD");
      const attempts = await prisma.paymentAttempt.findMany({ where: { orderId: order.id } });
      const ledger = await ledgerOf(order.id);
      expect(new Set(ledger.map((entry) => entry.paymentId))).toEqual(
        new Set(attempts.map((attempt) => attempt.paymentId)),
      );
      const refunded = ledger.find((entry) => entry.disposition === "REFUNDED");
      expect(refunded?.refundReason).toBe("order_confirmed");
      expect(await prisma.paymentRefund.findMany({ where: { orderId: order.id } })).toMatchObject([
        { paymentId: refunded?.paymentId },
      ]);
      expect(
        (await bookingEventsOf(order.id, "payment.refund_requested")).map((row) => row.aggregateId),
      ).toEqual([refunded?.paymentId]);
      expect(await bookingEventsOf(order.id, "order.confirmed")).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });
});
