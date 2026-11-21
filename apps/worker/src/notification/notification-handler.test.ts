import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockNotificationProvider, type MockNotificationProvider } from "./mock-provider.js";
import { createNotificationHandler } from "./notification-handler.js";

const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus;
let sequence = 0;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
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

const NOW = new Date("2027-03-01T12:02:00.000Z");

function orderConfirmed(contact: { email: string; phone?: string }) {
  const orderId = randomUUID();
  return {
    id: randomUUID(),
    type: "order.confirmed",
    version: 1,
    occurredAt: "2027-03-01T12:01:30.000Z",
    correlationId: randomUUID(),
    causationId: null,
    orderId,
    payload: {
      orderId,
      seatIds: [randomUUID()],
      totalMinor: 12_500,
      currency: "EUR",
      contact,
    },
  };
}

function orderExpired(contact: { email: string; phone?: string }) {
  const orderId = randomUUID();
  return {
    id: randomUUID(),
    type: "order.expired",
    version: 1,
    occurredAt: "2027-03-01T12:06:00.000Z",
    correlationId: randomUUID(),
    causationId: null,
    holdId: randomUUID(),
    orderId,
    payload: { orderId, contact },
  };
}

function orderCancelled(contact: { email: string; phone?: string }) {
  const orderId = randomUUID();
  return {
    id: randomUUID(),
    type: "order.cancelled",
    version: 1,
    occurredAt: "2027-03-01T12:01:00.000Z",
    correlationId: randomUUID(),
    causationId: randomUUID(),
    holdId: randomUUID(),
    orderId,
    payload: { orderId, reason: "payment_failed", contact },
  };
}

function refundRequested(contact?: { email: string; phone?: string }) {
  const orderId = randomUUID();
  const paymentId = randomUUID();
  return {
    id: randomUUID(),
    type: "payment.refund_requested",
    version: 1,
    occurredAt: "2027-03-01T12:06:00.000Z",
    correlationId: randomUUID(),
    causationId: randomUUID(),
    orderId,
    payload: {
      paymentId,
      orderId,
      amount: 12_500,
      currency: "EUR",
      reason: contact === undefined ? "unknown_order" : "late_capture",
      ...(contact === undefined ? {} : { contact }),
    },
  };
}

function refunded(contact?: { email: string; phone?: string }) {
  const orderId = randomUUID();
  const paymentId = randomUUID();
  return {
    id: randomUUID(),
    type: "payment.refunded",
    version: 1,
    occurredAt: "2027-03-01T12:06:05.000Z",
    correlationId: randomUUID(),
    causationId: randomUUID(),
    orderId,
    payload: {
      paymentId,
      orderId,
      amount: 12_500,
      currency: "EUR",
      refundedAt: "2027-03-01T12:06:04.000Z",
      ...(contact === undefined ? {} : { contact }),
    },
  };
}

type NotifiedEnvelope =
  | ReturnType<typeof orderConfirmed>
  | ReturnType<typeof orderExpired>
  | ReturnType<typeof orderCancelled>
  | ReturnType<typeof refundRequested>
  | ReturnType<typeof refunded>;

async function deliver(
  envelope: NotifiedEnvelope,
  provider: MockNotificationProvider = createMockNotificationProvider(),
  times = 1,
) {
  sequence += 1;
  const subject = `ta.order.notification-case${sequence}`;
  const runner = await createConsumerRunner({
    bus,
    prisma,
    service: "notification",
    consumer: `notification-case${sequence}`,
    filterSubject: subject,
    handler: createNotificationHandler({
      prisma,
      provider,
      clock: { now: () => NOW },
      newId: randomUUID,
    }),
  });
  for (let copy = 0; copy < times; copy += 1) {
    await bus.publish({
      subject,
      data: JSON.stringify(envelope),
      msgId: `${envelope.id}-${sequence}-${copy}`,
    });
    await runner.pollOnce();
  }
  return provider;
}

