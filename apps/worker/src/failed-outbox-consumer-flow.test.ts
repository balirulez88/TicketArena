import { randomUUID } from "node:crypto";
import { createBookingService } from "@ticketarena/booking";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { seedCatalog } from "@ticketarena/db/seed";
import {
  type ConsumerRunner,
  connectJetStreamMessageBus,
  createConsumerRunner,
  createOutboxRelay,
  type MessageBus,
  requeueFailedOutboxEvent,
  type ServiceName,
} from "@ticketarena/messaging";
import {
  declareStream,
  deleteConsumer,
  setupTestDatabase,
  setupTestNats,
} from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceConsumers } from "./consumers.js";

// ADR 0022: once an earlier event of an aggregate is FAILED, later events of that aggregate are
// published first. For each aggregate with more than one event in one outbox, this delivers the
// later event through the real consumer runner while the earlier one is FAILED, then requeues the
// earlier one, and compares the end state with in-order delivery of the same events.
//
// The earlier event fails the way a misconfigured broker makes it fail: the main stream is
// declared without its subject, so the broker reports "no stream matches subject". The operator's
// fix is the real topology (`ensureTopology` updates the stream in place), then a requeue.
const database = setupTestDatabase();
const nats = setupTestNats();
const CAP = 2;

let prisma: PrismaClient;
let testCase = 0;
let buyerSeq = 0;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  await seedCatalog(prisma, new Date());
});

afterAll(async () => {
  await prisma.$disconnect();
});

interface Pipe {
  readonly bus: MessageBus;
  readonly streamPrefix: string;
  /** Declares the real topology over a stream declared without `missing`: the operator's fix. */
  fix(): Promise<void>;
  close(): Promise<void>;
}

const MAIN_SUBJECTS = [
  "ta.seat.>",
  "ta.hold.>",
  "ta.order.placed",
  "ta.order.confirmed",
  "ta.order.cancelled",
  "ta.order.expired",
  "ta.payment.succeeded",
  "ta.payment.failed",
  "ta.payment.refund_requested",
  "ta.payment.refunded",
];

/**
 * A bus on streams of this run's own. With `missing`, the main stream first captures every subject
 * but that one, so its events fail permanently until `fix`; the DLQ stream is declared intact.
 */
async function pipe(missing?: string): Promise<Pipe> {
  testCase += 1;
  const streamPrefix = `${nats.streamPrefix}F${testCase}_`;
  const subjectPrefix = `${nats.subjectPrefix}f${testCase}`;
  const bus = await connectJetStreamMessageBus({ servers: nats.url, streamPrefix, subjectPrefix });
  if (missing === undefined) {
    await bus.ensureTopology();
  } else {
    await declareStream(
      nats.url,
      `${streamPrefix}TICKETARENA`,
      MAIN_SUBJECTS.filter((subject) => subject !== missing).map(
        (subject) => `${subjectPrefix}.${subject}`,
      ),
    );
    await declareStream(nats.url, `${streamPrefix}TICKETARENA_DLQ`, [`${subjectPrefix}.ta.dlq.>`]);
  }
  return { bus, streamPrefix, fix: () => bus.ensureTopology(), close: () => bus.close() };
}

const clock = { now: () => new Date(), sleep: async () => undefined };

/** The real consumer of that durable name, as the worker registers it, on this run's bus. */
function runner(bus: MessageBus, consumer: string): Promise<ConsumerRunner> {
  const spec = createServiceConsumers({
    prisma,
    clock,
    random: { next: () => 0 },
    newId: randomUUID,
  }).find((candidate) => candidate.consumer === consumer);
  if (spec === undefined) {
    throw new Error(`no consumer ${consumer}`);
  }
  // Redelivered at once after a refusal, so the test need not wait out the ADR 0011 schedule.
  return createConsumerRunner({ ...spec, bus, prisma, retryDelayMs: () => 0 });
}

const PROCESSED: Record<ServiceName, (consumer: string, messageId: string) => Promise<number>> = {
  booking: (consumer, messageId) =>
    prisma.processedMessage.count({ where: { consumer, messageId } }),
  payment: (consumer, messageId) =>
    prisma.paymentProcessedMessage.count({ where: { consumer, messageId } }),
  notification: (consumer, messageId) =>
    prisma.notificationProcessedMessage.count({ where: { consumer, messageId } }),
};

/** Polls the runner until it has processed `messageId` (its `processed_messages` row exists). */
async function consume(
  consumer: ConsumerRunner,
  service: ServiceName,
  name: string,
  messageId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await consumer.pollOnce();
        return PROCESSED[service](name, messageId);
      },
      { timeout: 15_000, interval: 50 },
    )
    .toBe(1);
}

