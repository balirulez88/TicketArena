import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectJetStreamMessageBus, createOutboxRelay, type MessageBus } from "./index.js";

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

type Bindings = Record<string, unknown>;

function recordingLogger() {
  const lines: Bindings[] = [];
  const make = (bound: Bindings) => {
    const write = (fields: object) => {
      lines.push({ ...bound, ...fields });
    };
    return {
      info: write,
      warn: write,
      error: write,
      child: (bindings: Bindings) => make({ ...bound, ...bindings }),
    };
  };
  return { logger: make({}), lines };
}

describe("outbox relay logging", () => {
  it("logs a published row with the payload envelope's correlationId, causationId and ids", async () => {
    const { logger, lines } = recordingLogger();
    const id = crypto.randomUUID();
    const ids = {
      correlationId: crypto.randomUUID(),
      causationId: crypto.randomUUID(),
      holdId: crypto.randomUUID(),
      orderId: crypto.randomUUID(),
    };
    await prisma.outboxEvent.create({
      data: {
        id,
        aggregateType: "order",
        aggregateId: ids.orderId,
        eventType: "order.placed",
        payload: {
          id,
          type: "order.placed",
          version: 1,
          occurredAt: new Date().toISOString(),
          ...ids,
          payload: {},
        },
      },
    });

    await createOutboxRelay({ bus, prisma, logger }).tick();

    const mine = lines.filter((line) => line["outboxId"] === id);
    expect(mine.length).toBeGreaterThan(0);
    for (const line of mine) {
      expect(line).toMatchObject(ids);
    }
  });
});