describe("Notification handler", () => {
  it("sends one email and marks it SENT", async () => {
    const envelope = orderConfirmed({ email: "buyer@example.com" });

    const provider = await deliver(envelope);

    const rows = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(rows).toMatchObject([
      { channel: "EMAIL", recipient: "buyer@example.com", status: "SENT", sentAt: NOW },
    ]);
    expect(provider.deliveries()).toMatchObject([
      { idempotencyKey: rows[0]?.id, channel: "EMAIL", recipient: "buyer@example.com" },
    ]);
  });

  it("adds an SMS when a phone number was given", async () => {
    const envelope = orderConfirmed({ email: "buyer@example.com", phone: "+36301234567" });

    const provider = await deliver(envelope);

    const rows = await prisma.notification.findMany({
      where: { sourceEventId: envelope.id },
      orderBy: { channel: "asc" },
    });
    expect(rows.map((row) => [row.channel, row.recipient, row.status])).toEqual([
      ["EMAIL", "buyer@example.com", "SENT"],
      ["SMS", "+36301234567", "SENT"],
    ]);
    expect(provider.deliveries()).toHaveLength(2);
  });

  it("keeps one record per channel when the same event is delivered twice (+dup@)", async () => {
    const envelope = orderConfirmed({ email: "buyer+dup@example.com", phone: "+36301234567" });

    const provider = await deliver(envelope, undefined, 2);

    expect(await prisma.notification.count({ where: { sourceEventId: envelope.id } })).toBe(2);
    expect(provider.deliveries()).toHaveLength(2);
  });

  it("leaves a PENDING record when the provider fails, then resumes it with the same key", async () => {
    const envelope = orderConfirmed({ email: "buyer@example.com" });
    const failing: MockNotificationProvider = {
      ...createMockNotificationProvider(),
      send: async () => {
        throw new Error("provider down");
      },
    };

    await deliver(envelope, failing).catch(() => undefined);

    const pending = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(pending).toMatchObject([{ channel: "EMAIL", status: "PENDING", sentAt: null }]);

    const provider = await deliver(envelope);

    const rows = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(rows).toMatchObject([{ id: pending[0]?.id, status: "SENT", sentAt: NOW }]);
    expect(provider.deliveries()).toMatchObject([{ idempotencyKey: pending[0]?.id }]);
  });

  it("records an expiry email for order.expired", async () => {
    const envelope = orderExpired({ email: "buyer@example.com" });

    const provider = await deliver(envelope);

    const rows = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(rows).toMatchObject([
      {
        channel: "EMAIL",
        recipient: "buyer@example.com",
        template: "order-expiry",
        status: "SENT",
        sentAt: NOW,
      },
    ]);
    expect(provider.deliveries()).toMatchObject([
      { idempotencyKey: rows[0]?.id, channel: "EMAIL", template: "order-expiry" },
    ]);
  });

  it("records a cancellation email for order.cancelled", async () => {
    const envelope = orderCancelled({ email: "buyer+fail@example.com" });

    const provider = await deliver(envelope);

    const rows = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(rows).toMatchObject([
      {
        channel: "EMAIL",
        recipient: "buyer+fail@example.com",
        template: "order-cancellation",
        status: "SENT",
        sentAt: NOW,
      },
    ]);
    expect(provider.deliveries()).toMatchObject([
      { idempotencyKey: rows[0]?.id, channel: "EMAIL", template: "order-cancellation" },
    ]);
  });

  it("records the confirmation with the order-confirmation template", async () => {
    const envelope = orderConfirmed({ email: "buyer@example.com" });

    await deliver(envelope);

    expect(
      await prisma.notification.findMany({ where: { sourceEventId: envelope.id } }),
    ).toMatchObject([{ template: "order-confirmation" }]);
  });

  it("records a refund-initiated email and SMS for payment.refund_requested", async () => {
    const envelope = refundRequested({ email: "buyer+late@example.com", phone: "+36301234567" });

    const provider = await deliver(envelope);

    const rows = await prisma.notification.findMany({
      where: { sourceEventId: envelope.id },
      orderBy: { channel: "asc" },
    });
    expect(rows.map((row) => [row.channel, row.recipient, row.template, row.status])).toEqual([
      ["EMAIL", "buyer+late@example.com", "refund-initiated", "SENT"],
      ["SMS", "+36301234567", "refund-initiated", "SENT"],
    ]);
    expect(provider.deliveries().map((delivery) => delivery.template)).toEqual([
      "refund-initiated",
      "refund-initiated",
    ]);
  });

  it("records a refund-completed email for payment.refunded", async () => {
    const envelope = refunded({ email: "buyer+late@example.com" });

    const provider = await deliver(envelope);

    const rows = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(rows).toMatchObject([
      {
        channel: "EMAIL",
        recipient: "buyer+late@example.com",
        template: "refund-completed",
        status: "SENT",
        sentAt: NOW,
      },
    ]);
    expect(provider.deliveries()).toMatchObject([
      { idempotencyKey: rows[0]?.id, channel: "EMAIL", template: "refund-completed" },
    ]);
  });

  it.each([
    ["payment.refund_requested", refundRequested],
    ["payment.refunded", refunded],
  ])("acks a %s without a contact and records nothing", async (_type, build) => {
    const envelope = build();

    const provider = await deliver(envelope);

    expect(await prisma.notification.count({ where: { sourceEventId: envelope.id } })).toBe(0);
    expect(provider.deliveries()).toEqual([]);
    expect(
      await prisma.notificationProcessedMessage.count({
        where: { consumer: `notification-case${sequence}` },
      }),
    ).toBe(1);
  });
});

