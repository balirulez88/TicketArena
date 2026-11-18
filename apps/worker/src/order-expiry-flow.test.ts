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

const NOW = new Date("2027-03-01T12:00:00.000Z");
const SETTLEMENT_GRACE_MS = 60_000;

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

describe("unpaid order -> worker sweeper -> EXPIRED -> expiry email", () => {
  it("expires the order at paymentDeadline + grace, frees its seat and records one expiry email", async () => {
    const buyer = { sessionId: "e".repeat(32), buyerKey: "e".repeat(32) };
    const event = await prisma.event.findFirstOrThrow({ where: { demo: true } });
    const seat = await prisma.seat.findFirstOrThrow({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "asc" },
    });
    const placing = createBookingService({
      db: prisma,
      clock: { now: () => NOW },
      newId: randomUUID,
    });
    const hold = await placing.holdSeats(buyer, event.id, [seat.id]);
    const order = await placing.placeOrder(
      buyer,
      hold.id,
      { email: "buyer@example.com" },
      randomUUID(),
    );
    const expiresAt = new Date(order.paymentDeadline.getTime() + SETTLEMENT_GRACE_MS);
    const provider = createMockNotificationProvider();
    // No payment consumer: this order is never paid.
    const consumers = createServiceConsumers({
      prisma,
      clock: { now: () => expiresAt, sleep: async () => undefined },
      random: { next: () => 0 },
      newId: randomUUID,
      notificationProvider: provider,
    }).filter((consumer) => consumer.service === "notification");

    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      relay: { intervalMs: 20 },
      consumers,
      sweeper: {
        booking: createBookingService({
          db: prisma,
          clock: { now: () => expiresAt },
          newId: randomUUID,
        }),
        intervalMs: 20,
      },
    });
    try {
      await expect
        .poll(
          async () => {
            const expired = await prisma.outboxEvent.findFirst({
              where: { eventType: "order.expired", aggregateId: order.id },
            });
            if (expired === null) {
              return [];
            }
            const records = await prisma.notification.findMany({
              where: { sourceEventId: expired.id },
            });
            return records.map((record) => [record.channel, record.template, record.status]);
          },
          { timeout: 15_000 },
        )
        .toEqual([["EMAIL", "order-expiry", "SENT"]]);

      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "EXPIRED",
      );
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe(
        "AVAILABLE",
      );
    } finally {
      await worker.stop();
    }
  });
});
