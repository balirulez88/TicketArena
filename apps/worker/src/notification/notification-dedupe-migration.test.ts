import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupEmptyTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockNotificationProvider, type MockNotificationProvider } from "./mock-provider.js";
import { createNotificationHandler } from "./notification-handler.js";

// The cutover as `prisma migrate deploy` runs it: the database stops at the last migration before
// the dedupe key, gets the rows a pre-migration worker left (one PENDING, one SENT), then takes the
// dedupe-key migration, whose backfill keys every row `event:<sourceEventId>`. Only then does the
// new worker see the original refund event and a re-announcement of the same refund.
const database = setupEmptyTestDatabase();
const nats = setupTestNats();
const MIGRATIONS = resolve(__dirname, "../../../../packages/db/prisma/migrations");
const DEDUPE_MIGRATION = "20261129000000_notification_dedupe_key";
const NOW = new Date("2027-03-01T12:10:00.000Z");

let prisma: PrismaClient;
let bus: MessageBus;
let sequence = 0;

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function apply(names: readonly string[]): Promise<void> {
  for (const name of names) {
    // No parameters, so the driver sends the whole file as one simple query.
    await prisma.$executeRawUnsafe(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
  }
}

function refunded(email: string) {
  const orderId = randomUUID();
  return {
    id: randomUUID(),
    type: "payment.refunded",
    version: 1,
    occurredAt: "2027-03-01T12:06:05.000Z",
    correlationId: randomUUID(),
    causationId: randomUUID(),
    orderId,
    payload: {
      paymentId: randomUUID(),
      orderId,
      amount: 12_500,
      currency: "EUR",
      refundedAt: "2027-03-01T12:06:04.000Z",
      contact: { email },
    },
  };
}

type Refunded = ReturnType<typeof refunded>;

const pendingCase = {
  original: refunded("buyer+migrated-pending@example.com"),
  rowId: randomUUID(),
};
const sentCase = { original: refunded("buyer+migrated-sent@example.com"), rowId: randomUUID() };

/** The pre-migration worker's insert for the EMAIL channel, column for column. */
async function preMigrationRow(envelope: Refunded, rowId: string, status: "PENDING" | "SENT") {
  await prisma.$executeRaw`
    INSERT INTO "notification"."notifications"
      ("id", "sourceEventId", "channel", "recipient", "template", "status", "createdAt", "sentAt")
    VALUES (${rowId}::uuid, ${envelope.id}, 'EMAIL', ${envelope.payload.contact.email},
      'refund-completed', ${status}::"notification"."NotificationStatus", ${NOW},
      ${status === "SENT" ? NOW : null})`;
}

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  const names = migrationNames();
  const dedupe = names.indexOf(DEDUPE_MIGRATION);
  await apply(names.slice(0, dedupe));
  await preMigrationRow(pendingCase.original, pendingCase.rowId, "PENDING");
  await preMigrationRow(sentCase.original, sentCase.rowId, "SENT");
  await apply(names.slice(dedupe));

  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

/** Delivers the envelope once and returns how many messages the consumer checkpointed (acked). */
async function deliver(envelope: Refunded, provider: MockNotificationProvider): Promise<number> {
  sequence += 1;
  const consumer = `notification-migrated${sequence}`;
  const subject = `ta.order.${consumer}`;
  const runner = await createConsumerRunner({
    bus,
    prisma,
    service: "notification",
    consumer,
    filterSubject: subject,
    ...createNotificationHandler({
      prisma,
      provider,
      clock: { now: () => NOW },
      newId: randomUUID,
    }),
  });
  await bus.publish({ subject, data: JSON.stringify(envelope), msgId: envelope.id });
  await runner.pollOnce();
  return prisma.notificationProcessedMessage.count({ where: { consumer } });
}

function rowsTo(email: string) {
  return prisma.notification.findMany({ where: { recipient: email } });
}

describe("notification dedupe key across the migration (refund rows backfilled event:<id>)", () => {
  it("a PENDING row from before the migration is sent once under its original id, then a re-announcement sends nothing", async () => {
    const { original, rowId } = pendingCase;
    const reannounced = { ...original, id: randomUUID() };
    const email = original.payload.contact.email;
    expect(await rowsTo(email)).toMatchObject([
      { id: rowId, dedupeKey: `event:${original.id}`, status: "PENDING" },
    ]);
    const provider = createMockNotificationProvider();

    expect(await deliver(original, provider)).toBe(1);
    expect(await deliver(reannounced, provider)).toBe(1);

    expect(provider.deliveries()).toEqual([
      { idempotencyKey: rowId, channel: "EMAIL", recipient: email, template: "refund-completed" },
    ]);
    expect((await rowsTo(email)).map((row) => [row.id, row.dedupeKey, row.status])).toEqual([
      [rowId, `refund:${original.payload.paymentId}:refund-completed`, "SENT"],
    ]);
  });

  it("a SENT row from before the migration is not sent again, neither for the original event nor a re-announcement", async () => {
    const { original, rowId } = sentCase;
    const reannounced = { ...original, id: randomUUID() };
    const email = original.payload.contact.email;
    const provider = createMockNotificationProvider();

    expect(await deliver(original, provider)).toBe(1);
    expect(await deliver(reannounced, provider)).toBe(1);

    expect(provider.deliveries()).toEqual([]);
    expect((await rowsTo(email)).map((row) => [row.id, row.dedupeKey, row.status])).toEqual([
      [rowId, `refund:${original.payload.paymentId}:refund-completed`, "SENT"],
    ]);
  });
});