describe("AT-43: one notification record per channel for every final order outcome", () => {
  const contact = { email: "buyer@example.com", phone: "+36301234567" };
  const outcomes: [string, string, () => NotifiedEnvelope][] = [
    ["confirmed", "order-confirmation", () => orderConfirmed(contact)],
    ["cancelled", "order-cancellation", () => orderCancelled(contact)],
    ["expired", "order-expiry", () => orderExpired(contact)],
    ["refund initiated", "refund-initiated", () => refundRequested(contact)],
    ["refund completed", "refund-completed", () => refunded(contact)],
  ];

  it.each(outcomes)(
    "%s: a redelivery after a failed send and a duplicate copy leave one SENT record per channel",
    async (_outcome, template, build) => {
      const envelope = build();
      const recorded = createMockNotificationProvider();
      let failedOnce = false;
      const flaky: MockNotificationProvider = {
        ...recorded,
        send: async (message) => {
          if (!failedOnce) {
            failedOnce = true;
            throw new Error("provider down");
          }
          await recorded.send(message);
        },
      };
      sequence += 1;
      const subject = `ta.order.notification-case${sequence}`;
      const runner = await createConsumerRunner({
        bus,
        prisma,
        service: "notification",
        consumer: `notification-case${sequence}`,
        filterSubject: subject,
        retryDelayMs: () => 0,
        handler: createNotificationHandler({
          prisma,
          provider: flaky,
          clock: { now: () => NOW },
          newId: randomUUID,
        }),
      });

      // Redelivery: the first send fails, the runner naks, the same message comes back.
      await bus.publish({ subject, data: JSON.stringify(envelope), msgId: envelope.id });
      await expect
        .poll(
          async () => {
            await runner.pollOnce();
            return prisma.notification.count({
              where: { sourceEventId: envelope.id, status: "SENT" },
            });
          },
          { timeout: 10_000 },
        )
        .toBe(2);
      // Duplicate: the same event published again under another message id (`+dup@`).
      await bus.publish({ subject, data: JSON.stringify(envelope), msgId: `${envelope.id}-dup` });
      await runner.pollOnce();

      const rows = await prisma.notification.findMany({
        where: { sourceEventId: envelope.id },
        orderBy: { channel: "asc" },
      });
      expect(rows.map((row) => [row.channel, row.template, row.status])).toEqual([
        ["EMAIL", template, "SENT"],
        ["SMS", template, "SENT"],
      ]);
      expect(
        recorded
          .deliveries()
          .map((delivery) => delivery.idempotencyKey)
          .sort(),
      ).toEqual(rows.map((row) => row.id).sort());
    },
  );
});
