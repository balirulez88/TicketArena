import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    ...createNotificationHandler({
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

interface Settlement {
  readonly msgId: string | undefined;
  readonly streamSeq: number;
  readonly deliveryCount: number;
  readonly settled: "ack" | "nak" | "term";
}

/**
 * A notification consumer on a fresh subject with the envelope published once under its own id.
 * The bus is observed at the broker boundary, so a test sees how the runner settled each delivery
 * and that a redelivery is the same message; failures are redelivered without delay.
 */
async function redeliveringRunner(
  envelope: NotifiedEnvelope,
  provider: MockNotificationProvider,
  runnerPrisma: PrismaClient = prisma,
) {
  sequence += 1;
  const subject = `ta.order.notification-case${sequence}`;
  const settlements: Settlement[] = [];
  const observed: MessageBus = {
    ensureTopology: () => bus.ensureTopology(),
    publish: (input) => bus.publish(input),
    close: () => bus.close(),
    subscribe: async (spec) => {
      const subscription = await bus.subscribe(spec);
      return {
        fetch: async (options) =>
          (await subscription.fetch(options)).map((message) => {
            const record = (settled: Settlement["settled"]) =>
              settlements.push({
                msgId: message.msgId,
                streamSeq: message.streamSeq,
                deliveryCount: message.deliveryCount,
                settled,
              });
            return {
              ...message,
              ack: () => {
                record("ack");
                message.ack();
              },
              nak: (delayMs) => {
                record("nak");
                message.nak(delayMs);
              },
              term: (reason) => {
                record("term");
                message.term(reason);
              },
            };
          }),
      };
    },
  };
  const runner = await createConsumerRunner({
    bus: observed,
    prisma: runnerPrisma,
    service: "notification",
    consumer: `notification-case${sequence}`,
    filterSubject: subject,
    retryDelayMs: () => 0,
    ...createNotificationHandler({
      prisma: runnerPrisma,
      provider,
      clock: { now: () => NOW },
      newId: randomUUID,
    }),
  });
  await bus.publish({ subject, data: JSON.stringify(envelope), msgId: envelope.id });
  return { runner, settlements };
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

  it("TD-062: a failed send is nak'd, redelivered as the same message and resumes its PENDING record with the same key", async () => {
    const envelope = orderConfirmed({ email: "buyer@example.com" });
    const recorded = createMockNotificationProvider();
    let failures = 1;
    const flaky: MockNotificationProvider = {
      ...recorded,
      send: async (message) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("provider down");
        }
        await recorded.send(message);
      },
    };
    const { runner, settlements } = await redeliveringRunner(envelope, flaky);

    await runner.pollOnce();

    const pending = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(pending).toMatchObject([{ channel: "EMAIL", status: "PENDING", sentAt: null }]);

    await expect.poll(() => runner.pollOnce(), { timeout: 5_000 }).toBe(1);

    expect(settlements).toEqual([
      {
        msgId: envelope.id,
        streamSeq: settlements[0]?.streamSeq,
        deliveryCount: 1,
        settled: "nak",
      },
      {
        msgId: envelope.id,
        streamSeq: settlements[0]?.streamSeq,
        deliveryCount: 2,
        settled: "ack",
      },
    ]);
    const rows = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(rows).toMatchObject([{ id: pending[0]?.id, status: "SENT", sentAt: NOW }]);
    expect(recorded.deliveries()).toMatchObject([{ idempotencyKey: pending[0]?.id }]);
  });

  it("TD-062: an SMS that fails after the EMAIL was sent ends, after redelivery, with both SENT under the same keys and one delivery each", async () => {
    const envelope = orderConfirmed({ email: "buyer@example.com", phone: "+36301234567" });
    const recorded = createMockNotificationProvider();
    const calls: [string, string][] = [];
    let smsFailures = 1;
    const smsDown: MockNotificationProvider = {
      ...recorded,
      send: async (message) => {
        calls.push([message.channel, message.idempotencyKey]);
        if (message.channel === "SMS" && smsFailures > 0) {
          smsFailures -= 1;
          throw new Error("SMS gateway down");
        }
        await recorded.send(message);
      },
    };
    const { runner, settlements } = await redeliveringRunner(envelope, smsDown);

    await runner.pollOnce();

    // The EMAIL's SENT update rode the rolled-back transaction, so both records stay PENDING.
    const pending = await prisma.notification.findMany({
      where: { sourceEventId: envelope.id },
      orderBy: { channel: "asc" },
    });
    expect(pending.map((row) => [row.channel, row.status])).toEqual([
      ["EMAIL", "PENDING"],
      ["SMS", "PENDING"],
    ]);
    const [email, sms] = pending.map((row) => row.id);

    await expect.poll(() => runner.pollOnce(), { timeout: 5_000 }).toBe(1);

    expect(
      settlements.map(({ msgId, deliveryCount, settled }) => [msgId, deliveryCount, settled]),
    ).toEqual([
      [envelope.id, 1, "nak"],
      [envelope.id, 2, "ack"],
    ]);
    expect(settlements[1]?.streamSeq).toBe(settlements[0]?.streamSeq);
    const rows = await prisma.notification.findMany({
      where: { sourceEventId: envelope.id },
      orderBy: { channel: "asc" },
    });
    expect(rows.map((row) => [row.id, row.channel, row.status])).toEqual([
      [email, "EMAIL", "SENT"],
      [sms, "SMS", "SENT"],
    ]);
    // The EMAIL is offered again under its own key (at-least-once); the provider's key dedupe keeps
    // it to one delivery, so each channel is delivered exactly once.
    expect(calls).toEqual([
      ["EMAIL", email],
      ["SMS", sms],
      ["EMAIL", email],
      ["SMS", sms],
    ]);
    expect(
      recorded.deliveries().map((delivery) => [delivery.channel, delivery.idempotencyKey]),
    ).toEqual([
      ["EMAIL", email],
      ["SMS", sms],
    ]);
  });

  it("TD-051: sends and records every channel on the first delivery when the provider outlasts the transaction timeout", async () => {
    // The runner's interactive-transaction timeout is injected config of its Prisma client;
    // lowering it from Prisma's 5 s default keeps a real provider delay that exceeds it short.
    const runnerPrisma = createPrismaClient({
      connectionString: database.url,
      driver: "pg",
      transaction: { maxWaitMs: 2_000, timeoutMs: 500 },
    });
    try {
      const envelope = orderConfirmed({ email: "patient@example.com", phone: "+36301234567" });
      const recorded = createMockNotificationProvider();
      const slow: MockNotificationProvider = {
        ...recorded,
        send: async (message) => {
          await new Promise((resolve) => setTimeout(resolve, 900));
          await recorded.send(message);
        },
      };
      const { runner, settlements } = await redeliveringRunner(envelope, slow, runnerPrisma);

      await runner.pollOnce();

      // Acked on the first delivery: no transaction timed out, nothing was nak'd.
      expect(settlements.map(({ deliveryCount, settled }) => [deliveryCount, settled])).toEqual([
        [1, "ack"],
      ]);
      const rows = await prisma.notification.findMany({
        where: { sourceEventId: envelope.id },
        orderBy: { channel: "asc" },
      });
      expect(rows.map((row) => [row.channel, row.status, row.sentAt])).toEqual([
        ["EMAIL", "SENT", NOW],
        ["SMS", "SENT", NOW],
      ]);
      expect(
        recorded.deliveries().map((delivery) => [delivery.channel, delivery.idempotencyKey]),
      ).toEqual(rows.map((row) => [row.channel, row.id]));
    } finally {
      await runnerPrisma.$disconnect();
    }
  });

  it("TD-051: holds no database transaction open while the provider sends", async () => {
    // A distinct application_name lets pg_stat_activity single out the runner's connections.
    const applicationName = `notification_send_probe_${sequence}`;
    const url = new URL(database.url);
    url.searchParams.set("application_name", applicationName);
    const runnerPrisma = createPrismaClient({ connectionString: url.toString(), driver: "pg" });
    try {
      const envelope = orderConfirmed({ email: "observed@example.com", phone: "+36301234567" });
      const recorded = createMockNotificationProvider();
      const openTransactionsDuringSend: number[] = [];
      const probing: MockNotificationProvider = {
        ...recorded,
        send: async (message) => {
          const rows = await prisma.$queryRaw<{ open: bigint }[]>`
            SELECT count(*) AS open FROM pg_stat_activity
            WHERE application_name = ${applicationName} AND xact_start IS NOT NULL`;
          openTransactionsDuringSend.push(Number(rows[0]?.open ?? -1));
          await recorded.send(message);
        },
      };
      const { runner } = await redeliveringRunner(envelope, probing, runnerPrisma);

      await runner.pollOnce();

      expect(openTransactionsDuringSend).toEqual([0, 0]);
      expect(
        await prisma.notification.count({ where: { sourceEventId: envelope.id, status: "SENT" } }),
      ).toBe(2);
    } finally {
      await runnerPrisma.$disconnect();
    }
  });

  it("TD-051: a crash after the send but before the outcome is recorded is redelivered and leaves one sent notification per channel", async () => {
    const envelope = orderConfirmed({ email: "buyer@example.com", phone: "+36301234567" });
    const recorded = createMockNotificationProvider();
    const calls: [string, string][] = [];
    const provider: MockNotificationProvider = {
      ...recorded,
      send: async (message) => {
        calls.push([message.channel, message.idempotencyKey]);
        await recorded.send(message);
      },
    };
    // The database boundary fails the first runner transaction, i.e. the one that would record
    // the outcome: what a worker crash between the send and that commit leaves behind.
    let crashes = 1;
    const crashingPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === "$transaction" && crashes > 0) {
          crashes -= 1;
          return async () => {
            throw new Error("worker crashed before recording the outcome");
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { runner, settlements } = await redeliveringRunner(envelope, provider, crashingPrisma);

    await runner.pollOnce();

    // Sent, but the outcome was never recorded.
    const pending = await prisma.notification.findMany({
      where: { sourceEventId: envelope.id },
      orderBy: { channel: "asc" },
    });
    expect(pending.map((row) => [row.channel, row.status])).toEqual([
      ["EMAIL", "PENDING"],
      ["SMS", "PENDING"],
    ]);
    const [email, sms] = pending.map((row) => row.id);
    expect(recorded.deliveries()).toHaveLength(2);

    await expect.poll(() => runner.pollOnce(), { timeout: 5_000 }).toBe(1);

    expect(
      settlements.map(({ msgId, deliveryCount, settled }) => [msgId, deliveryCount, settled]),
    ).toEqual([
      [envelope.id, 1, "nak"],
      [envelope.id, 2, "ack"],
    ]);
    const rows = await prisma.notification.findMany({
      where: { sourceEventId: envelope.id },
      orderBy: { channel: "asc" },
    });
    expect(rows.map((row) => [row.id, row.channel, row.status])).toEqual([
      [email, "EMAIL", "SENT"],
      [sms, "SMS", "SENT"],
    ]);
    // The redelivery resends under the same keys; the provider's key dedupe keeps one each.
    expect(calls).toEqual([
      ["EMAIL", email],
      ["SMS", sms],
      ["EMAIL", email],
      ["SMS", sms],
    ]);
    expect(
      recorded.deliveries().map((delivery) => [delivery.channel, delivery.idempotencyKey]),
    ).toEqual([
      ["EMAIL", email],
      ["SMS", sms],
    ]);
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

  // Payment re-announces a refund under a new event id (the reconciler's re-emit, an operator
  // retry, a repeated request), so Booking can recover a lost confirmation. The buyer must still
  // hear about each refund step once per channel.
  it.each([
    ["payment.refund_requested", refundRequested, "refund-initiated"],
    ["payment.refunded", refunded, "refund-completed"],
  ])(
    "sends a %s once per channel when the same refund arrives again under a new event id",
    async (_type, build, template) => {
      const first = build({ email: "buyer+again@example.com", phone: "+36301234567" });
      const again = { ...first, id: randomUUID() };
      const provider = createMockNotificationProvider();

      await deliver(first, provider);
      await deliver(again, provider);

      expect(
        provider.deliveries().map((delivery) => [delivery.channel, delivery.template]),
      ).toEqual([
        ["EMAIL", template],
        ["SMS", template],
      ]);
      const rows = await prisma.notification.findMany({
        where: { sourceEventId: { in: [first.id, again.id] } },
      });
      expect(rows.map((row) => `${row.sourceEventId} ${row.status}`)).toEqual([
        `${first.id} SENT`,
        `${first.id} SENT`,
      ]);
    },
  );

  it.each([
    ["payment.refund_requested", refundRequested],
    ["payment.refunded", refunded],
  ])(
    "sends a %s once per channel when two event ids of the same refund are delivered concurrently",
    async (_type, build) => {
      const first = build({ email: "buyer+race@example.com", phone: "+36301234567" });
      const again = { ...first, id: randomUUID() };
      const provider = createMockNotificationProvider();

      await Promise.all([deliver(first, provider), deliver(again, provider)]);

      expect(
        provider
          .deliveries()
          .map((delivery) => delivery.channel)
          .sort(),
      ).toEqual(["EMAIL", "SMS"]);
      const rows = await prisma.notification.findMany({
        where: { sourceEventId: { in: [first.id, again.id] } },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.status === "SENT")).toBe(true);
    },
  );

  it("tells the buyer once that the refund started and once that it completed, with every step re-announced concurrently", async () => {
    const contact = { email: "buyer+both@example.com" };
    const started = refundRequested(contact);
    const startedAgain = { ...started, id: randomUUID() };
    const base = refunded(contact);
    const completed = {
      ...base,
      orderId: started.orderId,
      payload: { ...base.payload, orderId: started.orderId, paymentId: started.payload.paymentId },
    };
    const completedAgain = { ...completed, id: randomUUID() };
    const provider = createMockNotificationProvider();

    await Promise.all([
      deliver(started, provider),
      deliver(startedAgain, provider),
      deliver(completed, provider),
      deliver(completedAgain, provider),
    ]);

    expect(
      provider
        .deliveries()
        .map((delivery) => delivery.template)
        .sort(),
    ).toEqual(["refund-completed", "refund-initiated"]);
  });

  it("resumes a PENDING row an older worker wrote without a dedupe key, under its own key, instead of failing on a second row", async () => {
    const envelope = refunded({ email: "buyer+cutover@example.com" });
    const oldRowId = randomUUID();
    await prisma.notification.create({
      data: {
        id: oldRowId,
        sourceEventId: envelope.id,
        channel: "EMAIL",
        recipient: "buyer+cutover@example.com",
        template: "refund-completed",
        createdAt: NOW,
      },
    });

    const provider = await deliver(envelope);

    expect(provider.deliveries()).toMatchObject([{ idempotencyKey: oldRowId, channel: "EMAIL" }]);
    const rows = await prisma.notification.findMany({ where: { sourceEventId: envelope.id } });
    expect(rows.map((row) => [row.id, row.status])).toEqual([[oldRowId, "SENT"]]);
  });

  /** A PENDING refund-completed EMAIL row as a pre-migration worker left it: no dedupe key. */
  async function legacyPendingRow(envelope: ReturnType<typeof refunded>, recipient: string) {
    const id = randomUUID();
    await prisma.notification.create({
      data: {
        id,
        sourceEventId: envelope.id,
        channel: "EMAIL",
        recipient,
        template: "refund-completed",
        createdAt: NOW,
      },
    });
    return id;
  }

  async function rowsTo(recipient: string) {
    return prisma.notification.findMany({ where: { recipient } });
  }

  it("cutover: resuming an older worker's row gives it the refund key, so a later re-announcement under a new event id sends nothing new", async () => {
    const recipient = "buyer+cutover-again@example.com";
    const original = refunded({ email: recipient });
    const reannounced = { ...original, id: randomUUID() };
    const oldRowId = await legacyPendingRow(original, recipient);
    const provider = createMockNotificationProvider();

    await deliver(original, provider);
    await deliver(reannounced, provider);

    expect(provider.deliveries()).toEqual([
      {
        idempotencyKey: oldRowId,
        channel: "EMAIL",
        recipient,
        template: "refund-completed",
      },
    ]);
    expect((await rowsTo(recipient)).map((row) => [row.id, row.dedupeKey, row.status])).toEqual([
      [oldRowId, `refund:${original.payload.paymentId}:refund-completed`, "SENT"],
    ]);
  });

  it("cutover: a re-announcement arriving while the original is still sending reuses the promoted row and its original provider key", async () => {
    const recipient = "buyer+cutover-race@example.com";
    const original = refunded({ email: recipient });
    const reannounced = { ...original, id: randomUUID() };
    const oldRowId = await legacyPendingRow(original, recipient);
    const recorded = createMockNotificationProvider();
    let firstSendStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstSendStarted = resolve;
    });
    let releaseFirstSend: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let sends = 0;
    const provider: MockNotificationProvider = {
      deliveries: () => recorded.deliveries(),
      async send(message) {
        sends += 1;
        if (sends === 1) {
          firstSendStarted();
          await released;
        }
        await recorded.send(message);
      },
    };

    const originalDelivery = deliver(original, provider);
    await started;
    const reannouncedDelivery = deliver(reannounced, provider);
    await vi.waitFor(() => expect(sends).toBe(2), { timeout: 15_000 });
    releaseFirstSend();
    await Promise.all([originalDelivery, reannouncedDelivery]);

    expect(provider.deliveries().map((delivery) => delivery.idempotencyKey)).toEqual([oldRowId]);
    expect((await rowsTo(recipient)).map((row) => [row.id, row.status])).toEqual([
      [oldRowId, "SENT"],
    ]);
  });

  it("cutover: when another delivery already holds the refund key, the original event uses that winner and sends nothing under the old row", async () => {
    const recipient = "buyer+cutover-winner@example.com";
    const original = refunded({ email: recipient });
    const reannounced = { ...original, id: randomUUID() };
    const oldRowId = await legacyPendingRow(original, recipient);
    const provider = createMockNotificationProvider();

    await deliver(reannounced, provider);
    await deliver(original, provider);

    const rows = await rowsTo(recipient);
    const winner = rows.find((row) => row.sourceEventId === reannounced.id);
    expect(provider.deliveries().map((delivery) => delivery.idempotencyKey)).toEqual([winner?.id]);
    // The old row lost the key: it was never handed to the provider here, so it stays unchecked.
    expect(rows.find((row) => row.id === oldRowId)).toMatchObject({
      dedupeKey: null,
      status: "PENDING",
    });
  });

  it("keeps order events keyed by their own event id: two confirmations of different orders both send", async () => {
    const provider = createMockNotificationProvider();

    await deliver(orderConfirmed({ email: "buyer+one@example.com" }), provider);
    await deliver(orderConfirmed({ email: "buyer+two@example.com" }), provider);

    expect(provider.deliveries()).toHaveLength(2);
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
        ...createNotificationHandler({
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
