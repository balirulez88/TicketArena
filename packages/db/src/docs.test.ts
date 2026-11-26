import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("docs/database", () => {
  it("lists every table the migrations create in the public schema", async () => {
    prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE '\_prisma%'`;
    const doc = readFileSync(resolve(__dirname, "../../../docs/database/index.md"), "utf8");
    const documented = new Set(
      [...doc.matchAll(/^\| `([a-z_]+)`\s+\|/gm)].map((match) => match[1]),
    );

    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.map((row) => row.table_name).filter((name) => !documented.has(name))).toEqual([]);
  });

  it("names every index and unique constraint the migrations create", async () => {
    prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public' AND indexname NOT LIKE '%\_pkey' AND indexname NOT LIKE '\_prisma%'`;
    const doc = readFileSync(resolve(__dirname, "../../../docs/database/index.md"), "utf8");

    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.map((row) => row.name).filter((name) => !doc.includes(`\`${name}\``))).toEqual([]);
  });

  it("documents the duplicate-venue merge rule next to the migration that applies it", () => {
    const doc = readFileSync(resolve(__dirname, "../../../docs/database/index.md"), "utf8");
    const section = doc.split(/^### /m).find((part) => part.startsWith("Duplicate venue merge"));
    const migration = readFileSync(
      resolve(
        __dirname,
        "../prisma/migrations/20261030025000_merge_duplicate_venues/migration.sql",
      ),
      "utf8",
    );

    expect(migration).toContain("docs/database/index.md");
    expect(section).toBeDefined();
    expect(section).toContain("`20261030025000_merge_duplicate_venues`");
    expect(section).toContain("lowest `id`");
    expect(section).toMatch(/sections?.*merge/is);
    expect(section).toMatch(/rows?.*seats/is);
    expect(section).toMatch(/events/);
  });
});
