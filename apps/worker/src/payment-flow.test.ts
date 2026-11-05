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

async function placeOrderFor(email: string, sessionChar: string, phone?: string) {
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
  const order = await booking.placeOrder(
    buyer,
    hold.id,
    { email, ...(phone === undefined ? {} : { phone }) },
    randomUUID(),
  );
  return { order, seatId: seat.id };
}

describe("hold -> order -> worker -> CONFIRMED", () => {
  it("confirms the order: CONFIRMED, one APPLIED ledger row, SOLD seats, one confirmation record (AT-15)", async () => {
    const { order, seatId } = await placeOrderFor("buyer@example.com", "a");
    const provider = createMockNotificationProvider();
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
        notificationProvider: provider,
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
        .toBe("CONFIRMED");

      expect(
        await prisma.orderPayment.count({ where: { orderId: order.id, disposition: "APPLIED" } }),
      ).toBe(1);
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("SOLD");
      await expect.poll(() => provider.deliveries().length, { timeout: 15_000 }).toBe(1);
      const confirmedId = (
        await prisma.outboxEvent.findFirstOrThrow({
          where: { eventType: "order.confirmed", aggregateId: order.id },
        })
      ).id;
      const records = await prisma.notification.findMany({ where: { sourceEventId: confirmedId } });
      expect(records.map((record) => [record.channel, record.status])).toEqual([["EMAIL", "SENT"]]);
    } finally {
      await worker.stop();
    }
  });

  it("changes state once when Payment publishes its result twice (+dup@, first half of AT-14)", async () => {
    const { order } = await placeOrderFor("buyer+dup@example.com", "b");
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
      }),
    });
    try {
      await expect
        .poll(
          async () =>
            prisma.paymentOutboxEvent.count({
              where: { status: "PUBLISHED", payload: { path: ["orderId"], equals: order.id } },
            }),
          { timeout: 15_000 },
        )
        .toBe(2);
      // Both deliveries reach the saga (distinct event ids); only the first may change state.
      const resultIds = (
        await prisma.paymentOutboxEvent.findMany({
          where: { payload: { path: ["orderId"], equals: order.id } },
          select: { id: true },
        })
      ).map((row) => row.id);
      await expect
        .poll(
          async () =>
            prisma.processedMessage.count({
              where: { consumer: "booking-saga", messageId: { in: resultIds } },
            }),
          { timeout: 15_000 },
        )
        .toBe(2);

      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "CONFIRMED",
      );
      expect(await prisma.orderPayment.count({ where: { orderId: order.id } })).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: "order.confirmed", aggregateId: order.id },
        }),
      ).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it("sends exactly one confirmation per channel, even with +dup@ (AT-15, AT-14 second half)", async () => {
    const { order } = await placeOrderFor("buyer+dup@example.com", "c", "+36301234567");
    const provider = createMockNotificationProvider();
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
        notificationProvider: provider,
      }),
    });
    try {
      await expect.poll(() => provider.deliveries().length, { timeout: 15_000 }).toBe(2);
      const confirmedId = (
        await prisma.outboxEvent.findFirstOrThrow({
          where: { eventType: "order.confirmed", aggregateId: order.id },
        })
      ).id;
      const records = await prisma.notification.findMany({
        where: { sourceEventId: confirmedId },
        orderBy: { channel: "asc" },
      });
      expect(records.map((record) => [record.channel, record.status])).toEqual([
        ["EMAIL", "SENT"],
        ["SMS", "SENT"],
      ]);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "CONFIRMED",
      );
    } finally {
      await worker.stop();
    }
  });
});
