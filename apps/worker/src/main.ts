import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createBookingService, createRedisBookingMetrics } from "@ticketarena/booking";
import { createPrismaClient } from "@ticketarena/db";
import { connectJetStreamMessageBus, measureOutboxFailures } from "@ticketarena/messaging";
import {
  createQueueService,
  createRedisQueueStore,
  createScheduleAdmissionPolicy,
} from "@ticketarena/waiting-room";
import { createServiceConsumers } from "./consumers.js";
import { parseWorkerEnv } from "./env.js";
import { shutdownWorkerProcess, startWorkerProcess } from "./lifecycle.js";
import { createWorkerLogger } from "./logger.js";
import { createWorkerRedis } from "./redis.js";
import { startWorker } from "./worker.js";

const env = parseWorkerEnv(process.env);
const logger = createWorkerLogger();
const exit = (code: number) => process.exit(code);
// Everything is opened inside `start`, each resource handed to `opened` as soon as it exists, so a
// NATS connect that fails or a port in use closes what is already open and exits 1 (TD-034); the
// worker's own cleanup and these closes share one 25 s budget (TD-035).
const started = await startWorkerProcess({
  start: async (opened, stopBudget) => {
    const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, driver: "pg" });
    opened({ name: "prisma", stop: () => prisma.$disconnect() });
    // Connected on first use, never awaited here: the relay, the consumers and the sweeper must
    // start while Redis is down (ticket 63); the ticker and reaper fail their passes and retry.
    const redis = createWorkerRedis({
      url: env.REDIS_URL,
      timeouts: {
        connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
        commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
      },
      logger,
    });
    opened({ name: "redis", stop: () => redis.close() });
    const bus = await connectJetStreamMessageBus({
      servers: env.NATS_URL,
      ...(env.NATS_TOKEN === undefined ? {} : { token: env.NATS_TOKEN }),
    });
    opened({ name: "bus", stop: () => bus.close() });
    // The composition root is the only place that reads the system clock and Math.random.
    const clock = { now: () => new Date(), sleep: (ms: number) => delay(ms) };
    const booking = createBookingService({ db: prisma, clock, newId: randomUUID, logger });
    const consumers = createServiceConsumers({
      prisma,
      clock,
      random: { next: Math.random },
      newId: randomUUID,
      // No prefix: the same per-event counter hash the web app's booking counters use.
      sagaMetrics: createRedisBookingMetrics(redis.metricsClient),
      logger,
    });
    const queue = createQueueService({
      // No prefix: the same keys the web app reads and writes.
      store: createRedisQueueStore(redis.queueClient, { prefix: "" }),
      policy: createScheduleAdmissionPolicy(),
      clock,
      random: { next: Math.random },
      newId: randomUUID,
      admitRatePerSecond: env.ADMIT_RATE_PER_SECOND,
    });
    return startWorker({
      bus,
      prisma,
      port: env.PORT,
      logger,
      consumers,
      sweeper: { booking },
      reconciler: { booking },
      retention: { now: clock.now },
      waitingRoom: {
        queue,
        limits: { admitRate: env.ADMIT_RATE_PER_SECOND, maxActive: env.MAX_ACTIVE },
      },
      health: {
        redis: redis.ping,
        outbox: () => measureOutboxFailures({ prisma, now: clock.now() }),
        delivery: () =>
          bus.deliveryHealth(
            consumers.map((consumer) => consumer.consumer),
            clock.now(),
          ),
      },
      stopBudget,
    });
  },
  logger,
  exit,
});
if (started !== undefined) {
  const { worker, resources } = started;
  logger.info({ port: worker.port }, "worker listening");
  let stopping = false;
  // Never rejects (shutdownWorkerProcess logs every failure and exits), so `void` drops nothing.
  // One budget, DEFAULT_SHUTDOWN_DEADLINE_MS, covers the components and the resources (TD-035).
  const shutdown = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void shutdownWorkerProcess({ phases: [...worker.components, ...resources], logger, exit });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
