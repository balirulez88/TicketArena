import { envelopeSchema, orderPlacedPayloadSchema } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type DeadLetter,
  type MessageBus,
  type ReceivedMessage,
} from "./index.js";

// ADR 0011 DLQ routing against real NATS and Postgres: the DLQ gate before the handler, the
// publish to `ta.dlq.<consumer>` under `dlq:<consumer>:<envelope id>`, and `term` only after the
// PubAck.
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
  return { name: `dlq-${suffix}`, subject: `ta.order.dlq${suffix}` };
}

interface Settlement {
  readonly deliveryCount: number;
  readonly settled: "ack" | "nak" | "term";
  readonly delayMs?: number | undefined;
}

/**
 * The broker boundary, recording how each delivery was settled. A nak's delay is recorded and
 * collapsed to zero so a schedule of minutes is observable at once; `dropTerms` simulates a crash
 * after the DLQ PubAck and before `term` reaches the broker.
 */
function recordingBus(settlements: Settlement[], dropTerms = 0): MessageBus {
  let termsToDrop = dropTerms;
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
              working: () => message.working(),
              ack: () => {
                settlements.push({ deliveryCount: message.deliveryCount, settled: "ack" });
                message.ack();
              },
              nak: (delayMs) => {
                settlements.push({ deliveryCount: message.deliveryCount, settled: "nak", delayMs });
                message.nak(0);
              },
              term: (reason) => {
                settlements.push({ deliveryCount: message.deliveryCount, settled: "term" });
                if (termsToDrop > 0) {
                  termsToDrop -= 1;
                  return;
                }
                message.term(reason);
              },
            }),
          ),
      };
    },
  };
}

/** Every copy in the consumer's DLQ subject, read by a fresh inspection durable. */
async function dlqCopies(consumer: string): Promise<ReceivedMessage[]> {
  const inspector = await bus.subscribe({
    stream: "dlq",
    consumer: `inspect-${crypto.randomUUID().slice(0, 8)}`,
    filterSubject: `ta.dlq.${consumer}`,
  });
  return inspector.fetch({ maxMessages: 10, expiresMs: 1_000 });
}

function parseLetter(copy: ReceivedMessage | undefined): DeadLetter {
  if (copy === undefined) {
    throw new Error("no DLQ copy");
  }
  return JSON.parse(copy.data) as DeadLetter;
}

const orderPlacedSchemas = { 1: envelopeSchema(orderPlacedPayloadSchema) };

function orderPlaced(overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  return {
    id,
    type: "order.placed",
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: crypto.randomUUID(),
    causationId: null,
    payload: {
      orderId: crypto.randomUUID(),
      holdId: crypto.randomUUID(),
      amountMinor: 1200,
      currency: "EUR",
      paymentDeadline: new Date().toISOString(),
      contact: { email: "buyer@example.com" },
    },
    ...overrides,
  };
}

describe("the DLQ gate: retry budget (AT-28)", () => {
  it("dead-letters the 6th delivery without invoking the handler, carrying envelope, error and delivery count, then terms", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    let handled = 0;
    let steps = 0;
    const runner = await createConsumerRunner({
      bus: recordingBus(settlements),
      prisma,
      consumer: name,
      filterSubject: subject,
      beforeTransaction: async () => {
        steps += 1;
      },
      handler: () => {
        handled += 1;
        return Promise.reject(new Error("transient"));
      },
    });
    const id = crypto.randomUUID();
    const data = JSON.stringify({ id, hello: "world" });
    const published = await bus.publish({ subject, data, msgId: id });

    for (let delivery = 0; delivery < 6; delivery += 1) {
      await runner.pollOnce();
    }

    expect(handled).toBe(5);
    expect(steps).toBe(5);
    expect(settlements).toEqual([
      { deliveryCount: 1, settled: "nak", delayMs: 1_000 },
      { deliveryCount: 2, settled: "nak", delayMs: 5_000 },
      { deliveryCount: 3, settled: "nak", delayMs: 30_000 },
      { deliveryCount: 4, settled: "nak", delayMs: 120_000 },
      { deliveryCount: 5, settled: "nak", delayMs: 120_000 },
      { deliveryCount: 6, settled: "term" },
    ]);
    const copies = await dlqCopies(name);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.msgId).toBe(`dlq:${name}:${id}`);
    expect(copies[0]?.subject).toBe(`ta.dlq.${name}`);
    expect(parseLetter(copies[0])).toEqual({
      consumer: name,
      subject,
      streamSeq: published.streamSeq,
      deliveryCount: 6,
      error: { cause: "retry_budget_exhausted", message: expect.stringContaining("5") },
      envelope: data,
    });
    // Terminated: the main stream holds nothing more for this consumer.
    expect(await runner.pollOnce()).toBe(0);
  });

  it("creates no second DLQ entry when the process crashes between the DLQ publish and term", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    const options = {
      prisma,
      consumer: name,
      filterSubject: subject,
      // Longer than the runner's 1 s fetch window, so an expiry cannot happen inside one poll.
      ackWaitMs: 2_000,
      handler: () => Promise.reject(new Error("transient")),
    };
    const crashing = await createConsumerRunner({
      ...options,
      bus: recordingBus(settlements, 1),
    });
    const id = crypto.randomUUID();
    await bus.publish({ subject, data: "{}", msgId: id });
    for (let delivery = 0; delivery < 6; delivery += 1) {
      await crashing.pollOnce();
    }
    expect(settlements.at(-1)).toEqual({ deliveryCount: 6, settled: "term" });
    expect(await dlqCopies(name)).toHaveLength(1);

    // The lost term leaves the delivery unsettled; AckWait expires and a restarted runner gets it.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const restarted = await createConsumerRunner({ ...options, bus: recordingBus(settlements) });
    expect(await restarted.pollOnce()).toBe(1);

    expect(settlements.at(-1)).toEqual({ deliveryCount: 7, settled: "term" });
    const copies = await dlqCopies(name);
    expect(copies).toHaveLength(1);
    expect(parseLetter(copies[0]).deliveryCount).toBe(6);
    expect(await restarted.pollOnce()).toBe(0);
  });
});

