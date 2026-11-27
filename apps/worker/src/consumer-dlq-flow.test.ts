import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type DeadLetter,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceConsumers } from "./consumers.js";

// Ticket 25 / AT-30 at the worker boundary: the consumers the worker registers carry their envelope
// schemas, so a malformed `order.placed` is dead-lettered on its first delivery and never reaches
// the payment provider step (`beforeTransaction`) or the handler.
const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let testCase = 0;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function orderPlaced() {
  const orderId = randomUUID();
  return {
    id: randomUUID(),
    type: "order.placed",
    version: 1,
    occurredAt: "2027-03-01T12:00:00.000Z",
    correlationId: randomUUID(),
    causationId: null,
    holdId: randomUUID(),
    orderId,
    payload: {
      orderId,
      holdId: randomUUID(),
      amountMinor: 12_500,
      currency: "EUR",
      paymentDeadline: "2027-03-01T12:05:00.000Z",
      contact: { email: "buyer@example.com" },
    },
  };
}

/** A bus on streams of this case's own, so the durable `payment` starts fresh each time. */
async function caseBus(): Promise<MessageBus> {
  testCase += 1;
  const bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: `${nats.streamPrefix}D${testCase}_`,
    subjectPrefix: `${nats.subjectPrefix}d${testCase}`,
  });
  await bus.ensureTopology();
  return bus;
}

/**
 * Delivers one `order.placed` body to the worker's real `payment` consumer and reports every
 * observable effect: provider calls (the `beforeTransaction` latency draw and wait), payment rows,
 * the DLQ copies, and whether the broker redelivers the message.
 */
async function deliverToPayment(orderId: string, envelopeId: string, body: object) {
  const bus = await caseBus();
  try {
    const providerCalls: string[] = [];
    const spec = createServiceConsumers({
      prisma,
      clock: {
        now: () => new Date("2027-03-01T12:01:00.000Z"),
        sleep: async (ms) => {
          providerCalls.push(`sleep:${ms}`);
        },
      },
      random: {
        next: () => {
          providerCalls.push("random");
          return 0;
        },
      },
      newId: randomUUID,
      latencyMs: { min: 10, max: 10 },
    }).find((candidate) => candidate.consumer === "payment");
    if (spec === undefined) {
      throw new Error("no payment consumer");
    }
    const runner = await createConsumerRunner({ ...spec, bus, prisma, retryDelayMs: () => 0 });
    await bus.publish({
      subject: "ta.order.placed",
      data: JSON.stringify(body),
      msgId: envelopeId,
    });

    expect(await runner.pollOnce()).toBe(1);
    const redelivered = await runner.pollOnce();

    const dlq = await bus.subscribe({
      stream: "dlq",
      consumer: "inspect",
      filterSubject: "ta.dlq.payment",
    });
    const copies = await dlq.fetch({ maxMessages: 10, expiresMs: 1_000 });
    return {
      providerCalls,
      redelivered,
      dlq: copies.map((copy) => {
        const letter: DeadLetter = JSON.parse(copy.data);
        return {
          msgId: copy.msgId,
          cause: letter.error.cause,
          deliveryCount: letter.deliveryCount,
          envelope: letter.envelope,
        };
      }),
      processed: await prisma.paymentProcessedMessage.count({ where: { messageId: envelopeId } }),
      attempts: await prisma.paymentAttempt.count({ where: { orderId } }),
      paymentEvents: await prisma.paymentOutboxEvent.count({
        where: { payload: { path: ["orderId"], equals: orderId } },
      }),
    };
  } finally {
    await bus.close();
  }
}

describe("the worker's payment consumer dead-letters a malformed order.placed on its first delivery", () => {
  it("dead-letters a schema-invalid order.placed without running beforeTransaction or the payment handler", async () => {
    const placed = orderPlaced();
    const invalid = { ...placed, payload: { ...placed.payload, amountMinor: "twelve" } };

    const result = await deliverToPayment(placed.orderId, placed.id, invalid);

    expect(result).toEqual({
      providerCalls: [],
      redelivered: 0,
      dlq: [
        {
          msgId: `dlq:payment:${placed.id}`,
          cause: "schema_invalid",
          deliveryCount: 1,
          envelope: JSON.stringify(invalid),
        },
      ],
      processed: 0,
      attempts: 0,
      paymentEvents: 0,
    });
  });

  it("dead-letters an order.placed of an unknown version without running beforeTransaction or the payment handler", async () => {
    const placed = orderPlaced();
    const future = { ...placed, version: 2 };

    const result = await deliverToPayment(placed.orderId, placed.id, future);

    expect(result).toEqual({
      providerCalls: [],
      redelivered: 0,
      dlq: [
        {
          msgId: `dlq:payment:${placed.id}`,
          cause: "unknown_version",
          deliveryCount: 1,
          envelope: JSON.stringify(future),
        },
      ],
      processed: 0,
      attempts: 0,
      paymentEvents: 0,
    });
  });

  it("still runs the provider step and the handler for a valid order.placed", async () => {
    const placed = orderPlaced();

    const result = await deliverToPayment(placed.orderId, placed.id, placed);

    expect(result.providerCalls).toContain("sleep:10");
    expect(result).toMatchObject({
      redelivered: 0,
      dlq: [],
      processed: 1,
      attempts: 1,
      paymentEvents: 1,
    });
  });
});
