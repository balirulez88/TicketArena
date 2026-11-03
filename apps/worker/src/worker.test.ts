import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { connectJetStreamMessageBus, type MessageBus } from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWorkerEnv } from "./env.js";
import { startWorker } from "./worker.js";

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
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

describe("worker", () => {
  it("ensures the topology before the relay's first poll, then publishes pending rows", async () => {
    const calls: string[] = [];
    const recordingBus: MessageBus = {
      ...bus,
      ensureTopology: async () => {
        calls.push("ensureTopology");
        await bus.ensureTopology();
      },
      publish: async (input) => {
        calls.push("publish");
        return bus.publish(input);
      },
    };
    const id = crypto.randomUUID();
    await prisma.outboxEvent.create({
      data: {
        id,
        aggregateType: "order",
        aggregateId: "a",
        eventType: "order.placed",
        payload: {},
      },
    });

    const worker = await startWorker({
      bus: recordingBus,
      prisma,
      port: 0,
      relay: { intervalMs: 20 },
    });
    try {
      await expect
        .poll(async () => (await prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).status, {
          timeout: 10_000,
        })
        .toBe("PUBLISHED");
      expect(calls).toEqual(["ensureTopology", "publish"]);
    } finally {
      await worker.stop();
    }
  });

  it("serves /health", async () => {
    const worker = await startWorker({ bus, prisma, port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${worker.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
      expect((await fetch(`http://127.0.0.1:${worker.port}/nope`)).status).toBe(404);
    } finally {
      await worker.stop();
    }
  });
});

describe("parseWorkerEnv", () => {
  it("names the offending fields", () => {
    expect(() => parseWorkerEnv({ DATABASE_URL: "nope" })).toThrow(/DATABASE_URL[\s\S]*NATS_URL/);
  });

  it("defaults the health port", () => {
    expect(
      parseWorkerEnv({ DATABASE_URL: "postgresql://u@h/db", NATS_URL: "nats://h:4222" }).PORT,
    ).toBe(8080);
  });
});
