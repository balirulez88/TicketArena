import { jetstream } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { envelopeSchema, orderPlacedPayloadSchema } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  DEAD_LETTER_HEADERS,
  type DeadLetter,
  type MessageBus,
  type ReceivedMessage,
  readDeadLetters,
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
    maxPayloadBytes: () => bus.maxPayloadBytes?.(),
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
  const [letter] = readDeadLetters([copy]);
  if (letter === undefined) {
    throw new Error("no dead letter in the DLQ copy");
  }
  return letter;
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

describe("preserving what the envelope id cannot name or a wrapper cannot fit", () => {
  it("dead-letters a message without a Nats-Msg-Id under an id derived from its stream sequence, once across a crash before term", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    let handled = 0;
    const options = {
      prisma,
      consumer: name,
      filterSubject: subject,
      // Longer than the runner's 1 s fetch window, so an expiry cannot happen inside one poll.
      ackWaitMs: 2_000,
      handler: async () => {
        handled += 1;
        return undefined;
      },
    };
    const crashing = await createConsumerRunner({ ...options, bus: recordingBus(settlements, 1) });
    const connection = await connect({ servers: nats.url });
    let streamSeq: number;
    try {
      const ack = await jetstream(connection).publish(
        `${nats.subjectPrefix}.${subject}`,
        "anonymous",
      );
      streamSeq = ack.seq;
    } finally {
      await connection.close();
    }

    await crashing.pollOnce();

    expect(handled).toBe(0);
    expect(settlements).toEqual([{ deliveryCount: 1, settled: "term" }]);
    const first = await dlqCopies(name);
    expect(first).toHaveLength(1);
    const dlqId = first[0]?.msgId;
    expect(dlqId).toMatch(new RegExp(`^dlq:${name}:main:${streamSeq}:[0-9a-f]+$`));
    expect(parseLetter(first[0])).toEqual({
      consumer: name,
      subject,
      streamSeq,
      deliveryCount: 1,
      error: { cause: "missing_msg_id", message: expect.stringContaining("Nats-Msg-Id") },
      envelope: "anonymous",
    });

    // The lost term leaves the delivery unsettled; AckWait expires and a restarted runner gets it.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const restarted = await createConsumerRunner({ ...options, bus: recordingBus(settlements) });
    expect(await restarted.pollOnce()).toBe(1);

    expect(settlements.at(-1)).toEqual({ deliveryCount: 2, settled: "term" });
    const after = await dlqCopies(name);
    expect(after.map((copy) => copy.msgId)).toEqual([dlqId]);
    expect(handled).toBe(0);
    expect(await restarted.pollOnce()).toBe(0);
  });

  it("preserves a message just under the broker's max_payload in full before term, once across a crash before term", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    const options = {
      prisma,
      consumer: name,
      filterSubject: subject,
      ackWaitMs: 2_000,
      handler: async () => ({ outcome: "poison" as const, reason: "unknown_order" }),
    };
    const crashing = await createConsumerRunner({ ...options, bus: recordingBus(settlements, 1) });
    const connection = await connect({ servers: nats.url });
    const maxPayload = connection.info?.max_payload ?? 0;
    await connection.close();
    expect(maxPayload).toBeGreaterThan(0);
    const id = crypto.randomUUID();
    // The original fits with its own `Nats-Msg-Id` header (about 60 bytes), with no room for any
    // metadata beside it. Multi-byte characters, so a split must respect character boundaries.
    const size = maxPayload - 100;
    const head = JSON.stringify({ id, pad: "" });
    const padBytes = size - Buffer.byteLength(head);
    const pad =
      "é".repeat(Math.floor(padBytes / 4)) + "x".repeat(padBytes - 2 * Math.floor(padBytes / 4));
    const data = JSON.stringify({ id, pad });
    expect(Buffer.byteLength(data)).toBe(size);
    const published = await bus.publish({ subject, data, msgId: id });

    await crashing.pollOnce();

    expect(settlements).toEqual([{ deliveryCount: 1, settled: "term" }]);
    const expected = {
      consumer: name,
      subject,
      streamSeq: published.streamSeq,
      deliveryCount: 1,
      error: { cause: "handler_poison", message: "unknown_order" },
      envelope: data,
    };
    const first = await dlqCopies(name);
    expect(readDeadLetters(first)).toEqual([expected]);
    expect(first.every((copy) => copy.msgId?.startsWith(`dlq:${name}:${id}`))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const restarted = await createConsumerRunner({ ...options, bus: recordingBus(settlements) });
    expect(await restarted.pollOnce()).toBe(1);

    expect(settlements.at(-1)).toEqual({ deliveryCount: 2, settled: "term" });
    const after = await dlqCopies(name);
    expect(after.map((copy) => copy.msgId)).toEqual(first.map((copy) => copy.msgId));
    expect(readDeadLetters(after)).toEqual([expected]);
  });

  it("reconstructs the exact original when only part 1 was stored and max_payload changed before the retry, with the same number of parts", async () => {
    const settlements: Settlement[] = [];
    const { name, subject } = newConsumer();
    // The limit the bus reports, standing in for a broker whose max_payload was reconfigured
    // between deliveries. Both limits split this message into two parts at different offsets.
    let reportedLimit = 8 * 1024 + 12_000;
    let failPart2 = true;
    const recording = recordingBus(settlements);
    const flakyBus: MessageBus = {
      ...recording,
      maxPayloadBytes: () => reportedLimit,
      publish: async (input) => {
        if (failPart2 && input.headers?.[DEAD_LETTER_HEADERS.part]?.startsWith("2/")) {
          failPart2 = false;
          throw new Error("broker unavailable while publishing part 2");
        }
        return bus.publish(input);
      },
    };
    const runner = await createConsumerRunner({
      bus: flakyBus,
      prisma,
      consumer: name,
      filterSubject: subject,
      handler: async () => ({ outcome: "poison" as const, reason: "unknown_order" }),
    });
    const id = crypto.randomUUID();
    const data = JSON.stringify({ id, pad: "é".repeat(4_000) + "x".repeat(12_000) });
    expect(Buffer.byteLength(data)).toBeGreaterThan(15_000);
    expect(Buffer.byteLength(data)).toBeLessThan(24_000);
    const published = await bus.publish({ subject, data, msgId: id });

    await runner.pollOnce();
    expect(settlements).toEqual([{ deliveryCount: 1, settled: "nak", delayMs: 120_000 }]);
    expect((await dlqCopies(name)).map((copy) => copy.headers?.[DEAD_LETTER_HEADERS.part])).toEqual(
      ["1/2"],
    );

    reportedLimit = 8 * 1024 + 15_000;
    await runner.pollOnce();

    expect(settlements.at(-1)).toEqual({ deliveryCount: 2, settled: "term" });
    const copies = await dlqCopies(name);
    expect(readDeadLetters(copies)).toEqual([
      {
        consumer: name,
        subject,
        streamSeq: published.streamSeq,
        deliveryCount: 2,
        error: { cause: "handler_poison", message: "unknown_order" },
        envelope: data,
      },
    ]);
  });
});
