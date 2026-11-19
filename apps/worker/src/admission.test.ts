import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { connectJetStreamMessageBus, type MessageBus } from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats, setupTestRedis } from "@ticketarena/test-infra";
import {
  type AdmissionLimits,
  createQueueService,
  createRedisQueueStore,
  createScheduleAdmissionPolicy,
  type QueueService,
} from "@ticketarena/waiting-room";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWorkerEnv } from "./env.js";
import { ADMIT_INTERVAL_MS, REAP_INTERVAL_MS, startWorker } from "./worker.js";

const database = setupTestDatabase();
const nats = setupTestNats();
const redis = setupTestRedis();
const redisClient = createClient({ url: redis.url });

let prisma: PrismaClient;
let bus: MessageBus;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
  await redisClient.connect();
  await seedCatalog(prisma, new Date("2027-03-01T12:00:00.000Z"));
});

afterAll(async () => {
  redisClient.destroy();
  await bus.close();
  await prisma.$disconnect();
});

/**
 * A queue on its own key namespace with `count` buyers queued for the demo event, at a clock the
 * test moves (by default it starts a minute after the on-sale, inside the queue window).
 */
async function demoQueue(count: number, sinceOnSaleMs = 60_000) {
  const event = await prisma.event.findFirstOrThrow({ where: { demo: true } });
  const clock = { now: new Date(event.onSaleAt.getTime() + sinceOnSaleMs) };
  const queue = createQueueService({
    store: createRedisQueueStore(redisClient, { prefix: `${redis.prefix}${randomUUID()}:` }),
    policy: createScheduleAdmissionPolicy(),
    clock: { now: () => clock.now },
    random: { next: () => 0.5 },
    newId: randomUUID,
    admitRatePerSecond: 10,
  });
  for (let index = 1; index <= count; index += 1) {
    await queue.join(event, `buyer-${index}`);
  }
  return { event, eventId: event.id, clock, queue };
}

function later(clock: { now: Date }, ms: number) {
  clock.now = new Date(clock.now.getTime() + ms);
}

async function withWorker(
  queue: Pick<QueueService, "admitTick" | "reap">,
  limits: AdmissionLimits,
  run: () => Promise<void>,
  intervals: { admitIntervalMs?: number; reapIntervalMs?: number } = {
    admitIntervalMs: 20,
    reapIntervalMs: 20,
  },
) {
  const worker = await startWorker({
    bus,
    prisma,
    port: 0,
    waitingRoom: { queue, limits, ...intervals },
  });
  try {
    await run();
  } finally {
    await worker.stop();
  }
}

describe("worker admission ticker", () => {
  it("AT-38: admits from the queue head into the active set, never beyond admitRate or maxActive", async () => {
    const { eventId, clock, queue } = await demoQueue(10);

    await withWorker(queue, { admitRate: 2, maxActive: 3 }, async () => {
      await expect
        .poll(() => queue.counts(eventId), { timeout: 10_000 })
        .toEqual({
          queued: 8,
          active: 2,
        });
      // The clock stands still, so the bucket stays empty however often the ticker runs.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await queue.counts(eventId)).toEqual({ queued: 8, active: 2 });
      expect(await queue.status(eventId, "buyer-1")).toMatchObject({ status: "ADMITTED" });

      later(clock, 1000);
      await expect
        .poll(() => queue.counts(eventId), { timeout: 10_000 })
        .toEqual({
          queued: 7,
          active: 3,
        });
      later(clock, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await queue.counts(eventId)).toEqual({ queued: 7, active: 3 });
    });
  });

  it("admits no one from a pre-queue before the event's onSaleAt", async () => {
    const { eventId, clock, queue } = await demoQueue(3, -60_000);

    await withWorker(queue, { admitRate: 5, maxActive: 5 }, async () => {
      // Several ticks run while the clock stands a minute before the on-sale.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await queue.counts(eventId)).toEqual({ queued: 3, active: 0 });

      later(clock, 60_000);
      await expect
        .poll(() => queue.counts(eventId), { timeout: 10_000 })
        .toEqual({ queued: 0, active: 3 });
    });
  });

  it("keeps ticking after a failed tick", async () => {
    let ticks = 0;
    const failingOnce: Pick<QueueService, "admitTick" | "reap"> = {
      admitTick: async () => {
        ticks += 1;
        if (ticks === 1) {
          throw new Error("redis unavailable");
        }
        return [];
      },
      reap: async () => [],
    };

    await withWorker(failingOnce, { admitRate: 1, maxActive: 1 }, async () => {
      await expect.poll(() => ticks, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    });
  });

  it("ticks every second and reaps every 15 seconds by default", async () => {
    expect(ADMIT_INTERVAL_MS).toBe(1000);
    expect(REAP_INTERVAL_MS).toBe(15_000);
    const calls = { admit: 0, reap: 0 };
    const recording: Pick<QueueService, "admitTick" | "reap"> = {
      admitTick: async () => {
        calls.admit += 1;
        return [];
      },
      reap: async () => {
        calls.reap += 1;
        return [];
      },
    };

    await withWorker(
      recording,
      { admitRate: 1, maxActive: 1 },
      async () => {
        await expect.poll(() => calls.reap, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // One pass over every seeded event at start, none more within the first second.
        const events = await prisma.event.count();
        expect(calls).toEqual({ admit: events, reap: events });
      },
      {},
    );
  });
});

describe("worker reaper", () => {
  it("AT-39: frees a slot idle for over 90 s and revokes its admission", async () => {
    const { event, eventId, clock, queue } = await demoQueue(2);
    const admitted = await queue.admitTick(event, { admitRate: 2, maxActive: 2 });
    later(clock, 60_000);
    await queue.heartbeat(eventId, "buyer-2");
    later(clock, 31_000);

    await withWorker(queue, { admitRate: 2, maxActive: 2 }, async () => {
      await expect
        .poll(() => queue.counts(eventId), { timeout: 10_000 })
        .toEqual({
          queued: 0,
          active: 1,
        });
      expect(await queue.status(eventId, "buyer-1")).toEqual({ status: "NOT_QUEUED" });
      expect(await queue.status(eventId, "buyer-2")).toMatchObject({ status: "ADMITTED" });
      const jtiOf = (sessionId: string) =>
        admitted.find((admission) => admission.sessionId === sessionId)?.jti ?? "";
      expect(await queue.isAdmitted(eventId, jtiOf("buyer-1"))).toBe(false);
      expect(await queue.isAdmitted(eventId, jtiOf("buyer-2"))).toBe(true);
    });
  });
});

describe("parseWorkerEnv (waiting room)", () => {
  const base = {
    DATABASE_URL: "postgresql://u@h/db",
    NATS_URL: "nats://h:4222",
    REDIS_URL: "redis://h:6379",
  };

  it("defaults the admission limits", () => {
    expect(parseWorkerEnv(base)).toMatchObject({ ADMIT_RATE_PER_SECOND: 10, MAX_ACTIVE: 100 });
  });

  it("names a missing REDIS_URL and invalid limits", () => {
    expect(() =>
      parseWorkerEnv({
        DATABASE_URL: base.DATABASE_URL,
        NATS_URL: base.NATS_URL,
        ADMIT_RATE_PER_SECOND: "0",
        MAX_ACTIVE: "1.5",
      }),
    ).toThrow(/REDIS_URL[\s\S]*ADMIT_RATE_PER_SECOND[\s\S]*MAX_ACTIVE/);
  });
});
