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

type Bindings = Record<string, unknown>;

/** Pino-shaped logger that records the bindings every line is written with. */
function recordingLogger() {
  const lines: Bindings[] = [];
  const make = (bound: Bindings) => {
    const write = (...args: unknown[]) => {
      const fields = typeof args[0] === "object" && args[0] !== null ? args[0] : {};
      lines.push({ ...bound, ...fields });
    };
    return {
      info: write,
      warn: write,
      error: write,
      debug: write,
      child: (bindings: Bindings) => make({ ...bound, ...bindings }),
    };
  };
  return { logger: make({}), lines };
}

describe("consumer runner logging", () => {
  it("logs every line about a message with the envelope's correlationId, causationId and ids", async () => {
    const { logger, lines } = recordingLogger();
    const correlationId = crypto.randomUUID();
    const causationId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const subject = "ta.order.logging1";
    const runner = await createConsumerRunner({
      bus,
      prisma,
      logger,
      consumer: "logging-consumer-1",
      filterSubject: subject,
      handler: () => Promise.resolve(),
    } as Parameters<typeof createConsumerRunner>[0]);
    await bus.publish({
      subject,
      msgId: id,
      data: JSON.stringify({
        id,
        type: "order.placed",
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId,
        causationId,
        orderId,
        payload: {},
      }),
    });

    await runner.pollOnce();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatchObject({ correlationId, causationId, orderId });
    }
  });
});
