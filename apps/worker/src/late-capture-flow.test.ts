import { randomUUID } from "node:crypto";
import { createBookingService, createPaymentSagaHandler } from "@ticketarena/booking";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
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

const NOW = new Date();

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

function refundRequestsFor(paymentId: string) {
  return prisma.outboxEvent.findMany({
    where: { eventType: "payment.refund_requested", aggregateId: paymentId },
  });
}

describe("hold -> order -> worker -> late payment.succeeded", () => {
  it("AT-20: refunds a capture after the deadline and never reclaims the seat, though it is still free", async () => {
    const buyer = { sessionId: "a".repeat(32), buyerKey: "a".repeat(32) };
    const event = await prisma.event.findFirstOrThrow({ where: { demo: true } });
    const seat = await prisma.seat.findFirstOrThrow({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "asc" },
    });
    const booking = createBookingService({
      db: prisma,
      clock: { now: () => new Date() },
      newId: randomUUID,
    });
    const hold = await booking.holdSeats(buyer, event.id, [seat.id]);
    const order = await booking.placeOrder(
      buyer,
      hold.id,
      { email: "buyer+late@example.com" },
      randomUUID(),
    );
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
        .poll(
          async () => (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
          {
            timeout: 15_000,
          },
        )
        .toBe("EXPIRED");

      // Long before the sweeper's deadline plus grace: the saga expired it on the late capture.
      expect(await prisma.seat.findUniqueOrThrow({ where: { id: seat.id } })).toMatchObject({
        status: "AVAILABLE",
        holdId: null,
      });
      const ledger = await prisma.orderPayment.findMany({ where: { orderId: order.id } });
      // The worker also executes the refund (refund-flow.test.ts), so the obligation may be done.
      expect(ledger).toHaveLength(1);
      expect(["REFUND_REQUESTED", "REFUNDED"]).toContain(ledger[0]?.disposition);
      expect(ledger[0]?.capturedAt.getTime()).toBeGreaterThan(order.paymentDeadline.getTime());
      expect(await refundRequestsFor(ledger[0]?.paymentId ?? "")).toMatchObject([
        {
          payload: {
            orderId: order.id,
            payload: { reason: "late_capture", contact: { email: "buyer+late@example.com" } },
          },
        },
      ]);
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: "order.expired", aggregateId: order.id },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: "order.confirmed", aggregateId: order.id },
        }),
      ).toBe(0);
    } finally {
      await worker.stop();
    }
  });
});

describe("booking saga: payment.succeeded for an order that no longer exists", () => {
  it("refunds the payment once, in the transaction of the first dedupe record, across a redelivery and a duplicate", async () => {
    const orderId = randomUUID();
    const paymentId = randomUUID();
    const envelope = (id: string) => ({
      id,
      type: "payment.succeeded",
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
      orderId,
      payload: {
        paymentId,
        orderId,
        attemptNo: 1,
        amount: 4_200,
        currency: "EUR",
        capturedAt: new Date().toISOString(),
      },
    });
    const first = envelope(randomUUID());
    const duplicate = envelope(randomUUID());
    let acksToDrop = 1;
    // A crash between commit and ack, simulated at the broker boundary: the first ack never
    // arrives, so the broker redelivers the first message.
    const crashingBus: MessageBus = {
      ...bus,
      ensureTopology: () => bus.ensureTopology(),
      publish: (input) => bus.publish(input),
      close: () => bus.close(),
      subscribe: async (spec) => {
        const subscription = await bus.subscribe(spec);
        return {
          fetch: async (options) =>
            (await subscription.fetch(options)).map((message) => ({
              ...message,
              ack: () => {
                if (acksToDrop > 0) {
                  acksToDrop -= 1;
                  return;
                }
                message.ack();
              },
              nak: (delayMs) => message.nak(delayMs),
            })),
        };
      },
    };
    const subject = "ta.payment.unknown-order-case";
    const runner = await createConsumerRunner({
      bus: crashingBus,
      prisma,
      service: "booking",
      consumer: "booking-saga-unknown-order-case",
      filterSubject: subject,
      ackWaitMs: 500,
      handler: createPaymentSagaHandler({ clock: { now: () => new Date() }, newId: randomUUID }),
    });

    await bus.publish({ subject, data: JSON.stringify(first), msgId: first.id });
    await runner.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await runner.pollOnce();
    await bus.publish({ subject, data: JSON.stringify(duplicate), msgId: duplicate.id });
    await runner.pollOnce();

    expect(
      await prisma.processedMessage.count({
        where: { consumer: "booking-saga-unknown-order-case" },
      }),
    ).toBe(2);
    expect(await refundRequestsFor(paymentId)).toMatchObject([
      {
        payload: {
          causationId: first.id,
          payload: { paymentId, orderId, amount: 4_200, currency: "EUR", reason: "unknown_order" },
        },
      },
    ]);
    expect(await prisma.orderPayment.count({ where: { paymentId } })).toBe(0);
  });
});
