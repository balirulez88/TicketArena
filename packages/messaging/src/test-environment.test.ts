import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createPrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { describe, expect, it } from "vitest";

// Proves the package is wired into the workspace's test run: its tests are discovered, executed
// and reach the real Postgres and JetStream the relay and consumer runner are tested against.
const database = setupTestDatabase();
const nats = setupTestNats();

describe("messaging test environment", () => {
  it("reaches a migrated Postgres with the outbox table", async () => {
    const prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
    try {
      const rows = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_name = 'outbox_events'`;
      expect(rows).toEqual([{ table_name: "outbox_events" }]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("reaches a JetStream-enabled NATS server", async () => {
    const connection = await connect({ servers: nats.url });
    try {
      const info = await (await jetstreamManager(connection)).getAccountInfo();
      expect(info.limits).toBeDefined();
    } finally {
      await connection.close();
    }
  });
});
