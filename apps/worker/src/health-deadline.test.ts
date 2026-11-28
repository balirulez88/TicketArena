import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  type MessageBus,
  measureOutboxFailures,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_PROBE_DEADLINE_MS, startWorker } from "./worker.js";

// `/health` is the Fly liveness check (5 s timeout). Its diagnostic probes run concurrently, each
// with its own deadline, so one hung dependency is reported as `unavailable` instead of making the
// platform time out the check and restart a worker that is fine.
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

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany();
});

// A probe whose dependency hangs: it neither resolves nor rejects.
const never = (): Promise<never> => new Promise(() => undefined);
const zero = { failed: 0, oldestFailedAgeMs: null, failedTransitions: 0 };

async function timedHealth(port: number): Promise<{ elapsedMs: number; body: unknown }> {
  const asking = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return { elapsedMs: performance.now() - asking, body };
}

describe("worker /health probe deadlines", () => {
  it("reports a probe that never resolves as unavailable within its deadline, and the others normally", async () => {
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      health: {
        redis: () => Promise.resolve("PONG"),
        outbox: () => measureOutboxFailures({ prisma, now: new Date() }),
        delivery: never,
        deadlinesMs: { delivery: 200 },
      },
    });
    try {
      const { elapsedMs, body } = await timedHealth(worker.port);

      expect(body).toEqual({
        status: "ok",
        redis: "ok",
        outbox: { alert: false, services: { booking: zero, payment: zero, notification: zero } },
        delivery: "unavailable",
      });
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await worker.stop();
    }
  });

  it("runs the probes concurrently: three hung probes cost one deadline, not three", async () => {
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      health: {
        redis: never,
        outbox: never,
        delivery: never,
        deadlinesMs: { redis: 300, outbox: 300, delivery: 300 },
      },
    });
    try {
      const { elapsedMs, body } = await timedHealth(worker.port);

      expect(body).toEqual({
        status: "ok",
        redis: "unavailable",
        outbox: "unavailable",
        delivery: "unavailable",
      });
      expect(elapsedMs).toBeLessThan(800);
    } finally {
      await worker.stop();
    }
  });

  it("answers well within Fly's 5 s check timeout with the default deadlines", async () => {
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      health: { redis: never, outbox: never, delivery: never },
    });
    try {
      const { elapsedMs, body } = await timedHealth(worker.port);

      expect(body).toEqual({
        status: "ok",
        redis: "unavailable",
        outbox: "unavailable",
        delivery: "unavailable",
      });
      expect(elapsedMs).toBeGreaterThanOrEqual(DEFAULT_HEALTH_PROBE_DEADLINE_MS - 50);
      expect(elapsedMs).toBeLessThan(DEFAULT_HEALTH_PROBE_DEADLINE_MS + 1000);
    } finally {
      await worker.stop();
    }
  });
});
