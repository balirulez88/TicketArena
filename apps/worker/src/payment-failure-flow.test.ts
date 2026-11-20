import { randomUUID } from "node:crypto";
import { createBookingService } from "@ticketarena/booking";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { connectJetStreamMessageBus, type MessageBus } from "@ticketarena/messaging";
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
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

async function placeOrderFor(email: string, sessionChar: string) {
  const buyer = { sessionId: sessionChar.repeat(32), buyerKey: sessionChar.repeat(32) };
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
  const order = await booking.placeOrder(buyer, hold.id, { email }, randomUUID());
  return { order, seatId: seat.id };
}

/** The worker with every service consumer; `paymentSuccessRate` 0 makes each random draw fail. */
function startFullWorker(
  provider: ReturnType<typeof createMockNotificationProvider>,
  paymentSuccessRate?: number,
) {
  return startWorker({
    bus,
    prisma,
    port: 0,
    relay: { intervalMs: 20 },
    consumers: createServiceConsumers({
      prisma,
      clock: { now: () => new Date(), sleep: async () => undefined },
      random: { next: () => 0 },
      newId: randomUUID,
      notificationProvider: provider,
      ...(paymentSuccessRate === undefined ? {} : { paymentSuccessRate }),
    }),
  });
}

/** The order's cancellation notifications as [channel, template, status]; scoped to the order. */
async function cancellationOf(orderId: string) {
  const cancelled = await prisma.outboxEvent.findFirst({
    where: { eventType: "order.cancelled", aggregateId: orderId },
  });
  if (cancelled === null) {
    return [];
  }
  const records = await prisma.notification.findMany({ where: { sourceEventId: cancelled.id } });
  return records.map((record) => [record.channel, record.template, record.status]);
}

describe("hold -> order -> worker -> payment.failed", () => {
  it("cancels the order on a final failure, frees its seat and records one cancellation email (AT-16)", async () => {
    const { order, seatId } = await placeOrderFor("buyer+fail@example.com", "a");
    const provider = createMockNotificationProvider();
    const worker = await startFullWorker(provider);
    try {
      await expect
        .poll(() => cancellationOf(order.id), { timeout: 15_000 })
        .toEqual([["EMAIL", "order-cancellation", "SENT"]]);

      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "CANCELLED",
      );
      expect(await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).toMatchObject({
        status: "AVAILABLE",
        holdId: null,
      });
      expect(await prisma.orderPayment.count({ where: { orderId: order.id } })).toBe(0);
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: "order.cancelled", aggregateId: order.id },
        }),
      ).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it("keeps the order PENDING_PAYMENT and its seat IN_CHECKOUT on a non-final failure (AT-17)", async () => {
    const { order, seatId } = await placeOrderFor("buyer@example.com", "b");
    const worker = await startFullWorker(createMockNotificationProvider(), 0);
    try {
      // Wait until the saga has processed the failure, not merely until time has passed.
      await expect
        .poll(
          async () => {
            const failed = await prisma.paymentOutboxEvent.findMany({
              where: {
                eventType: "payment.failed",
                payload: { path: ["orderId"], equals: order.id },
              },
              select: { id: true },
            });
            return prisma.processedMessage.count({
              where: { messageId: { in: failed.map((row) => row.id) } },
            });
          },
          { timeout: 15_000 },
        )
        .toBe(1);

      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "PENDING_PAYMENT",
      );
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
        "IN_CHECKOUT",
      );
      expect(await prisma.orderPayment.count({ where: { orderId: order.id } })).toBe(0);
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: "order.cancelled", aggregateId: order.id },
        }),
      ).toBe(0);
    } finally {
      await worker.stop();
    }
  });
});