/** A clean slate for a run: no outbox row of an earlier run is relayed into this one's streams. */
async function clearOutboxes(): Promise<void> {
  await prisma.outboxEvent.deleteMany();
  await prisma.paymentOutboxEvent.deleteMany();
  await prisma.notificationOutboxEvent.deleteMany();
}

async function placeOrder() {
  buyerSeq += 1;
  const key = buyerSeq.toString(16).padStart(32, "0");
  const buyer = { sessionId: key, buyerKey: key };
  const event = await prisma.event.findFirstOrThrow({ where: { demo: true } });
  const seat = await prisma.seat.findFirstOrThrow({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "asc" },
  });
  const booking = createBookingService({ db: prisma, clock, newId: randomUUID });
  const hold = await booking.holdSeats(buyer, event.id, [seat.id]);
  const order = await booking.placeOrder(
    buyer,
    hold.id,
    { email: "buyer@example.com" },
    randomUUID(),
  );
  // Only the order's events matter here; the hold's `seat.held` has no consumer.
  await prisma.outboxEvent.deleteMany({ where: { aggregateType: "hold" } });
  const placed = await prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: "order.placed", aggregateId: order.id },
  });
  return { order, hold, seatId: seat.id, placed };
}

/** Every notification record; each run starts with none. */
async function notifications() {
  const rows = await prisma.notification.findMany({
    orderBy: [{ template: "asc" }, { channel: "asc" }],
  });
  return rows.map((row) => ({ template: row.template, channel: row.channel, status: row.status }));
}

