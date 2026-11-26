import { randomUUID } from "node:crypto";
import { createBookingService, type SweepResult } from "@ticketarena/booking";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { seedCatalog } from "@ticketarena/db/seed";
import { connectJetStreamMessageBus, type MessageBus } from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWorkerEnv } from "./env.js";
import { SWEEP_INTERVAL_MS, startWorker } from "./worker.js";

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

describe("worker hold sweeper", () => {
  const NOW = new Date("2027-03-01T12:00:00.000Z");

  function recordingSweeper(failFirst = false) {
    let calls = 0;
    return {
      calls: () => calls,
      booking: {
        sweepExpired: async (): Promise<SweepResult> => {
          calls += 1;
          if (failFirst && calls === 1) {
            throw new Error("database unavailable");
          }
          return { expiredHoldIds: [], expiredOrderIds: [] };
        },
      },
    };
  }

  it("expires a hold past holdExpiresAt and frees its seat through the booking service", async () => {
    await seedCatalog(prisma, NOW);
    const event = await prisma.event.findFirstOrThrow({ where: { demo: true } });
    const seat = await prisma.seat.findFirstOrThrow({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "asc" },
    });
    const buyer = { sessionId: "c".repeat(32), buyerKey: "c".repeat(32) };
    const hold = await createBookingService({
      db: prisma,
      clock: { now: () => NOW },
      newId: randomUUID,
    }).holdSeats(buyer, event.id, [seat.id]);
    const booking = createBookingService({
      db: prisma,
      clock: { now: () => hold.holdExpiresAt },
      newId: randomUUID,
    });

    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      sweeper: { booking, intervalMs: 20 },
    });
    try {
      await expect
        .poll(
          async () => (await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } })).status,
          {
            timeout: 10_000,
          },
        )
        .toBe("EXPIRED");
      expect((await prisma.seat.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe(
        "AVAILABLE",
      );
    } finally {
      await worker.stop();
    }
  });

  it("keeps sweeping after a failed sweep", async () => {
    const sweeper = recordingSweeper(true);
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      sweeper: { booking: sweeper.booking, intervalMs: 20 },
    });
    try {
      await expect.poll(() => sweeper.calls(), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    } finally {
      await worker.stop();
    }
  });

  it("sweeps at start, then every 15 seconds by default, and stops without waiting out the interval", async () => {
    expect(SWEEP_INTERVAL_MS).toBe(15_000);
    const sweeper = recordingSweeper();
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      sweeper: { booking: sweeper.booking },
    });
    await expect.poll(() => sweeper.calls(), { timeout: 10_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sweeper.calls()).toBe(1);

    const stopping = Date.now();
    await worker.stop();
    expect(Date.now() - stopping).toBeLessThan(5_000);
  });
});

describe("parseWorkerEnv", () => {
  it("names the offending fields", () => {
    expect(() => parseWorkerEnv({ DATABASE_URL: "nope" })).toThrow(/DATABASE_URL[\s\S]*NATS_URL/);
  });

  it("defaults the Redis timeouts and names one that is not a positive integer", () => {
    const base = {
      DATABASE_URL: "postgresql://u@h/db",
      NATS_URL: "nats://h:4222",
      REDIS_URL: "redis://h:6379",
    };
    expect(parseWorkerEnv(base)).toMatchObject({
      REDIS_CONNECT_TIMEOUT_MS: 2000,
      REDIS_COMMAND_TIMEOUT_MS: 1000,
    });
    expect(
      parseWorkerEnv({ ...base, REDIS_CONNECT_TIMEOUT_MS: "500", REDIS_COMMAND_TIMEOUT_MS: "250" }),
    ).toMatchObject({ REDIS_CONNECT_TIMEOUT_MS: 500, REDIS_COMMAND_TIMEOUT_MS: 250 });
    expect(() => parseWorkerEnv({ ...base, REDIS_CONNECT_TIMEOUT_MS: "-1" })).toThrow(
      /REDIS_CONNECT_TIMEOUT_MS/,
    );
    expect(() => parseWorkerEnv({ ...base, REDIS_COMMAND_TIMEOUT_MS: "x" })).toThrow(
      /REDIS_COMMAND_TIMEOUT_MS/,
    );
  });

  it("needs a NATS_TOKEN of at least 32 characters for NATS on Fly's private network, not locally", () => {
    const local = {
      DATABASE_URL: "postgresql://u@h/db",
      NATS_URL: "nats://localhost:4222",
      REDIS_URL: "redis://h:6379",
    };
    const fly = { ...local, NATS_URL: "nats://ticketarena-nats.internal:4222" };

    expect(parseWorkerEnv(local).NATS_TOKEN).toBeUndefined();
    expect(() => parseWorkerEnv(fly)).toThrow(/NATS_TOKEN/);
    expect(() => parseWorkerEnv({ ...fly, NATS_TOKEN: "short" })).toThrow(/NATS_TOKEN/);
    expect(parseWorkerEnv({ ...fly, NATS_TOKEN: "t".repeat(32) }).NATS_TOKEN).toBe("t".repeat(32));
  });

  it("defaults the health port", () => {
    expect(
      parseWorkerEnv({
        DATABASE_URL: "postgresql://u@h/db",
        NATS_URL: "nats://h:4222",
        REDIS_URL: "redis://h:6379",
      }).PORT,
    ).toBe(8080);
  });
});
