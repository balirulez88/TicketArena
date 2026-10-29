import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { loadTestEnv } from "./env";
import { ensureTemplateDatabase } from "./postgres";
import type {} from "./provided-context";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/prisma/migrations", import.meta.url));

/**
 * Vitest global setup for any package with integration tests. Runs once per test run: checks
 * that all three services are configured (failing the whole run otherwise) and makes sure the
 * migrated template database exists, so each test file only pays for a cheap clone.
 */
export async function setup(project: TestProject): Promise<void> {
  try {
    const env = loadTestEnv();
    const template = await ensureTemplateDatabase(env.databaseUrl, MIGRATIONS_DIR);
    project.provide("ticketarenaTemplateDatabase", template);
  } catch (error) {
    // Vitest 5 crashes while source-mapping the stack of an error thrown from global setup,
    // hiding the message. Print it ourselves and rethrow without frames to map.
    const message = `test-infra global setup failed:\n${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    const failure = new Error(message);
    failure.stack = message;
    throw failure;
  }
}
