import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectJetStreamMessageBus, createConsumerRunner, type MessageBus } from "./index.js";

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

function incoming(overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  return {
    id,
    body: {
      id,
      type: "order.placed",
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      causationId: null,
      orderId: crypto.randomUUID(),
      payload: {},
      ...overrides,
    },
  };
}

describe("events written while handling a message", () => {
  it("carry causationId = the handled message's id and the unchanged correlationId", async () => {
    const subject = "ta.order.causation1";
    const message = incoming();
    const emittedId = crypto.randomUUID();
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: "causation-consumer-1",
      filterSubject: subject,
      handler: async (_tx, _message, { emit }) => {
        await emit({
          id: emittedId,
          type: "payment.requested",
          version: 1,
          occurredAt: new Date().toISOString(),
          aggregateType: "order",
          aggregateId: message.body.orderId as string,
          orderId: message.body.orderId as string,
          payload: {},
        });
      },
    });
    await bus.publish({ subject, msgId: message.id, data: JSON.stringify(message.body) });

    await runner.pollOnce();

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: emittedId } });
    expect(row.payload).toMatchObject({
      id: emittedId,
      causationId: message.id,
      correlationId: message.body.correlationId,
      orderId: message.body.orderId,
    });
  });

  it("are rolled back with the handler: a failing handler leaves no outbox row", async () => {
    const subject = "ta.order.causation2";
    const message = incoming();
    const emittedId = crypto.randomUUID();
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: "causation-consumer-2",
      filterSubject: subject,
      retryDelayMs: () => 60_000,
      handler: async (_tx, _message, { emit }) => {
        await emit({
          id: emittedId,
          type: "payment.requested",
          version: 1,
          occurredAt: new Date().toISOString(),
          aggregateType: "order",
          aggregateId: crypto.randomUUID(),
          payload: {},
        });
        throw new Error("boom");
      },
    });
    await bus.publish({ subject, msgId: message.id, data: JSON.stringify(message.body) });

    await runner.pollOnce();

    expect(await prisma.outboxEvent.findUnique({ where: { id: emittedId } })).toBeNull();
  });

  it("cannot be written for a message that is not a valid envelope", async () => {
    const subject = "ta.order.causation3";
    const id = crypto.randomUUID();
    let failure: unknown;
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: "causation-consumer-3",
      filterSubject: subject,
      retryDelayMs: () => 60_000,
      handler: async (_tx, _message, { emit }) => {
        try {
          await emit({
            id: crypto.randomUUID(),
            type: "x",
            version: 1,
            occurredAt: new Date().toISOString(),
            aggregateType: "order",
            aggregateId: "a",
            payload: {},
          });
        } catch (error) {
          failure = error;
        }
      },
    });
    await bus.publish({ subject, msgId: id, data: "not json" });

    await runner.pollOnce();

    expect(String(failure)).toContain("not a valid envelope");
  });
});
