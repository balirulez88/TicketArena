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
let testCase = 0;

const NOW = new Date();

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  await seedCatalog(prisma, NOW);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A bus on streams of this test's own (TD-072): its durable consumers start empty, so a worker
 * never receives an event an earlier test left unacked. The file's prefix still covers these
 * streams, so `setupTestNats` deletes them after the file.
 */
function isolatedBus(): Promise<MessageBus> {
  testCase += 1;
  return connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: `${nats.streamPrefix}C${testCase}_`,
    subjectPrefix: `${nats.subjectPrefix}c${testCase}`,
  });
}

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

/** The order's confirmation records, by channel. */
async function confirmationsOf(orderId: string) {
  const confirmed = await prisma.outboxEvent.findMany({
    where: { eventType: "order.confirmed", aggregateId: orderId },
  });
  return prisma.notification.findMany({
    where: { sourceEventId: { in: confirmed.map((event) => event.id) } },
    orderBy: { channel: "asc" },
  });
}

/**
 * Work still in flight for the order: unpublished outbox rows (in any schema, since the outboxes
 * are shared by the file's tests) plus the order's published events that their consumer has not
 * processed yet. Zero means the flow has settled: nothing is left that a later relay or consumer
 * could deliver, so stopping the worker cannot leak an event into the next test (TD-072).
 */
async function inFlight(orderId: string): Promise<number> {
  const ofOrder = { payload: { path: ["orderId"], equals: orderId } };
  const unpublished =
    (await prisma.outboxEvent.count({ where: { status: "PENDING" } })) +
    (await prisma.paymentOutboxEvent.count({ where: { status: "PENDING" } })) +
    (await prisma.notificationOutboxEvent.count({ where: { status: "PENDING" } }));
  const booking = await prisma.outboxEvent.findMany({ where: ofOrder });
  const payment = await prisma.paymentOutboxEvent.findMany({ where: ofOrder });
  const idsOf = (rows: { id: string; eventType: string }[], type: string) =>
    rows.filter((row) => row.eventType === type).map((row) => row.id);
  const unprocessed = async (ids: string[], processed: (messageIds: string[]) => Promise<number>) =>
    ids.length - (ids.length === 0 ? 0 : await processed(ids));
  return (
    unpublished +
    (await unprocessed(idsOf(booking, "order.placed"), (messageId) =>
      prisma.paymentProcessedMessage.count({
        where: { consumer: "payment", messageId: { in: messageId } },
      }),
    )) +
    (await unprocessed(idsOf(booking, "order.confirmed"), (messageId) =>
      prisma.notificationProcessedMessage.count({
        where: { consumer: "notification", messageId: { in: messageId } },
      }),
    )) +
    (await unprocessed(idsOf(payment, "payment.succeeded"), (messageId) =>
      prisma.processedMessage.count({
        where: { consumer: "booking-saga", messageId: { in: messageId } },
      }),
    )) +
    (await unprocessed(idsOf(payment, "payment.failed"), (messageId) =>
      prisma.processedMessage.count({
        where: { consumer: "booking-saga-failed", messageId: { in: messageId } },
      }),
    ))
  );
}

/** Waits until the order's flow has settled; call it before stopping the worker. */
async function drain(orderId: string): Promise<void> {
  await expect.poll(() => inFlight(orderId), { timeout: 15_000 }).toBe(0);
}

function startFlowWorker(bus: MessageBus, provider = createMockNotificationProvider()) {
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
    }),
  });
}

describe("hold -> order -> worker -> CONFIRMED", () => {
  it("confirms the order: CONFIRMED, one APPLIED ledger row, SOLD seats, one confirmation record (AT-15)", async () => {
    const { order, seatId } = await placeOrderFor("buyer@example.com", "a");
    const provider = createMockNotificationProvider();
    const bus = await isolatedBus();
    const worker = await startFlowWorker(bus, provider);
    try {
      await expect
        .poll(
          async () => (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
          { timeout: 15_000 },
        )
        .toBe("CONFIRMED");
      await drain(order.id);

      expect(
        await prisma.orderPayment.count({ where: { orderId: order.id, disposition: "APPLIED" } }),
      ).toBe(1);
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("SOLD");
      const records = await confirmationsOf(order.id);
      expect(records.map((record) => [record.channel, record.status])).toEqual([["EMAIL", "SENT"]]);
      // Every delivery this worker made, unfiltered: only this order's confirmation reached it.
      expect(
        provider.deliveries().map((delivery) => [delivery.channel, delivery.idempotencyKey]),
      ).toEqual([["EMAIL", records[0]?.id]]);
    } finally {
      await worker.stop();
      await bus.close();
    }
  });

  it("changes state once when Payment publishes its result twice (+dup@, first half of AT-14)", async () => {
    const { order } = await placeOrderFor("buyer+dup@example.com", "b");
    const bus = await isolatedBus();
    const worker = await startFlowWorker(bus);
    try {
      // Both results reach the saga (distinct event ids) and the flow settles; only the first
      // result may change state.
      await expect
        .poll(
          () =>
            prisma.paymentOutboxEvent.count({
              where: { status: "PUBLISHED", payload: { path: ["orderId"], equals: order.id } },
            }),
          { timeout: 15_000 },
        )
        .toBe(2);
      await drain(order.id);

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
      await bus.close();
    }
  });

  it("sends exactly one confirmation per channel, even with +dup@ (AT-15, AT-14 second half)", async () => {
    const { order } = await placeOrderFor("buyer+dup@example.com", "c", "+36301234567");
    const provider = createMockNotificationProvider();
    const bus = await isolatedBus();
    const worker = await startFlowWorker(bus, provider);
    try {
      await expect
        .poll(
          async () =>
            (await confirmationsOf(order.id)).map((record) => [record.channel, record.status]),
          { timeout: 15_000 },
        )
        .toEqual([
          ["EMAIL", "SENT"],
          ["SMS", "SENT"],
        ]);
      const sent = await confirmationsOf(order.id);
      // TD-065: let the duplicate result and every outbox row play out, then nothing may have
      // been added: one order.confirmed, published, and the same two records and deliveries.
      await drain(order.id);

      expect(
        await prisma.outboxEvent.findMany({
          where: { eventType: "order.confirmed", aggregateId: order.id },
          select: { status: true },
        }),
      ).toEqual([{ status: "PUBLISHED" }]);
      expect(await confirmationsOf(order.id)).toEqual(sent);
      expect(
        provider
          .deliveries()
          .map((delivery) => [delivery.channel, delivery.idempotencyKey])
          .sort(),
      ).toEqual(sent.map((record) => [record.channel, record.id]));
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "CONFIRMED",
      );
    } finally {
      await worker.stop();
      await bus.close();
    }
  });
});
