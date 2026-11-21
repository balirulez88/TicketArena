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

interface DeliveryDeps {
  sleeps?: number[];
  random?: number;
  latencyMs?: { min: number; max: number };
  successRate?: number;
  /** Replaces the recording sleep stub, e.g. with a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The runner's database client; defaults to the shared one. */
  runnerPrisma?: PrismaClient;
  runnerBus?: MessageBus;
  ackWaitMs?: number;
}

/** Builds a payment consumer from the given deps on a fresh durable name and subject. */
async function paymentRunner(deps: DeliveryDeps = {}) {
  sequence += 1;
  const subject = `ta.order.payment-case${sequence}`;
  const runner = await createConsumerRunner({
    bus: deps.runnerBus ?? bus,
    prisma: deps.runnerPrisma ?? prisma,
    service: "payment",
    consumer: `payment-case${sequence}`,
    filterSubject: subject,
    ...(deps.ackWaitMs === undefined ? {} : { ackWaitMs: deps.ackWaitMs }),
    ...createPaymentHandler({
      clock: {
        now: () => CAPTURE_TIME,
        sleep:
          deps.sleep ??
          (async (ms) => {
            deps.sleeps?.push(ms);
          }),
      },
      random: { next: () => deps.random ?? 0 },
      newId: randomUUID,
      ...(deps.latencyMs === undefined ? {} : { latencyMs: deps.latencyMs }),
      ...(deps.successRate === undefined ? {} : { successRate: deps.successRate }),
    }),
  });
  return { runner, subject };
}

/** Delivers one `order.placed` to a payment consumer built from the given deps. */
async function deliver(email: string, deps: DeliveryDeps = {}, placed = orderPlaced(email)) {
  const { runner, subject } = await paymentRunner(deps);
  await bus.publish({ subject, data: JSON.stringify(placed.envelope), msgId: placed.envelope.id });
  await runner.pollOnce();
  return { ...placed, runner };
}

function failedEventsFor(orderId: string) {
  return prisma.paymentOutboxEvent.findMany({
    where: { eventType: "payment.failed", payload: { path: ["orderId"], equals: orderId } },
  });
}

/** Another attempt for the order, as a retry would leave it; attempt 1 is the handler's own. */
function otherAttempt(orderId: string, status: "ATTEMPTING" | "CAPTURED") {
  return prisma.paymentAttempt.create({
    data: {
      paymentId: randomUUID(),
      orderId,
      attemptNo: 2,
      status,
      ...(status === "CAPTURED" ? { capturedAt: CAPTURE_TIME } : {}),
      amount: 12_500,
      currency: "EUR",
      contactEmail: "buyer+fail@example.com",
      createdAt: CAPTURE_TIME,
    },
  });
}

