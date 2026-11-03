import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPaymentHandler } from "./payment-handler.js";

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

const CAPTURE_TIME = new Date("2027-03-01T12:01:00.000Z");

function orderPlaced(email: string) {
  const orderId = randomUUID();
  const id = randomUUID();
  return {
    orderId,
    envelope: {
      id,
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
        contact: { email },
      },
    },
  };
}

/** Delivers one `order.placed` to a payment consumer built from the given deps. */
async function deliver(
  email: string,
  deps: { sleeps?: number[]; random?: number; latencyMs?: { min: number; max: number } } = {},
) {
  sequence += 1;
  const subject = `ta.order.payment-case${sequence}`;
  const placed = orderPlaced(email);
  const runner = await createConsumerRunner({
    bus,
    prisma,
    service: "payment",
    consumer: `payment-case${sequence}`,
    filterSubject: subject,
    handler: createPaymentHandler({
      clock: {
        now: () => CAPTURE_TIME,
        sleep: async (ms) => {
          deps.sleeps?.push(ms);
        },
      },
      random: { next: () => deps.random ?? 0 },
      newId: randomUUID,
      ...(deps.latencyMs === undefined ? {} : { latencyMs: deps.latencyMs }),
    }),
  });
  await bus.publish({ subject, data: JSON.stringify(placed.envelope), msgId: placed.envelope.id });
  await runner.pollOnce();
  return placed;
}

describe("mock Payment handler", () => {
  it("records one CAPTURED attempt and emits payment.succeeded through its own outbox", async () => {
    const placed = await deliver("buyer@example.com");

    const attempts = await prisma.paymentAttempt.findMany({ where: { orderId: placed.orderId } });
    expect(attempts).toMatchObject([
      {
        attemptNo: 1,
        status: "CAPTURED",
        capturedAt: CAPTURE_TIME,
        amount: 12_500,
        currency: "EUR",
        contactEmail: "buyer@example.com",
      },
    ]);
    const outbox = await prisma.paymentOutboxEvent.findMany({
      where: { eventType: "payment.succeeded", aggregateId: attempts[0]?.paymentId ?? "" },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload).toMatchObject({
      type: "payment.succeeded",
      version: 1,
      orderId: placed.orderId,
      correlationId: placed.envelope.correlationId,
      causationId: placed.envelope.id,
      payload: {
        paymentId: attempts[0]?.paymentId,
        orderId: placed.orderId,
        attemptNo: 1,
        amount: 12_500,
        currency: "EUR",
        capturedAt: CAPTURE_TIME.toISOString(),
      },
    });
  });

  it("publishes its result twice, with distinct event ids, for a +dup@ buyer", async () => {
    const placed = await deliver("buyer+dup@example.com");

    expect(await prisma.paymentAttempt.count({ where: { orderId: placed.orderId } })).toBe(1);
    const events = await prisma.paymentOutboxEvent.findMany({
      where: {
        eventType: "payment.succeeded",
        payload: { path: ["orderId"], equals: placed.orderId },
      },
    });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    expect(
      new Set(
        events.map(
          (event) => (event.payload as { payload: { paymentId: string } }).payload.paymentId,
        ),
      ).size,
    ).toBe(1);
  });

  it("waits a latency drawn from the injected Random before capturing", async () => {
    const sleeps: number[] = [];

    await deliver("slow@example.com", { sleeps, random: 0.5, latencyMs: { min: 100, max: 300 } });

    expect(sleeps).toEqual([200]);
  });
});
