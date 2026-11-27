import { createPrismaClient } from "@ticketarena/db";
import { republishOutboxEvents } from "@ticketarena/messaging";
import { parseRepublishCommand } from "./outbox-republish.js";

// Entry point for `pnpm --filter @ticketarena/worker outbox:republish` (runbook:
// docs/messaging/consumer-recovery.md). It moves one service's PUBLISHED outbox rows published in a
// time range back to PENDING, so the relay publishes them again under their original ids; a refusal
// (empty range, no operator or reason) changes nothing and exits non-zero with the reason.
const command = parseRepublishCommand(process.argv.slice(2), process.env);
const prisma = createPrismaClient({ connectionString: command.databaseUrl, driver: "pg" });
try {
  const moved = await republishOutboxEvents(prisma, {
    service: command.service,
    publishedFrom: command.publishedFrom,
    publishedTo: command.publishedTo,
    operator: command.operator,
    reason: command.reason,
  });
  process.stdout.write(
    `re-published ${moved} ${command.service} outbox row(s) published in [${command.publishedFrom.toISOString()}, ${command.publishedTo.toISOString()}) as PENDING (operator ${command.operator})\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