function succeededEventsFor(orderId: string) {
  return prisma.paymentOutboxEvent.count({
    where: { eventType: "payment.succeeded", payload: { path: ["orderId"], equals: orderId } },
  });
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

  it("captures after the order's payment deadline for a +late@ buyer", async () => {
    const placed = await deliver("buyer+late@example.com");
    const deadline = new Date(placed.envelope.payload.paymentDeadline);

    const [attempt] = await prisma.paymentAttempt.findMany({ where: { orderId: placed.orderId } });
    expect(attempt).toMatchObject({ attemptNo: 1, status: "CAPTURED" });
    expect(attempt?.capturedAt?.getTime()).toBeGreaterThan(deadline.getTime());
    const events = await prisma.paymentOutboxEvent.findMany({
      where: {
        eventType: "payment.succeeded",
        payload: { path: ["orderId"], equals: placed.orderId },
      },
    });
    expect(events.map((event) => event.payload)).toMatchObject([
      { payload: { capturedAt: attempt?.capturedAt?.toISOString() } },
    ]);
  });

  it("captures a +late@ buyer even when the injected Random draws a failure", async () => {
    const placed = await deliver("buyer+late@example.com", { random: 0.9, successRate: 0 });

    expect(await succeededEventsFor(placed.orderId)).toBe(1);
    expect(await failedEventsFor(placed.orderId)).toEqual([]);
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

  it("TD-051: captures once and emits payment.succeeded once on the first delivery when the latency outlasts the transaction timeout", async () => {
    // The runner's interactive-transaction timeout is injected config of its Prisma client;
    // lowering it from Prisma's 5 s default keeps a real sleep that exceeds it short.
    const runnerPrisma = createPrismaClient({
      connectionString: database.url,
      driver: "pg",
      transaction: { maxWaitMs: 2_000, timeoutMs: 500 },
    });
    try {
      const placed = await deliver("patient@example.com", {
        runnerPrisma,
        latencyMs: { min: 900, max: 900 },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });

      // Committed by the first delivery: no timeout, no nak, no redelivery needed.
      expect(await prisma.paymentAttempt.count({ where: { orderId: placed.orderId } })).toBe(1);
      expect(await succeededEventsFor(placed.orderId)).toBe(1);
      expect(
        await prisma.paymentProcessedMessage.count({ where: { messageId: placed.envelope.id } }),
      ).toBe(1);
      expect(await placed.runner.pollOnce()).toBe(0);
    } finally {
      await runnerPrisma.$disconnect();
    }
  });

  it("TD-051: holds no database transaction open while the provider latency elapses", async () => {
    // A distinct application_name lets pg_stat_activity single out the runner's connections.
    const applicationName = `payment_latency_probe_${sequence}`;
    const url = new URL(database.url);
    url.searchParams.set("application_name", applicationName);
    const runnerPrisma = createPrismaClient({ connectionString: url.toString(), driver: "pg" });
    const openTransactionsDuringWait: number[] = [];
    try {
      const placed = await deliver("observed@example.com", {
        runnerPrisma,
        latencyMs: { min: 50, max: 50 },
        sleep: async () => {
          const rows = await prisma.$queryRaw<{ open: bigint }[]>`
            SELECT count(*) AS open FROM pg_stat_activity
            WHERE application_name = ${applicationName} AND xact_start IS NOT NULL`;
          openTransactionsDuringWait.push(Number(rows[0]?.open ?? -1));
        },
      });

      expect(openTransactionsDuringWait).toEqual([0]);
      // ...and the transaction did run afterwards: the capture committed.
      expect(await prisma.paymentAttempt.count({ where: { orderId: placed.orderId } })).toBe(1);
    } finally {
      await runnerPrisma.$disconnect();
    }
  });

  it("treats a redelivered order.placed whose payment was captured as a duplicate, latency step included", async () => {
    const sleeps: number[] = [];
    let acksToDrop = 1;
    const deliveryCounts: number[] = [];
    // A crash between commit and ack, simulated at the broker boundary: the ack never arrives.
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
                nak: (delayMs) => message.nak(delayMs),
              };
            }),
        };
      },
    };
    const placed = await deliver("redelivered@example.com", {
      sleeps,
      latencyMs: { min: 10, max: 10 },
      runnerBus: crashingBus,
      ackWaitMs: 500,
    });

    await new Promise((resolve) => setTimeout(resolve, 700));
    await placed.runner.pollOnce();

    expect(deliveryCounts).toEqual([1, 2]);
    // The latency step ran again before dedupe, yet the redelivery captured nothing new.
    expect(sleeps).toEqual([10, 10]);
    expect(await prisma.paymentAttempt.count({ where: { orderId: placed.orderId } })).toBe(1);
    expect(await succeededEventsFor(placed.orderId)).toBe(1);
  });

  it("records a FAILED attempt with its reason and emits payment.failed with final: true for a +fail@ buyer", async () => {
    const placed = await deliver("buyer+fail@example.com");

    const attempts = await prisma.paymentAttempt.findMany({ where: { orderId: placed.orderId } });
    expect(attempts).toMatchObject([
      { attemptNo: 1, status: "FAILED", capturedAt: null, failureReason: "card_declined" },
    ]);
    const events = await failedEventsFor(placed.orderId);
    expect(events.map((event) => event.payload)).toMatchObject([
      {
        type: "payment.failed",
        version: 1,
        orderId: placed.orderId,
        correlationId: placed.envelope.correlationId,
        causationId: placed.envelope.id,
        payload: {
          paymentId: attempts[0]?.paymentId,
          orderId: placed.orderId,
          attemptNo: 1,
          final: true,
          reason: "card_declined",
        },
      },
    ]);
    expect(await succeededEventsFor(placed.orderId)).toBe(0);
  });

  it("emits a non-final payment.failed when the injected Random draws a failure", async () => {
    const placed = await deliver("buyer@example.com", { random: 0.5, successRate: 0.5 });

    expect(
      await prisma.paymentAttempt.findMany({ where: { orderId: placed.orderId } }),
    ).toMatchObject([{ status: "FAILED", failureReason: "provider_declined" }]);
    expect((await failedEventsFor(placed.orderId)).map((event) => event.payload)).toMatchObject([
      { payload: { final: false, reason: "provider_declined" } },
    ]);
  });

  it("captures when the injected Random draws below the success rate", async () => {
    const placed = await deliver("buyer@example.com", { random: 0.4, successRate: 0.5 });

    expect(await succeededEventsFor(placed.orderId)).toBe(1);
    expect(await failedEventsFor(placed.orderId)).toEqual([]);
  });

  it.each(["ATTEMPTING", "CAPTURED"] as const)(
    "never emits final: true while another attempt for the order is %s",
    async (status) => {
      const placed = orderPlaced("buyer+fail@example.com");
      await otherAttempt(placed.orderId, status);

      await deliver("buyer+fail@example.com", {}, placed);

      expect((await failedEventsFor(placed.orderId)).map((event) => event.payload)).toMatchObject([
        { payload: { attemptNo: 1, final: false, reason: "card_declined" } },
      ]);
    },
  );
});
