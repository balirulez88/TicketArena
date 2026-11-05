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

async function deliver(
  envelope: ReturnType<typeof orderConfirmed>,
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
});
