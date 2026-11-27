import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prismaCli = require.resolve("prisma/build/index.js");

// The test database is cloned from a template built by applying every committed migration
// (test-infra's ensureTemplateDatabase), so it is exactly the database the migrations produce.
const database = setupTestDatabase();

/**
 * The SQL `prisma migrate diff` would run to turn the migrated database into the schema's
 * datamodel; empty when the two agree. `--exit-code` makes a difference exit 2, which execFile
 * reports as a rejection carrying the script on stdout.
 */
async function driftScript(databaseUrl: string): Promise<string> {
  const args = [
    prismaCli,
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema.prisma",
    "--script",
    "--exit-code",
  ];
  try {
    await run(process.execPath, args, {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    return "";
  } catch (error) {
    if (isDiffExit(error)) {
      return error.stdout.trim();
    }
    throw error;
  }
}

function isDiffExit(error: unknown): error is { code: number; stdout: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 2 &&
    "stdout" in error &&
    typeof error.stdout === "string"
  );
}

describe("Prisma schema drift (TD-030)", () => {
  it("the schema declares exactly what the committed migrations build, in all three service schemas", async () => {
    const script = await driftScript(database.url);

    // On failure the message is the migration Prisma would generate: each statement names the
    // table and column where schema.prisma and the migrations disagree.
    expect(script, `schema.prisma and the migrations disagree:\n${script}`).toBe("");
  }, 60_000);
});