describe("the order aggregate (booking outbox): order.placed FAILED, later order events first", () => {
  /**
   * The later event is the one the ticket names (`order.confirmed`) and the one an unpaid order
   * really gets while its `order.placed` cannot reach Payment (`order.expired`).
   */
  for (const later of [
    { type: "order.confirmed", consumer: "notification", template: "order-confirmation" },
    { type: "order.expired", consumer: "notification-expired", template: "order-expiry" },
  ] as const) {
    async function run(outOfOrder: boolean) {
      await clearOutboxes();
      await prisma.notification.deleteMany();
      const { order, hold, seatId, placed } = await placeOrder();
      const laterId = randomUUID();
      await prisma.outboxEvent.create({
        data: {
          id: laterId,
          aggregateType: "order",
          aggregateId: order.id,
          eventType: later.type,
          createdAt: new Date(placed.createdAt.getTime() + 1),
          payload: {
            id: laterId,
            type: later.type,
            version: 1,
            occurredAt: new Date().toISOString(),
            correlationId: hold.correlationId,
            causationId: null,
            holdId: hold.id,
            orderId: order.id,
            payload: laterPayload(order, seatId),
          },
        },
      });
      const io = await pipe(outOfOrder ? "ta.order.placed" : undefined);
      try {
        const relay = createOutboxRelay({ bus: io.bus, prisma, maxPermanentFailures: CAP });
        const notification = await runner(io.bus, later.consumer);
        if (outOfOrder) {
          await deliverLaterFirst(io, relay, notification, order.id, placed.id, laterId);
        } else {
          const payment = await runner(io.bus, "payment");
          expect(await relay.tick()).toBe(1);
          await consume(payment, "payment", "payment", placed.id);
          expect(await relay.tick()).toBe(1);
          await consume(notification, "notification", later.consumer, laterId);
        }
        return await endState(order.id, placed.id, laterId);
      } finally {
        await io.close();
      }
    }

    function laterPayload(
      order: { id: string; totalMinor: number; currency: string },
      seatId: string,
    ): object {
      const contact = { email: "buyer@example.com" };
      return later.type === "order.confirmed"
        ? {
            orderId: order.id,
            seatIds: [seatId],
            totalMinor: order.totalMinor,
            currency: order.currency,
            contact,
          }
        : { orderId: order.id, contact };
    }

    /** order.placed fails to the cap, the later event is consumed, then the fix and requeue. */
    async function deliverLaterFirst(
      io: Pipe,
      relay: { tick(): Promise<number> },
      notification: ConsumerRunner,
      orderId: string,
      placedId: string,
      laterId: string,
    ): Promise<void> {
      for (let tick = 0; tick <= CAP; tick += 1) {
        await relay.tick();
      }
      const statusOf = async (id: string) =>
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).status;
      expect(await statusOf(placedId)).toBe("FAILED");
      expect(await statusOf(laterId)).toBe("PUBLISHED");
      await consume(notification, "notification", later.consumer, laterId);
      expect(await prisma.paymentAttempt.count({ where: { orderId } })).toBe(0);

      await io.fix();
      await requeueFailedOutboxEvent(prisma, {
        service: "booking",
        outboxId: placedId,
        operator: "test",
        reason: "stream subjects fixed",
      });
      expect(await relay.tick()).toBe(1);
      await consume(await runner(io.bus, "payment"), "payment", "payment", placedId);
    }

    async function endState(orderId: string, placedId: string, laterId: string) {
      return {
        attempts: (await prisma.paymentAttempt.findMany({ where: { orderId } })).map((attempt) => ({
          attemptNo: attempt.attemptNo,
          status: attempt.status,
        })),
        paymentEvents: (
          await prisma.paymentOutboxEvent.findMany({
            where: { payload: { path: ["orderId"], equals: orderId } },
          })
        ).map((event) => event.eventType),
        notifications: await notifications(),
        processed: {
          payment: await PROCESSED.payment("payment", placedId),
          notification: await PROCESSED.notification(later.consumer, laterId),
        },
      };
    }

    it(`applies ${later.type} while order.placed is FAILED, then the requeued order.placed, ending as in-order delivery with every effect once`, async () => {
      const inOrder = await run(false);
      const outOfOrder = await run(true);

      expect(inOrder).toEqual({
        attempts: [{ attemptNo: 1, status: "CAPTURED" }],
        paymentEvents: ["payment.succeeded"],
        notifications: [{ template: later.template, channel: "EMAIL", status: "SENT" }],
        processed: { payment: 1, notification: 1 },
      });
      expect(outOfOrder).toEqual(inOrder);
    });
  }

  it("publishes the requeued order.placed under its original id, so a second delivery changes nothing", async () => {
    await clearOutboxes();
    const { order, placed } = await placeOrder();
    const io = await pipe("ta.order.placed");
    try {
      const relay = createOutboxRelay({ bus: io.bus, prisma, maxPermanentFailures: 1 });
      await relay.tick();
      await io.fix();
      await requeueFailedOutboxEvent(prisma, {
        service: "booking",
        outboxId: placed.id,
        operator: "test",
        reason: "stream subjects fixed",
      });
      expect(await relay.tick()).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { aggregateId: order.id } })).toBe(1);
      const first = await runner(io.bus, "payment");
      await consume(first, "payment", "payment", placed.id);
      const effects = async () => ({
        attempts: await prisma.paymentAttempt.count({ where: { orderId: order.id } }),
        events: await prisma.paymentOutboxEvent.count({
          where: { payload: { path: ["orderId"], equals: order.id } },
        }),
        processed: await prisma.paymentProcessedMessage.count({ where: { consumer: "payment" } }),
        // Checkpointed under the original outbox id, the `Nats-Msg-Id` consumers dedupe on.
        underOriginalId: await PROCESSED.payment("payment", placed.id),
      });
      const once = await effects();
      expect(once).toMatchObject({ attempts: 1, events: 1, underOriginalId: 1 });

      // Deliver it again: a fresh durable of the same name replays the stored message.
      await deleteConsumer(nats.url, `${io.streamPrefix}TICKETARENA`, "payment");
      const again = await runner(io.bus, "payment");
      await expect.poll(() => again.pollOnce(), { timeout: 15_000, interval: 50 }).toBe(1);

      expect(await effects()).toEqual(once);
    } finally {
      await io.close();
    }
  });
});

