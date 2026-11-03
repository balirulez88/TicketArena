import { randomUUID } from "node:crypto";
import { createBookingService } from "@ticketarena/booking";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { connectJetStreamMessageBus, type MessageBus } from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceConsumers } from "./consumers.js";
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

describe("hold -> order -> worker -> CONFIRMED", () => {
  it("confirms the order with exactly one APPLIED ledger row and SOLD seats", async () => {
    const { order, seatId } = await placeOrderFor("buyer@example.com", "a");
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      relay: { intervalMs: 20 },
      consumers: createServiceConsumers({
        clock: { now: () => new Date(), sleep: async () => undefined },
        random: { next: () => 0 },
        newId: randomUUID,
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
});
