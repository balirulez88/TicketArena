import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, inject } from "vitest";
import { loadTestEnv } from "./env";
import { deleteStreams } from "./nats";
import { createDatabaseFromTemplate, dropDatabase } from "./postgres";
import type {} from "./provided-context";
import { deleteRedisKeys } from "./redis";
import { type RedisStandIn, type RedisStandInMode, startRedisStandIn } from "./redis-stand-in";
import { deleteUpstashKeys, upstashCommand } from "./upstash";

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

export type { RedisStandIn, RedisStandInMode } from "./redis-stand-in";

export interface TestRedisStandIn extends Omit<RedisStandIn, "close"> {
  /** Every key this file writes through the stand-in must start with this prefix. */
  readonly prefix: string;
}

/**
 * A Redis the file can stop, hang and bring back (`setMode`) on one fixed local port, in front of
 * the real test Redis; it starts in `initialMode`. For outage tests: no mock of our own modules.
 */
export function setupRedisStandIn(initialMode: RedisStandInMode = "forward"): TestRedisStandIn {
  const env = loadTestEnv();
  const prefix = `test:${randomBytes(4).toString("hex")}:`;
  let standIn: RedisStandIn | undefined;
  beforeAll(async () => {
    standIn = await startRedisStandIn(env.redisUrl, initialMode);
  });
  afterAll(async () => {
    await standIn?.close();
    await deleteRedisKeys(env.redisUrl, prefix);
  });
  const started = (): RedisStandIn => {
    if (standIn === undefined) {
      throw new Error("setupRedisStandIn: the stand-in is available only inside tests and hooks");
    }
    return standIn;
  };
  return {
    prefix,
    get url() {
      return started().url;
    },
    setMode: (mode) => started().setMode(mode),
    openConnections: () => started().openConnections(),
  };
}

export interface TestUpstash {
  /** Upstash-compatible REST endpoint (Upstash itself, or the compose `redis-http` proxy). */
  readonly url: string;
  readonly token: string;
  /** Every key this file writes must start with this prefix. */
  readonly prefix: string;
  /** Runs one raw command, e.g. to inspect keys an adapter wrote; rejects on an error reply. */
  command(args: readonly (string | number)[]): Promise<unknown>;
}

export function setupTestUpstash(): TestUpstash {
  const env = loadTestEnv();
  const endpoint = { url: env.upstashRedisRestUrl, token: env.upstashRedisRestToken };
  const prefix = `test:${randomBytes(4).toString("hex")}:`;
  afterAll(() => deleteUpstashKeys(endpoint, prefix));
  return {
    ...endpoint,
    prefix,
    command: (args) => upstashCommand(endpoint, args),
  };
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
