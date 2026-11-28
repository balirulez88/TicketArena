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

function newConsumer(): { name: string; subject: string } {
  const suffix = crypto.randomUUID().slice(0, 8);
  return { name: `retry-${suffix}`, subject: `ta.order.retry${suffix}` };
}

interface Nak {
  readonly deliveryCount: number;
  readonly delayMs: number | undefined;
}

/**
 * The broker boundary with the clock collapsed: it records the delay the runner asks for and
 * naks with no delay, so a schedule of minutes is observable in milliseconds. The delivery count
 * still comes from JetStream.
 */
function delayRecordingBus(naks: Nak[]): MessageBus {
  return {
    ensureTopology: () => bus.ensureTopology(),
    publish: (input) => bus.publish(input),
    close: () => bus.close(),
    subscribe: async (spec) => {
      const subscription = await bus.subscribe(spec);
      return {
        fetch: async (options) =>
          (await subscription.fetch(options)).map(
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
                naks.push({ deliveryCount: message.deliveryCount, delayMs });
                message.nak(0);
              },
            }),
          ),
      };
    },
  };
}

type Bindings = Record<string, unknown>;

/** Pino-shaped logger that records the fields of every line. */
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

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("consumer runner retry schedule (ADR 0011)", () => {
  // The 6th delivery is past the budget and goes to the DLQ instead (consumer-runner-dlq.test.ts).
  it("naks a transient handler failure with 1s, 5s, 30s, 2m by deliveryCount and keeps 2m for the 5th", async () => {
    const naks: Nak[] = [];
    const { name, subject } = newConsumer();
    const runner = await createConsumerRunner({
      bus: delayRecordingBus(naks),
      prisma,
      consumer: name,
      filterSubject: subject,
      handler: () => Promise.reject(new Error("transient")),
    });
    await bus.publish({ subject, data: "{}", msgId: crypto.randomUUID() });

    for (let delivery = 0; delivery < 5; delivery += 1) {
      await runner.pollOnce();
    }

    expect(naks).toEqual([
      { deliveryCount: 1, delayMs: 1_000 },
      { deliveryCount: 2, delayMs: 5_000 },
      { deliveryCount: 3, delayMs: 30_000 },
      { deliveryCount: 4, delayMs: 120_000 },
      { deliveryCount: 5, delayMs: 120_000 },
    ]);
  });

  it("logs the chosen delay with the handler failure", async () => {
    const { logger, lines } = recordingLogger();
    const { name, subject } = newConsumer();
    const runner = await createConsumerRunner({
      bus: delayRecordingBus([]),
      prisma,
      logger,
      consumer: name,
      filterSubject: subject,
      handler: () => Promise.reject(new Error("transient")),
    });
    await bus.publish({ subject, data: "{}", msgId: crypto.randomUUID() });

    await runner.pollOnce();

    expect(lines.find((line) => line["msg"] === "handler failed; retrying")).toMatchObject({
      level: "error",
      deliveryCount: 1,
      delayMs: 1_000,
    });
  });

  it("takes the attempt from deliveryCount alone: an AckWait expiry and a new runner advance the schedule", async () => {
    const naks: Nak[] = [];
    const { name, subject } = newConsumer();
    // Longer than the runner's 1 s fetch window, so an expiry cannot happen inside one poll.
    const spec = {
      stream: "main",
      consumer: name,
      filterSubject: subject,
      ackWaitMs: 2_000,
    } as const;
    const options = {
      bus: delayRecordingBus(naks),
      prisma,
      consumer: name,
      filterSubject: subject,
      ackWaitMs: 2_000,
      handler: () => Promise.reject(new Error("transient")),
    };
    await bus.publish({ subject, data: "{}", msgId: crypto.randomUUID() });
    // A worker that crashed mid-message: it took delivery 1 and never settled it.
    const crashed = await bus.subscribe(spec);
    expect(await crashed.fetch({ maxMessages: 1, expiresMs: 1_000 })).toHaveLength(1);
    await sleepMs(2_200);

    await (await createConsumerRunner(options)).pollOnce();
    await (await createConsumerRunner(options)).pollOnce();

    expect(naks).toEqual([
      { deliveryCount: 2, delayMs: 5_000 },
      { deliveryCount: 3, delayMs: 30_000 },
    ]);
  });

  it("lets a long handler call working() so the message is not redelivered while it runs", async () => {
    const { name, subject } = newConsumer();
    const spec = {
      stream: "main",
      consumer: name,
      filterSubject: subject,
      ackWaitMs: 2_000,
    } as const;
    const rival = await bus.subscribe(spec);
    let rivalFetch: Promise<ReceivedMessage[]> | undefined;
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: name,
      filterSubject: subject,
      ackWaitMs: 2_000,
      handler: async (_tx, message) => {
        // A second worker on the same durable would receive the message if AckWait expired.
        rivalFetch = rival.fetch({ maxMessages: 1, expiresMs: 3_000 });
        // Outlasts AckWait (2 s) even after the 1 s fetch window the message already waited.
        for (let elapsed = 0; elapsed < 3_000; elapsed += 250) {
          message.working();
          await sleepMs(250);
        }
        return undefined;
      },
    });
    const id = crypto.randomUUID();
    await bus.publish({ subject, data: "{}", msgId: id });

    expect(await runner.pollOnce()).toBe(1);

    expect(await rivalFetch).toEqual([]);
    expect(await prisma.processedMessage.count({ where: { consumer: name, messageId: id } })).toBe(
      1,
    );
  });

  it("redelivers a transient failure after the scheduled delay and succeeds on a later attempt (AT-27)", async () => {
    const { name, subject } = newConsumer();
    const deliveredAt: number[] = [];
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: name,
      filterSubject: subject,
      handler: async (_tx, message) => {
        deliveredAt.push(Date.now());
        if (message.deliveryCount === 1) {
          throw new Error("provider timeout");
        }
        return undefined;
      },
    });
    const id = crypto.randomUUID();
    await bus.publish({ subject, data: "{}", msgId: id });

    runner.start();
    try {
      await vi.waitFor(
        async () =>
          expect(
            await prisma.processedMessage.count({ where: { consumer: name, messageId: id } }),
          ).toBe(1),
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      await runner.stop();
    }

    expect(deliveredAt).toHaveLength(2);
    const [first = 0, second = 0] = deliveredAt;
    // The broker held the message for the first scheduled delay (1s) before redelivering it.
    expect(second - first).toBeGreaterThanOrEqual(1_000);
  });
});
