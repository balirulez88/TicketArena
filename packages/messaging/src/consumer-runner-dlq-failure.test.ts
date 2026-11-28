import { jetstream } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
  type ReceivedMessage,
} from "./index.js";

// AT-29 against real NATS: the DLQ stream is declared too small for any copy, so the broker
// rejects every DLQ publish (`maximum bytes exceeded`), as it would for a full DLQ.
const database = setupTestDatabase();
const nats = setupTestNats();
const TOO_SMALL_FOR_A_COPY = 16;

let prisma: PrismaClient;
let bus: MessageBus;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
    streamMaxBytes: { dlq: TOO_SMALL_FOR_A_COPY },
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

interface Settlement {
  readonly deliveryCount: number;
  readonly settled: "ack" | "nak" | "term";
  readonly delayMs?: number | undefined;
}

/** Records each settlement; a nak's delay is recorded and collapsed so redelivery is immediate. */
function recordingBus(settlements: Settlement[]): MessageBus {
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
              ...message,
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
                message.term(reason);
              },
            }),
          ),
      };
    },
  };
}

describe("a failed DLQ publish (AT-29)", () => {
  // Runs first: the test below restores the DLQ to its production size.
  it("naks a message without a Nats-Msg-Id with 2 minutes and never terms it while its DLQ copy is unconfirmed", async () => {
    const settlements: Settlement[] = [];
    const suffix = crypto.randomUUID().slice(0, 8);
    const name = `dlq-fail-${suffix}`;
    const subject = `ta.order.dlqfail${suffix}`;
    let handled = 0;
    const runner = await createConsumerRunner({
      bus: recordingBus(settlements),
      prisma,
      consumer: name,
      filterSubject: subject,
      handler: async () => {
        handled += 1;
        return undefined;
      },
    });
    const connection = await connect({ servers: nats.url });
    try {
      await jetstream(connection).publish(`${nats.subjectPrefix}.${subject}`, "anonymous");
    } finally {
      await connection.close();
    }

    await runner.pollOnce();
    await runner.pollOnce();

    expect(handled).toBe(0);
    expect(settlements).toEqual([
      { deliveryCount: 1, settled: "nak", delayMs: 120_000 },
      { deliveryCount: 2, settled: "nak", delayMs: 120_000 },
    ]);
  });

  it("naks the message with 2 minutes and never terms it, so it is redelivered and dead-lettered once the DLQ accepts it", async () => {
    const settlements: Settlement[] = [];
    const suffix = crypto.randomUUID().slice(0, 8);
    const name = `dlq-fail-${suffix}`;
    const subject = `ta.order.dlqfail${suffix}`;
    const runner = await createConsumerRunner({
      bus: recordingBus(settlements),
      prisma,
      consumer: name,
      filterSubject: subject,
      handler: async () => ({ outcome: "poison", reason: "unknown_order" }),
    });
    const id = crypto.randomUUID();
    await bus.publish({ subject, data: "{}", msgId: id });

    await runner.pollOnce();
    await runner.pollOnce();

    expect(settlements).toEqual([
      { deliveryCount: 1, settled: "nak", delayMs: 120_000 },
      { deliveryCount: 2, settled: "nak", delayMs: 120_000 },
    ]);

    // The DLQ gets its production size back (the topology is converged in place).
    const sized = await connectJetStreamMessageBus({
      servers: nats.url,
      streamPrefix: nats.streamPrefix,
      subjectPrefix: nats.subjectPrefix,
    });
    try {
      await sized.ensureTopology();
    } finally {
      await sized.close();
    }
    await runner.pollOnce();

    expect(settlements.at(-1)).toEqual({ deliveryCount: 3, settled: "term" });
    const inspector = await bus.subscribe({
      stream: "dlq",
      consumer: `inspect-${suffix}`,
      filterSubject: `ta.dlq.${name}`,
    });
    const copies = await inspector.fetch({ maxMessages: 10, expiresMs: 1_000 });
    expect(copies.map((copy) => copy.msgId)).toEqual([`dlq:${name}:${id}`]);
  });
});
