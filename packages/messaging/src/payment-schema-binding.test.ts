import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  createOutboxRelay,
  type MessageBus,
} from "./index.js";

const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus;

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

describe("a service bound to the payment schema (ADR 0009)", () => {
  it("relays only the payment outbox and marks its rows PUBLISHED", async () => {
    const id = crypto.randomUUID();
    await prisma.paymentOutboxEvent.create({
      data: {
        id,
        aggregateType: "payment",
        aggregateId: crypto.randomUUID(),
        eventType: "payment.succeeded",
        payload: { id },
      },
    });
    const bookingRelay = createOutboxRelay({ bus, prisma });
    const paymentRelay = createOutboxRelay({ bus, prisma, service: "payment" });

    expect(await bookingRelay.tick()).toBe(0);
    expect(await paymentRelay.tick()).toBe(1);

    const row = await prisma.paymentOutboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("PUBLISHED");
    expect(row.publishedAt).toBeInstanceOf(Date);
  });

  it("dedupes in payment.processed_messages and writes caused events to the payment outbox", async () => {
    const subject = "ta.order.payment-binding";
    const cause = {
      id: crypto.randomUUID(),
      type: "order.placed",
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      causationId: null,
      payload: {},
    };
    const emittedId = crypto.randomUUID();
    const runner = await createConsumerRunner({
      bus,
      prisma,
      service: "payment",
      consumer: "payment-binding",
      filterSubject: subject,
      handler: async (_tx, _message, { emit }) => {
        await emit({
          id: emittedId,
          type: "payment.succeeded",
          version: 1,
          occurredAt: cause.occurredAt,
          aggregateType: "payment",
          aggregateId: crypto.randomUUID(),
          payload: {},
        });
      },
    });
    await bus.publish({ subject, data: JSON.stringify(cause), msgId: cause.id });

    await runner.pollOnce();

    expect(await prisma.paymentProcessedMessage.count({ where: { messageId: cause.id } })).toBe(1);
    expect(await prisma.processedMessage.count({ where: { messageId: cause.id } })).toBe(0);
    expect(await prisma.paymentOutboxEvent.count({ where: { id: emittedId } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { id: emittedId } })).toBe(0);
  });
});