describe("the DLQ gate: poison messages (AT-30)", () => {
  it("dead-letters a schema-invalid message on its first delivery without invoking the handler", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    let handled = 0;
    let steps = 0;
    const runner = await createConsumerRunner({
      bus: recordingBus(settlements),
      prisma,
      consumer: name,
      filterSubject: subject,
      schemas: orderPlacedSchemas,
      beforeTransaction: async () => {
        steps += 1;
      },
      handler: async () => {
        handled += 1;
        return undefined;
      },
    });
    const invalid = orderPlaced({ payload: { amountMinor: "twelve" } });
    const data = JSON.stringify(invalid);
    await bus.publish({ subject, data, msgId: invalid.id });

    await runner.pollOnce();

    expect(handled).toBe(0);
    expect(steps).toBe(0);
    expect(settlements).toEqual([{ deliveryCount: 1, settled: "term" }]);
    const copies = await dlqCopies(name);
    expect(copies.map((copy) => copy.msgId)).toEqual([`dlq:${name}:${invalid.id}`]);
    expect(parseLetter(copies[0])).toMatchObject({
      deliveryCount: 1,
      error: { cause: "schema_invalid" },
      envelope: data,
    });
    expect(await prisma.processedMessage.count({ where: { consumer: name } })).toBe(0);
  });

  it("dead-letters a message that is not JSON as schema-invalid", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    let handled = 0;
    const runner = await createConsumerRunner({
      bus: recordingBus(settlements),
      prisma,
      consumer: name,
      filterSubject: subject,
      schemas: orderPlacedSchemas,
      handler: async () => {
        handled += 1;
        return undefined;
      },
    });
    const id = crypto.randomUUID();
    await bus.publish({ subject, data: "not json", msgId: id });

    await runner.pollOnce();

    expect(handled).toBe(0);
    expect(settlements).toEqual([{ deliveryCount: 1, settled: "term" }]);
    expect(parseLetter((await dlqCopies(name))[0])).toMatchObject({
      error: { cause: "schema_invalid" },
      envelope: "not json",
    });
  });

  it("dead-letters an unknown envelope version on its first delivery without invoking the handler", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    let handled = 0;
    const runner = await createConsumerRunner({
      bus: recordingBus(settlements),
      prisma,
      consumer: name,
      filterSubject: subject,
      schemas: orderPlacedSchemas,
      handler: async () => {
        handled += 1;
        return undefined;
      },
    });
    const future = orderPlaced({ version: 2 });
    await bus.publish({ subject, data: JSON.stringify(future), msgId: future.id });

    await runner.pollOnce();

    expect(handled).toBe(0);
    expect(settlements).toEqual([{ deliveryCount: 1, settled: "term" }]);
    expect(parseLetter((await dlqCopies(name))[0])).toMatchObject({
      error: { cause: "unknown_version", message: expect.stringContaining("2") },
    });
  });

  it("hands a message valid for a known version to the handler", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    let handled = 0;
    const runner = await createConsumerRunner({
      bus: recordingBus(settlements),
      prisma,
      consumer: name,
      filterSubject: subject,
      schemas: orderPlacedSchemas,
      handler: async () => {
        handled += 1;
        return undefined;
      },
    });
    const valid = orderPlaced();
    await bus.publish({ subject, data: JSON.stringify(valid), msgId: valid.id });

    await runner.pollOnce();

    expect(handled).toBe(1);
    expect(settlements).toEqual([{ deliveryCount: 1, settled: "ack" }]);
    expect(await dlqCopies(name)).toEqual([]);
  });

  it("dead-letters a handler's poison outcome on its first delivery, rolling its transaction back", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    const id = crypto.randomUUID();
    const runner = await createConsumerRunner({
      bus: recordingBus(settlements),
      prisma,
      consumer: name,
      filterSubject: subject,
      handler: async (tx) => {
        await tx.outboxEvent.create({
          data: { id, aggregateType: "test", aggregateId: "a", eventType: "x", payload: {} },
        });
        return { outcome: "poison", reason: "unknown_order" };
      },
    });
    await bus.publish({ subject, data: "{}", msgId: id });

    await runner.pollOnce();

    expect(settlements).toEqual([{ deliveryCount: 1, settled: "term" }]);
    const copies = await dlqCopies(name);
    expect(copies.map((copy) => copy.msgId)).toEqual([`dlq:${name}:${id}`]);
    expect(parseLetter(copies[0])).toMatchObject({
      deliveryCount: 1,
      error: { cause: "handler_poison", message: "unknown_order" },
      envelope: "{}",
    });
    expect(await prisma.processedMessage.count({ where: { consumer: name } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { id } })).toBe(0);
  });
});
