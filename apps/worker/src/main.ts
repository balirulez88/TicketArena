import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createBookingService, createRedisBookingMetrics } from "@ticketarena/booking";
import { createPrismaClient } from "@ticketarena/db";
import { connectJetStreamMessageBus } from "@ticketarena/messaging";
import {
  createQueueService,
  createRedisQueueStore,
  createScheduleAdmissionPolicy,
} from "@ticketarena/waiting-room";
import { createServiceConsumers } from "./consumers.js";
import { parseWorkerEnv } from "./env.js";
import { type StopPhases, shutdownWorkerProcess, startWorkerProcess } from "./lifecycle.js";
import { createWorkerLogger } from "./logger.js";
import { createWorkerRedis } from "./redis.js";
import { startWorker } from "./worker.js";

const env = parseWorkerEnv(process.env);
const logger = createWorkerLogger();
const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, driver: "pg" });
const bus = await connectJetStreamMessageBus({
  servers: env.NATS_URL,
  ...(env.NATS_TOKEN === undefined ? {} : { token: env.NATS_TOKEN }),
});
// The composition root is the only place that reads the system clock and Math.random.
const clock = { now: () => new Date(), sleep: (ms: number) => delay(ms) };
const booking = createBookingService({ db: prisma, clock, newId: randomUUID, logger });
// Connected on first use, never awaited here: the relay, the consumers and the sweeper must start
// while Redis is down (ticket 63); the ticker and reaper fail their passes and retry until it is up.
const redis = createWorkerRedis({
  url: env.REDIS_URL,
  timeouts: {
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
  },
  logger,
});
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
// What this entry point opened, closed after the worker's own components: on a failed start, and
// on SIGTERM or SIGINT. Each is bounded by DEFAULT_SHUTDOWN_DEADLINE_MS (TD-035).
const resources: StopPhases = [
  [{ name: "bus", stop: () => bus.close() }],
  [{ name: "redis", stop: () => redis.close() }],
  [{ name: "prisma", stop: () => prisma.$disconnect() }],
];
const exit = (code: number) => process.exit(code);
const worker = await startWorkerProcess({
  start: () =>
    startWorker({
      bus,
      prisma,
      port: env.PORT,
      logger,
      consumers,
      sweeper: { booking },
      waitingRoom: {
        queue,
        limits: { admitRate: env.ADMIT_RATE_PER_SECOND, maxActive: env.MAX_ACTIVE },
      },
      health: { redis: redis.ping },
    }),
  resources,
  logger,
  exit,
});
if (worker !== undefined) {
  logger.info({ port: worker.port }, "worker listening");
  let stopping = false;
  // Never rejects (shutdownWorkerProcess logs every failure and exits), so `void` drops nothing.
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
