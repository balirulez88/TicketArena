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

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  await seedCatalog(prisma, new Date());
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

describe("late payment -> refund requested -> Payment refunds -> booking saga", () => {
  it("executes the refund once and the ledger records the payment as REFUNDED", async () => {
    const buyer = { sessionId: "r".repeat(32), buyerKey: "r".repeat(32) };
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
    const notifications = createMockNotificationProvider();
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
        notificationProvider: notifications,
      }),
    });
    try {
      await expect
        .poll(
          async () =>
            (await prisma.orderPayment.findMany({ where: { orderId: order.id } })).map(
              (entry) => entry.disposition,
            ),
          { timeout: 20_000 },
        )
        .toEqual(["REFUNDED"]);

      const [entry] = await prisma.orderPayment.findMany({ where: { orderId: order.id } });
      const paymentId = entry?.paymentId ?? "";
      expect(await prisma.paymentRefund.findMany({ where: { paymentId } })).toMatchObject([
        { orderId: order.id, amount: order.totalMinor, reason: "late_capture" },
      ]);
      expect(
        await prisma.paymentOutboxEvent.findMany({
          where: { eventType: "payment.refunded", aggregateId: paymentId },
        }),
      ).toMatchObject([
        {
          payload: {
            correlationId: hold.correlationId,
            payload: { paymentId, contact: { email: "buyer+late@example.com" } },
          },
        },
      ]);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "EXPIRED",
      );
      await expect
        .poll(
          () =>
            notifications
              .deliveries()
              .filter((delivery) => delivery.recipient === "buyer+late@example.com")
              .map((delivery) => delivery.template)
              .sort(),
          { timeout: 20_000 },
        )
        .toEqual(["order-expiry", "refund-completed", "refund-initiated"]);
    } finally {
      await worker.stop();
    }
  });
});
