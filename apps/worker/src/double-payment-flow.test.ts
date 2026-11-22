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
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

describe("hold -> order -> worker -> two captures (+double@)", () => {
  it("AT-21: confirms on one payment and refunds the second; exactly one APPLIED", async () => {
    const buyer = { sessionId: "d".repeat(32), buyerKey: "d".repeat(32) };
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
      { email: "buyer+double@example.com" },
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
      // The second payment's obligation is executed by the worker too, so wait for REFUNDED.
      await expect
        .poll(
          async () =>
            (
              await prisma.orderPayment.findMany({
                where: { orderId: order.id },
                orderBy: { disposition: "asc" },
              })
            ).map((row) => row.disposition),
          { timeout: 15_000 },
        )
        .toEqual(["APPLIED", "REFUNDED"]);

      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "CONFIRMED",
      );
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe("SOLD");
      const attempts = await prisma.paymentAttempt.findMany({ where: { orderId: order.id } });
      const ledger = await prisma.orderPayment.findMany({ where: { orderId: order.id } });
      expect(new Set(ledger.map((row) => row.paymentId))).toEqual(
        new Set(attempts.map((attempt) => attempt.paymentId)),
      );
      const refunded = ledger.find((row) => row.disposition === "REFUNDED");
      expect(
        await prisma.outboxEvent.findMany({
          where: {
            eventType: "payment.refund_requested",
            payload: { path: ["orderId"], equals: order.id },
          },
        }),
      ).toMatchObject([
        {
          aggregateId: refunded?.paymentId,
          payload: { payload: { reason: "order_confirmed" } },
        },
      ]);
      expect(await prisma.paymentRefund.findMany({ where: { orderId: order.id } })).toMatchObject([
        { paymentId: refunded?.paymentId, reason: "order_confirmed" },
      ]);
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
