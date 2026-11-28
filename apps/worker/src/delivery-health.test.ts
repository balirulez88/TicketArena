import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  type DeliveryHealthProbe,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker } from "./worker.js";

// `/health` carries the broker's message-health figures for the dashboard (spec: Admin
// dashboard) next to the outbox ones, and, like them, never fails the worker's liveness.
const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus & DeliveryHealthProbe;

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

async function healthOf(port: number): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: response.status, body: await response.json() };
}

describe("worker /health delivery figures", () => {
  it("reports consumer lag, pending acks, redeliveries, DLQ size and oldest DLQ age", async () => {
    const subscription = await bus.subscribe({
      stream: "main",
      consumer: "health-probe",
      filterSubject: "ta.order.healthprobe",
    });
    for (let i = 0; i < 2; i += 1) {
      await bus.publish({
        subject: "ta.order.healthprobe",
        data: "{}",
        msgId: crypto.randomUUID(),
      });
    }
    await subscription.fetch({ maxMessages: 1, expiresMs: 2000 });
    await bus.publish({ subject: "ta.dlq.health-probe", data: "{}", msgId: crypto.randomUUID() });
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      health: { delivery: () => bus.deliveryHealth(["health-probe"], new Date()) },
    });
    try {
      const { status, body } = await healthOf(worker.port);

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "ok",
        delivery: {
          consumers: { "health-probe": { lag: 1, pendingAcks: 1, redeliveries: 0 } },
          dlq: { size: 1, oldestAgeMs: expect.any(Number) },
        },
      });
    } finally {
      await worker.stop();
    }
  });

  it("reports the figures as unavailable when the broker cannot answer, and stays live", async () => {
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      health: { delivery: () => Promise.reject(new Error("JetStream API timeout")) },
    });
    try {
      expect(await healthOf(worker.port)).toEqual({
        status: 200,
        body: { status: "ok", delivery: "unavailable" },
      });
    } finally {
      await worker.stop();
    }
  });
});
