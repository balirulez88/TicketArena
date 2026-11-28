import { createPrismaClient } from "@ticketarena/db";
import { requeueFailedOutboxEvent } from "@ticketarena/messaging";
import { parseRequeueCommand } from "./outbox-requeue.js";

// Entry point for `pnpm --filter @ticketarena/worker outbox:requeue` (runbook:
// docs/messaging/failed-outbox-event.md). It requeues one FAILED outbox row under its original id;
// a refusal (not FAILED, unknown id) changes nothing and exits non-zero with the reason.
const command = parseRequeueCommand(process.argv.slice(2), process.env);
const prisma = createPrismaClient({ connectionString: command.databaseUrl, driver: "pg" });
try {
  await requeueFailedOutboxEvent(prisma, {
    service: command.service,
    outboxId: command.outboxId,
    operator: command.operator,
    reason: command.reason,
  });
  process.stdout.write(
    `requeued ${command.service} outbox row ${command.outboxId} as PENDING (operator ${command.operator})\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
