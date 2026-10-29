import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, inject } from "vitest";
import { loadTestEnv } from "./env";
import { deleteStreams } from "./nats";
import { createDatabaseFromTemplate, dropDatabase } from "./postgres";
import type {} from "./provided-context";
import { deleteRedisKeys } from "./redis";

export type { TestEnv } from "./env";
export { loadTestEnv, parseTestEnv } from "./env";

// Isolation is per test FILE: files run in parallel, tests inside a file share one namespace
// and run sequentially. Each helper registers its own cleanup, so a file cannot forget it.

export interface TestDatabase {
  /** URL of a fresh database cloned from the migrated template; valid inside tests and hooks. */
  readonly url: string;
}

export function setupTestDatabase(): TestDatabase {
  const env = loadTestEnv();
  let url: string | undefined;
  beforeAll(async () => {
    url = await createDatabaseFromTemplate(env.databaseUrl, inject("ticketarenaTemplateDatabase"));
  });
  afterAll(async () => {
    if (url !== undefined) {
      await dropDatabase(env.databaseUrl, url);
    }
  });
  return {
    get url(): string {
      if (url === undefined) {
        throw new Error("setupTestDatabase: the URL is available only inside tests and hooks");
      }
      return url;
    },
  };
}

export interface TestRedis {
  readonly url: string;
  /** Every key this file writes must start with this prefix. */
  readonly prefix: string;
}

export function setupTestRedis(): TestRedis {
  const env = loadTestEnv();
  const prefix = `test:${randomBytes(4).toString("hex")}:`;
  afterAll(() => deleteRedisKeys(env.redisUrl, prefix));
  return { url: env.redisUrl, prefix };
}

export interface TestNats {
  readonly url: string;
  /** Every stream this file creates must start with this prefix (upper case, NATS-safe). */
  readonly streamPrefix: string;
  /** Root subject token for this file, e.g. `t1a2b3c4d`; use `${subjectPrefix}.ta.>`. */
  readonly subjectPrefix: string;
}

export function setupTestNats(): TestNats {
  const env = loadTestEnv();
  const id = randomBytes(4).toString("hex");
  const streamPrefix = `T_${id.toUpperCase()}_`;
  afterAll(() => deleteStreams(env.natsUrl, streamPrefix));
  return { url: env.natsUrl, streamPrefix, subjectPrefix: `t${id}` };
}
