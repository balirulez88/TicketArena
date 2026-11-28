import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createOutboxRelay,
  type MessageBus,
  measureOutboxFailures,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startWorker } from "./worker.js";

// `/health` carries the FAILED outbox metrics and the alert flag (ADR 0022) without ever failing
// the worker's liveness: a FAILED row is an operator's alert, not a reason to restart the worker.
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

async function healthOf(port: number): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: response.status, body: await response.json() };
}

function workerWithOutboxHealth() {
  return startWorker({
    bus,
    prisma,
    port: 0,
    // Its relays tick too; a FAILED row is never claimed again, so they leave it as it is.
    relay: { intervalMs: 20 },
    health: { outbox: () => measureOutboxFailures({ prisma, now: new Date() }) },
  });
}

const zero = { failed: 0, oldestFailedAgeMs: null, failedTransitions: 0 };

describe("worker /health outbox failures", () => {
  it("reports no alert and zero FAILED rows when none exists", async () => {
    const worker = await workerWithOutboxHealth();
    try {
      expect(await healthOf(worker.port)).toEqual({
        status: 200,
        body: {
          status: "ok",
          outbox: { alert: false, services: { booking: zero, payment: zero, notification: zero } },
        },
      });
    } finally {
      await worker.stop();
    }
  });

  it("raises the alert while a FAILED row exists, and stays live", async () => {
    await prisma.outboxEvent.create({
      data: {
        id: crypto.randomUUID(),
        aggregateType: "order",
        aggregateId: crypto.randomUUID(),
        eventType: "unrouted.event",
        payload: {},
      },
    });
    await createOutboxRelay({ bus, prisma, maxPermanentFailures: 1 }).tick();
    const worker = await workerWithOutboxHealth();
    try {
      const { status, body } = await healthOf(worker.port);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "ok",
        outbox: {
          alert: true,
          services: {
            booking: { failed: 1, failedTransitions: 1 },
            payment: zero,
            notification: zero,
          },
        },
      });
    } finally {
      await worker.stop();
    }
  });
});
