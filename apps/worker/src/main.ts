import { createPrismaClient } from "@ticketarena/db";
import { connectJetStreamMessageBus } from "@ticketarena/messaging";
import { parseWorkerEnv } from "./env.js";
import { startWorker } from "./worker.js";

const env = parseWorkerEnv(process.env);
const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, driver: "pg" });
const bus = await connectJetStreamMessageBus({ servers: env.NATS_URL });
const worker = await startWorker({ bus, prisma, port: env.PORT });
process.stdout.write(`worker listening on :${worker.port}\n`);

async function shutdown(): Promise<void> {
  await worker.stop();
  await bus.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
