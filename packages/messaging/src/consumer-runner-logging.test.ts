import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
  type ReceivedMessage,
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

type Bindings = Record<string, unknown>;

/** Pino-shaped logger that records the bindings every line is written with. */
function recordingLogger() {
  const lines: Bindings[] = [];
  const make = (bound: Bindings) => {
    const writer =
      (level: string) =>
      (...args: unknown[]) => {
        const fields = typeof args[0] === "object" && args[0] !== null ? args[0] : {};
        const msg = typeof args[1] === "string" ? { msg: args[1] } : {};
        lines.push({ ...bound, ...fields, level, ...msg });
      };
    return {
      info: writer("info"),
      warn: writer("warn"),
      error: writer("error"),
      debug: writer("debug"),
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

  it("logs a failed fetch at error with the cause and keeps polling (TD-032)", async () => {
    const { logger, lines } = recordingLogger();
    const broker = { down: true, fetches: 0 };
    // The broker boundary with a switchable outage: fetches reject while it is down.
    const flakyBus: MessageBus = {
      ensureTopology: () => bus.ensureTopology(),
      publish: (input) => bus.publish(input),
      close: () => bus.close(),
      subscribe: async (spec) => {
        const subscription = await bus.subscribe(spec);
        return {
          fetch: (fetchOptions) => {
            broker.fetches += 1;
            return broker.down
              ? Promise.reject(new Error("CONNECTION_REFUSED"))
              : subscription.fetch(fetchOptions);
          },
        };
      },
    };
    const handled: string[] = [];
    const subject = "ta.order.logging2";
    const runner = await createConsumerRunner({
      bus: flakyBus,
      prisma,
      logger,
      consumer: "logging-consumer-2",
      filterSubject: subject,
      handler: (_tx, message) => {
        handled.push(message.msgId ?? "");
        return Promise.resolve(undefined);
      },
    });

    runner.start();
    try {
      await vi.waitFor(() =>
        expect(lines.filter((line) => line["msg"] === "consumer poll failed")).toHaveLength(1),
      );
      const [failure] = lines.filter((line) => line["msg"] === "consumer poll failed");
      expect(failure).toMatchObject({ level: "error", consumer: "logging-consumer-2" });
      expect(failure?.["err"]).toMatchObject({ message: "CONNECTION_REFUSED" });

      broker.down = false;
      const id = crypto.randomUUID();
      await bus.publish({ subject, msgId: id, data: JSON.stringify({}) });
      await vi.waitFor(() => expect(handled).toContain(id), { timeout: 10_000 });
      expect(broker.fetches).toBeGreaterThan(1);
    } finally {
      await runner.stop();
    }
  });

  it("logs a handler failure at error with the error and the delivery count before the nak (TD-032)", async () => {
    const { logger, lines } = recordingLogger();
    // Records the nak into the same timeline as the log lines, so the order is observable.
    const recordingBus: MessageBus = {
      ensureTopology: () => bus.ensureTopology(),
      publish: (input) => bus.publish(input),
      close: () => bus.close(),
      subscribe: async (spec) => {
        const subscription = await bus.subscribe(spec);
        return {
          fetch: async (fetchOptions) =>
            (await subscription.fetch(fetchOptions)).map(
              (message): ReceivedMessage => ({
                subject: message.subject,
                data: message.data,
                msgId: message.msgId,
                streamSeq: message.streamSeq,
                deliveryCount: message.deliveryCount,
                ack: () => message.ack(),
                term: (reason) => message.term(reason),
                working: () => message.working(),
                nak: (delayMs) => {
                  lines.push({ event: "nak", delayMs });
                  message.nak(delayMs);
                },
              }),
            ),
        };
      },
    };
    const subject = "ta.order.logging3";
    const runner = await createConsumerRunner({
      bus: recordingBus,
      prisma,
      logger,
      consumer: "logging-consumer-3",
      filterSubject: subject,
      handler: () => Promise.reject(new Error("handler exploded")),
    });
    const id = crypto.randomUUID();
    await bus.publish({ subject, msgId: id, data: JSON.stringify({}) });

    await runner.pollOnce();

    const failureIndex = lines.findIndex((line) => line["msg"] === "handler failed; retrying");
    const nakIndex = lines.findIndex((line) => line["event"] === "nak");
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(nakIndex).toBeGreaterThan(failureIndex);
    const failure = lines[failureIndex];
    expect(failure).toMatchObject({ level: "error", messageId: id, deliveryCount: 1 });
    expect(failure?.["err"]).toMatchObject({ message: "handler exploded" });
  });
});
