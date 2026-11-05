import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function client(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("notification schema", () => {
  it("owns its own outbox, processed_messages and notifications tables", async () => {
    const rows = await client().$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'notification' ORDER BY table_name`;

    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(["notifications", "outbox_events", "processed_messages"]),
    );
  });

  it("makes (sourceEventId, channel) unique on notifications", async () => {
    const rows = await client().$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'notification' AND tablename = 'notifications'`;

    const unique = rows.filter((row) => /UNIQUE/i.test(row.indexdef));
    expect(unique.some((row) => /\("sourceEventId", channel\)/.test(row.indexdef))).toBe(true);
  });

  it("stores channel, recipient, template and a PENDING | SENT status", async () => {
    const rows = await client().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'notification' AND table_name = 'notifications'`;

    expect(rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(["id", "sourceEventId", "channel", "recipient", "template", "status"]),
    );

    const labels = await client().$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'notification' AND t.typname ILIKE '%status%'
      ORDER BY e.enumsortorder`;
    expect(labels.map((row) => row.enumlabel)).toEqual(["PENDING", "SENT"]);
  });
});
