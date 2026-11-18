import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createBookingService } from "@ticketarena/booking";
import { createPrismaClient } from "@ticketarena/db";
import { connectJetStreamMessageBus } from "@ticketarena/messaging";
import {
  createQueueService,
  createRedisQueueStore,
  createScheduleAdmissionPolicy,
} from "@ticketarena/waiting-room";
import { createClient } from "redis";
import { createServiceConsumers } from "./consumers.js";
import { parseWorkerEnv } from "./env.js";
import { createWorkerLogger } from "./logger.js";
import { startWorker } from "./worker.js";

const env = parseWorkerEnv(process.env);
const logger = createWorkerLogger();
const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, driver: "pg" });
const bus = await connectJetStreamMessageBus({ servers: env.NATS_URL });
// The composition root is the only place that reads the system clock and Math.random.
const clock = { now: () => new Date(), sleep: (ms: number) => delay(ms) };
const consumers = createServiceConsumers({
  prisma,
  clock,
  random: { next: Math.random },
  newId: randomUUID,
  logger,
});
const booking = createBookingService({ db: prisma, clock, newId: randomUUID, logger });
const redis = createClient({ url: env.REDIS_URL });
// Without a listener node-redis rethrows socket errors as uncaught exceptions; a failed tick is
// retried by the loop, and node-redis reconnects on its own.
redis.on("error", (error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, "queue redis");
});
await redis.connect();
const queue = createQueueService({
  // No prefix: the same keys the web app reads and writes.
  store: createRedisQueueStore(redis, { prefix: "" }),
  policy: createScheduleAdmissionPolicy(),
  clock,
  random: { next: Math.random },
  newId: randomUUID,
  admitRatePerSecond: env.ADMIT_RATE_PER_SECOND,
});
const worker = await startWorker({
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
});
logger.info({ port: worker.port }, "worker listening");

async function shutdown(): Promise<void> {
  await worker.stop();
  await bus.close();
  redis.destroy();
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
