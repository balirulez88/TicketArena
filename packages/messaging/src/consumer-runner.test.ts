import { jetstream } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(async () => {
  await prisma.processedMessage.deleteMany();
  await prisma.outboxEvent.deleteMany();
});

function newConsumer(): { name: string; subject: string } {
  sequence += 1;
  return { name: `consumer-${sequence}`, subject: `ta.order.case${sequence}` };
}

/** A side effect the handler commits with its dedupe row: one outbox row per message id. */
const recordSideEffect = (message: ReceivedMessage, tx: Pick<PrismaClient, "outboxEvent">) =>
  tx.outboxEvent.create({
    data: {
      id: message.msgId ?? "",
      aggregateType: "test",
      aggregateId: "a",
      eventType: "x",
      payload: {},
    },
  });

const newUuid = () => crypto.randomUUID();

describe("consumer runner", () => {
  it("records processed_messages(consumer, messageId, streamSeq) in the handler's transaction and acks", async () => {
    const { name, subject } = newConsumer();
    const id = newUuid();
    const seen: string[] = [];
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: name,
      filterSubject: subject,
      handler: async (tx, message) => {
        seen.push(message.data);
        await recordSideEffect(message, tx);
      },
    });
    const published = await bus.publish({ subject, data: "hello", msgId: id });

    await runner.pollOnce();
    await runner.pollOnce();

    expect(seen).toEqual(["hello"]);
    const rows = await prisma.processedMessage.findMany({ where: { consumer: name } });
    expect(rows).toMatchObject([
      { consumer: name, messageId: id, streamSeq: BigInt(published.streamSeq) },
    ]);
    expect(await prisma.outboxEvent.count({ where: { id } })).toBe(1);
  });

  it("rolls back the dedupe row when the handler fails and redelivers the message", async () => {
    const { name, subject } = newConsumer();
    const id = newUuid();
    let attempts = 0;
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: name,
      filterSubject: subject,
      retryDelayMs: () => 0,
      handler: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient");
        }
      },
    });
    await bus.publish({ subject, data: "x", msgId: id });

    await runner.pollOnce();
    expect(await prisma.processedMessage.count({ where: { consumer: name } })).toBe(0);
    await runner.pollOnce();

    expect(attempts).toBe(2);
    expect(await prisma.processedMessage.count({ where: { consumer: name } })).toBe(1);
  });

  it("does not ack a unique violation raised by the handler's own writes", async () => {
    const { name, subject } = newConsumer();
    const id = newUuid();
    let attempts = 0;
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: name,
      filterSubject: subject,
      retryDelayMs: () => 0,
      handler: async (tx, message) => {
        attempts += 1;
        await recordSideEffect(message, tx);
        await recordSideEffect(message, tx);
      },
    });
    await bus.publish({ subject, data: "x", msgId: id });

    await runner.pollOnce();
    await runner.pollOnce();

    // Redelivered, not swallowed as a duplicate; nothing committed.
    expect(attempts).toBe(2);
    expect(await prisma.processedMessage.count({ where: { consumer: name } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { id } })).toBe(0);
  });

  it("never processes a message without a Nats-Msg-Id under a shared dedupe key", async () => {
    const { name, subject } = newConsumer();
    let calls = 0;
    const runner = await createConsumerRunner({
      bus,
      prisma,
      consumer: name,
      filterSubject: subject,
      ackWaitMs: 500,
      handler: async () => {
        calls += 1;
      },
    });
    const connection = await connect({ servers: nats.url });
    try {
      await jetstream(connection).publish(`${nats.subjectPrefix}.${subject}`, "anonymous");
      await jetstream(connection).publish(`${nats.subjectPrefix}.${subject}`, "anonymous-2");
    } finally {
      await connection.close();
    }

    await runner.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await runner.pollOnce();

    expect(calls).toBe(0);
    expect(await prisma.processedMessage.count({ where: { consumer: name } })).toBe(0);
  });

  it("acks a redelivery after a crash between commit and ack as a duplicate (AT-31)", async () => {
    const { name, subject } = newConsumer();
    const id = newUuid();
    let acksToDrop = 1;
    const deliveryCounts: number[] = [];
    // The crash is simulated at the broker boundary: the commit happened, the ack never arrives.
    const crashingBus: MessageBus = {
      ...bus,
      ensureTopology: () => bus.ensureTopology(),
      publish: (input) => bus.publish(input),
      close: () => bus.close(),
      subscribe: async (spec) => {
        const subscription = await bus.subscribe(spec);
        return {
          fetch: async (options) =>
            (await subscription.fetch(options)).map((message) => {
              deliveryCounts.push(message.deliveryCount);
              return {
                ...message,
                ack: () => {
                  if (acksToDrop > 0) {
                    acksToDrop -= 1;
                    return;
                  }
                  message.ack();
                },
              };
            }),
        };
      },
    };
    let sideEffects = 0;
    const runner = await createConsumerRunner({
      bus: crashingBus,
      prisma,
      consumer: name,
      filterSubject: subject,
      ackWaitMs: 500,
      handler: async (tx, message) => {
        sideEffects += 1;
        await recordSideEffect(message, tx);
      },
    });
    await bus.publish({ subject, data: "x", msgId: id });

    await runner.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await runner.pollOnce();
    const afterwards = await runner.pollOnce();

    // JetStream really redelivered it (count 2) and the runner acked it, so nothing is left.
    expect(deliveryCounts).toEqual([1, 2]);
    expect(afterwards).toBe(0);
    expect(sideEffects).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { id } })).toBe(1);
    expect(await prisma.processedMessage.count({ where: { consumer: name } })).toBe(1);
  });
});
