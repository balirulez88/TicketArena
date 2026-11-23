import { randomUUID } from "node:crypto";
import { createBookingService, createRedisBookingMetrics } from "@ticketarena/booking";
import { silentLogger } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { connectJetStreamMessageBus } from "@ticketarena/messaging";
import {
  setupRedisStandIn,
  setupTestDatabase,
  setupTestNats,
  setupTestRedis,
} from "@ticketarena/test-infra";
import {
  createQueueService,
  createRedisQueueStore,
  createScheduleAdmissionPolicy,
} from "@ticketarena/waiting-room";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceConsumers } from "./consumers.js";
import { createWorkerRedis } from "./redis.js";
import { startWorker } from "./worker.js";

// Ticket 63: Redis decides only queue order and admission (ADR 0005), so a Redis outage must not
// stop the relay, the consumers or the sweeper. The Redis here is real: a local stand-in in front
// of the test Redis that the test stops and brings back.

const database = setupTestDatabase();
const nats = setupTestNats();
const standIn = setupRedisStandIn("closed");
// Direct access to the real Redis behind the stand-in, to queue buyers while the worker cannot.
const redis = setupTestRedis();
const direct = createClient({ url: redis.url });

const REDIS_TIMEOUT_MS = 2000;
// Generous against a slow CI machine, yet far below the 30 s test timeout a hang would hit.
const BOUND_MS = 15_000;
const SEEDED_AT = new Date();

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  await direct.connect();
  await seedCatalog(prisma, SEEDED_AT);
});

afterAll(async () => {
  direct.destroy();
  await prisma.$disconnect();
});

async function health(port: number): Promise<unknown> {
  return (await fetch(`http://127.0.0.1:${port}/health`)).json();
}

