import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPrismaClient } from "@ticketarena/db";
import { connectJetStreamConsumerAdmin } from "@ticketarena/messaging";
import { parseRecoverCommand, recoverServiceConsumer } from "./consumer-recover.js";
import { createServiceConsumers } from "./consumers.js";

// Entry point for `pnpm --filter @ticketarena/worker consumer:recover` (runbook:
// docs/messaging/consumer-recovery.md). Run it while no worker runs the consumer: it recreates the
// named durable consumer at the start ADR 0011's rules choose and prints the rule and sequence.
const command = parseRecoverCommand(process.argv.slice(2), process.env);
const prisma = createPrismaClient({ connectionString: command.databaseUrl, driver: "pg" });
try {
  const admin = await connectJetStreamConsumerAdmin({
    servers: command.natsUrl,
    ...(command.natsToken === undefined ? {} : { token: command.natsToken }),
  });
  try {
    // Only the names, filters and services are read; no handler runs here.
    const consumers = createServiceConsumers({
      prisma,
      clock: { now: () => new Date(), sleep: (ms: number) => delay(ms) },
      random: { next: Math.random },
      newId: randomUUID,
    });
    const report = await recoverServiceConsumer({
      admin,
      prisma,
      consumers,
      consumer: command.consumer,
      ignoreAckFloor: command.ignoreAckFloor,
      now: new Date(),
    });
    process.stdout.write(
      `recreated consumer ${command.consumer} (${report.service}, ${report.filterSubject}) by rule ${report.rule}, starting at stream sequence ${report.startSeq}\n`,
    );
  } finally {
    await admin.close();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
