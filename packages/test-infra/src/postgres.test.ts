import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { setupTestDatabase } from "./index";

const database = setupTestDatabase();

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

describe("setupTestDatabase", () => {
  it("gives the file its own database, not the shared template", async () => {
    const [row] = await query<{ name: string }>("SELECT current_database() AS name");
    expect(row?.name).toMatch(/^ta_t_[0-9a-f]{12}$/);
    expect(row?.name).not.toBe(inject("ticketarenaTemplateDatabase"));
  });

  it("is a clone of the migrated template, so committed tables exist", async () => {
    const rows = await query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(rows.map((row) => row.table_name)).toContain("outbox_events");
  });

  it("runs Postgres 17", async () => {
    const [row] = await query<{ server_version_num: string }>("SHOW server_version_num");
    expect(Number(row?.server_version_num)).toBeGreaterThanOrEqual(170_000);
  });
});