describe("worker with Redis unreachable", () => {
  it("starts the relay, the consumers and the sweeper at once; the ticker and reaper keep retrying until Redis is back; /health reports Redis separately", async () => {
    const event = await prisma.event.findFirstOrThrow({ where: { demo: false } });
    const clock = { now: () => new Date(event.onSaleAt.getTime() + 60_000) };
    const prefix = `${standIn.prefix}${randomUUID()}:`;
    // Queued through the real Redis: the worker cannot reach it yet.
    const joining = createQueueService({
      store: createRedisQueueStore(direct, { prefix }),
      policy: createScheduleAdmissionPolicy(),
      clock,
      random: { next: () => 0.5 },
      newId: randomUUID,
      admitRatePerSecond: 10,
    });
    await joining.join(event, "buyer-1");

    // An order to carry through the relay and the consumers, and an expired hold to sweep.
    const booking = createBookingService({
      db: prisma,
      clock: { now: () => new Date() },
      newId: randomUUID,
    });
    const demo = await prisma.event.findFirstOrThrow({ where: { demo: true } });
    const [orderSeat, sweptSeat] = await prisma.seat.findMany({
      where: { eventId: demo.id, status: "AVAILABLE" },
      orderBy: { id: "asc" },
      take: 2,
    });
    const buyer = { sessionId: "e".repeat(32), buyerKey: "e".repeat(32) };
    const held = await booking.holdSeats(buyer, demo.id, [orderSeat?.id ?? ""]);
    const order = await booking.placeOrder(
      buyer,
      held.id,
      { email: "buyer@example.com" },
      randomUUID(),
    );
    // Held 11 minutes ago, so already expired (10 min), while the order above is not overdue.
    const abandoned = await createBookingService({
      db: prisma,
      clock: { now: () => new Date(Date.now() - 11 * 60_000) },
      newId: randomUUID,
    }).holdSeats({ sessionId: "f".repeat(32), buyerKey: "f".repeat(32) }, demo.id, [
      sweptSeat?.id ?? "",
    ]);

    const workerRedis = createWorkerRedis({
      url: standIn.url,
      timeouts: { connectTimeoutMs: REDIS_TIMEOUT_MS, commandTimeoutMs: REDIS_TIMEOUT_MS },
      logger: silentLogger,
    });
    const queue = createQueueService({
      store: createRedisQueueStore(workerRedis.queueClient, { prefix }),
      policy: createScheduleAdmissionPolicy(),
      clock,
      random: { next: () => 0.5 },
      newId: randomUUID,
      admitRatePerSecond: 10,
    });
    const bus = await connectJetStreamMessageBus({
      servers: nats.url,
      streamPrefix: nats.streamPrefix,
      subjectPrefix: nats.subjectPrefix,
    });

    const starting = performance.now();
    const worker = await startWorker({
      bus,
      prisma,
      port: 0,
      relay: { intervalMs: 20 },
      consumers: createServiceConsumers({
        prisma,
        clock: { now: () => new Date(), sleep: async () => undefined },
        random: { next: () => 0 },
        newId: randomUUID,
        sagaMetrics: createRedisBookingMetrics(workerRedis.metricsClient),
      }),
      sweeper: { booking, intervalMs: 20 },
      waitingRoom: {
        queue,
        limits: { admitRate: 10, maxActive: 10 },
        admitIntervalMs: 20,
        reapIntervalMs: 20,
      },
      health: { redis: workerRedis.ping },
    });
    try {
      expect(performance.now() - starting).toBeLessThan(BOUND_MS);

      await expect
        .poll(
          async () => (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
          { timeout: 15_000 },
        )
        .toBe("CONFIRMED");
      await expect
        .poll(
          async () => (await prisma.hold.findUniqueOrThrow({ where: { id: abandoned.id } })).status,
          { timeout: 10_000 },
        )
        .toBe("EXPIRED");
      expect(await health(worker.port)).toEqual({ status: "ok", redis: "unavailable" });
      expect(await joining.counts(event.id)).toEqual({ queued: 1, active: 0 });

      await standIn.setMode("forward");

      await expect
        .poll(() => joining.counts(event.id), { timeout: 10_000 })
        .toEqual({ queued: 0, active: 1 });
      expect(await health(worker.port)).toEqual({ status: "ok", redis: "ok" });
    } finally {
      await worker.stop();
      await bus.close();
      workerRedis.close();
    }
  });

  it("/health answers within a bounded time while Redis hangs", async () => {
    await standIn.setMode("silent");
    const workerRedis = createWorkerRedis({
      url: standIn.url,
      timeouts: { connectTimeoutMs: REDIS_TIMEOUT_MS, commandTimeoutMs: REDIS_TIMEOUT_MS },
      logger: silentLogger,
    });
    const bus = await connectJetStreamMessageBus({
      servers: nats.url,
      streamPrefix: nats.streamPrefix,
      subjectPrefix: nats.subjectPrefix,
    });
    const worker = await startWorker({ bus, prisma, port: 0, health: { redis: workerRedis.ping } });
    try {
      const asking = performance.now();
      expect(await health(worker.port)).toEqual({ status: "ok", redis: "unavailable" });
      expect(performance.now() - asking).toBeLessThan(BOUND_MS);
    } finally {
      await worker.stop();
      await bus.close();
      workerRedis.close();
    }
  });

  it("the worker's client bounds a command on a hung Redis, queues nothing while Redis is down and recovers", async () => {
    await standIn.setMode("forward");
    const workerRedis = createWorkerRedis({
      url: standIn.url,
      timeouts: { connectTimeoutMs: REDIS_TIMEOUT_MS, commandTimeoutMs: REDIS_TIMEOUT_MS },
      logger: silentLogger,
    });
    const timedPing = async () => {
      const started = performance.now();
      const failed = await workerRedis.ping().then(
        () => false,
        () => true,
      );
      return { failed, elapsedMs: performance.now() - started };
    };
    try {
      await workerRedis.ping();

      await standIn.setMode("silent");
      const hung = await timedPing();
      expect(hung.failed).toBe(true);
      expect(hung.elapsedMs).toBeLessThan(BOUND_MS);

      await standIn.setMode("forward");
      await workerRedis.ping();
      await standIn.setMode("closed");
      const stopped = await timedPing();
      expect(stopped.failed).toBe(true);
      // Not queued for the reconnect: it fails before the connect timeout could pass.
      expect(stopped.elapsedMs).toBeLessThan(REDIS_TIMEOUT_MS);

      await standIn.setMode("forward");
      await expect.poll(async () => (await timedPing()).failed, { timeout: BOUND_MS }).toBe(false);
    } finally {
      workerRedis.close();
    }
  });
});
