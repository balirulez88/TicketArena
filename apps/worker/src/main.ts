import { createPrismaClient } from "@ticketarena/db";
import { connectJetStreamMessageBus } from "@ticketarena/messaging";
import { parseWorkerEnv } from "./env.js";
import { createWorkerLogger } from "./logger.js";
import { startWorker } from "./worker.js";

const env = parseWorkerEnv(process.env);
const logger = createWorkerLogger();
const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, driver: "pg" });
const bus = await connectJetStreamMessageBus({ servers: env.NATS_URL });
const worker = await startWorker({ bus, prisma, port: env.PORT, logger });
logger.info({ port: worker.port }, "worker listening");

async function shutdown(): Promise<void> {
  await worker.stop();
  await bus.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