describe("the payment aggregate (payment outbox): payment.succeeded FAILED, payment.refunded first", () => {
  async function run(outOfOrder: boolean) {
    await clearOutboxes();
    await prisma.notification.deleteMany();
    const { order, hold } = await placeOrder();
    const paymentId = randomUUID();
    const capturedAt = new Date(order.paymentDeadline.getTime() + 1000);
    const succeededId = randomUUID();
    const refundedId = randomUUID();
    const envelope = (id: string, type: string, payload: object) => ({
      id,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: hold.correlationId,
      causationId: randomUUID(),
      holdId: hold.id,
      orderId: order.id,
      payload,
    });
    const base = Date.now();
    await prisma.paymentOutboxEvent.createMany({
      data: [
        {
          id: succeededId,
          aggregateType: "payment",
          aggregateId: paymentId,
          eventType: "payment.succeeded",
          createdAt: new Date(base),
          // Captured after the deadline: booking keeps none of it and asks for a refund.
          payload: envelope(succeededId, "payment.succeeded", {
            paymentId,
            orderId: order.id,
            attemptNo: 1,
            amount: order.totalMinor,
            currency: order.currency,
            capturedAt: capturedAt.toISOString(),
          }),
        },
        {
          id: refundedId,
          aggregateType: "payment",
          aggregateId: paymentId,
          eventType: "payment.refunded",
          createdAt: new Date(base + 1),
          payload: envelope(refundedId, "payment.refunded", {
            paymentId,
            orderId: order.id,
            amount: order.totalMinor,
            currency: order.currency,
            refundedAt: new Date().toISOString(),
            contact: { email: "buyer@example.com" },
          }),
        },
      ],
    });
    const io = await pipe(outOfOrder ? "ta.payment.succeeded" : undefined);
    try {
      const relay = createOutboxRelay({
        bus: io.bus,
        prisma,
        service: "payment",
        maxPermanentFailures: CAP,
      });
      const sagaRefunded = await runner(io.bus, "booking-saga-refunded");
      const notification = await runner(io.bus, "notification-refunded");
      if (outOfOrder) {
        for (let tick = 0; tick <= CAP; tick += 1) {
          await relay.tick();
        }
        expect(
          (await prisma.paymentOutboxEvent.findUniqueOrThrow({ where: { id: succeededId } }))
            .status,
        ).toBe("FAILED");
        await consume(notification, "notification", "notification-refunded", refundedId);
        // Booking refuses a refund of a payment it has not recorded (poison), changing nothing,
        // and dead-letters it (ADR 0011).
        expect(await sagaRefunded.pollOnce()).toBe(1);
        expect(await PROCESSED.booking("booking-saga-refunded", refundedId)).toBe(0);
        const dlq = await io.bus.subscribe({
          stream: "dlq",
          consumer: "inspect",
          filterSubject: "ta.dlq.booking-saga-refunded",
        });
        expect(
          (await dlq.fetch({ maxMessages: 10, expiresMs: 1_000 })).map((copy) => copy.msgId),
        ).toEqual([`dlq:booking-saga-refunded:${refundedId}`]);
        expect(await prisma.orderPayment.count({ where: { orderId: order.id } })).toBe(0);
        expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
          "PENDING_PAYMENT",
        );

        await io.fix();
        await requeueFailedOutboxEvent(prisma, {
          service: "payment",
          outboxId: succeededId,
          operator: "test",
          reason: "stream subjects fixed",
        });
        expect(await relay.tick()).toBe(1);
        await consume(await runner(io.bus, "booking-saga"), "booking", "booking-saga", succeededId);
        // The operator replays the dead-lettered payment.refunded by recreating the durable (ADR
        // 0011 consumer recovery: replay from the earliest retained message); it now applies.
        await deleteConsumer(nats.url, `${io.streamPrefix}TICKETARENA`, "booking-saga-refunded");
        await consume(
          await runner(io.bus, "booking-saga-refunded"),
          "booking",
          "booking-saga-refunded",
          refundedId,
        );
      } else {
        const saga = await runner(io.bus, "booking-saga");
        expect(await relay.tick()).toBe(1);
        await consume(saga, "booking", "booking-saga", succeededId);
        expect(await relay.tick()).toBe(1);
        await consume(sagaRefunded, "booking", "booking-saga-refunded", refundedId);
        await consume(notification, "notification", "notification-refunded", refundedId);
      }
      return {
        orderStatus: (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
        ledger: (await prisma.orderPayment.findMany({ where: { orderId: order.id } })).map(
          (row) => ({ paymentId: row.paymentId === paymentId, disposition: row.disposition }),
        ),
        bookingEvents: (
          await prisma.outboxEvent.findMany({
            where: {
              aggregateId: { in: [order.id, paymentId] },
              eventType: { not: "order.placed" },
            },
            orderBy: { eventType: "asc" },
          })
        ).map((event) => event.eventType),
        notifications: (
          await prisma.notification.findMany({ where: { dedupeKey: { contains: paymentId } } })
        ).map((row) => ({ template: row.template, channel: row.channel, status: row.status })),
        processed: {
          saga: await PROCESSED.booking("booking-saga", succeededId),
          sagaRefunded: await PROCESSED.booking("booking-saga-refunded", refundedId),
          notification: await PROCESSED.notification("notification-refunded", refundedId),
        },
      };
    } finally {
      await io.close();
    }
  }

  it("refuses payment.refunded without any change while payment.succeeded is FAILED, dead-letters it, then ends as in-order delivery with every effect once after its replay", async () => {
    const inOrder = await run(false);
    const outOfOrder = await run(true);

    expect(inOrder).toEqual({
      orderStatus: "EXPIRED",
      ledger: [{ paymentId: true, disposition: "REFUNDED" }],
      bookingEvents: ["order.expired", "payment.refund_requested"],
      notifications: [{ template: "refund-completed", channel: "EMAIL", status: "SENT" }],
      processed: { saga: 1, sagaRefunded: 1, notification: 1 },
    });
    expect(outOfOrder).toEqual(inOrder);
  });
});
