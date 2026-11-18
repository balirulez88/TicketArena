import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export interface TestEnv {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly natsUrl: string;
  /** Upstash-compatible REST endpoint; defaults to the `redis-http` service in docker-compose.yml. */
  readonly upstashRedisRestUrl: string;
  readonly upstashRedisRestToken: string;
}

// Defaults match docker-compose.yml, so CI (which starts the compose services) needs no extra
// variables for the Upstash contract suites.
const DEFAULT_UPSTASH_REDIS_REST_URL = "http://localhost:8079";
const DEFAULT_UPSTASH_REDIS_REST_TOKEN = "ticketarena";

const REQUIRED = ["TEST_DATABASE_URL", "TEST_REDIS_URL", "TEST_NATS_URL"] as const;

const testEnvSchema = z.object({
  TEST_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  TEST_REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  TEST_NATS_URL: z.url({ protocol: /^(nats|tls)$/ }),
  TEST_UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https?$/ }).optional(),
  TEST_UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
});

const HINT =
  "Integration tests run against real Postgres, Redis and NATS and are never skipped. " +
  "Start them with `pnpm infra:up` and copy .env.test.example to .env.test " +
  "(CI and the Ralph sandbox set these variables themselves).";

/**
 * Validates the test service URLs. Missing variables are an error, not a reason to skip:
 * a skipped integration test would let a slice pass the gate without exercising real locks,
 * Lua atomicity or JetStream acks.
 */
export function parseTestEnv(env: Readonly<Record<string, string | undefined>>): TestEnv {
  const missing = REQUIRED.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(`${HINT}\n${missing.map((name) => `${name} is not set`).join("\n")}`);
  }
  const result = testEnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${String(issue.path[0])}: ${issue.message}`,
    );
    throw new Error(`${HINT}\n${problems.join("\n")}`);
  }
  return {
    databaseUrl: result.data.TEST_DATABASE_URL,
    redisUrl: result.data.TEST_REDIS_URL,
    natsUrl: result.data.TEST_NATS_URL,
    upstashRedisRestUrl: result.data.TEST_UPSTASH_REDIS_REST_URL ?? DEFAULT_UPSTASH_REDIS_REST_URL,
    upstashRedisRestToken:
      result.data.TEST_UPSTASH_REDIS_REST_TOKEN ?? DEFAULT_UPSTASH_REDIS_REST_TOKEN,
  };
}

const LOCAL_ENV_FILE = fileURLToPath(new URL("../../../.env.test", import.meta.url));

/**
 * The test boundary: the only place test code reads the process environment. A repo-root
 * `.env.test` is loaded for local runs; variables already set (CI, sandbox) take precedence.
 */
export function loadTestEnv(): TestEnv {
  if (existsSync(LOCAL_ENV_FILE)) {
    const alreadySet = { ...process.env };
    process.loadEnvFile(LOCAL_ENV_FILE);
    Object.assign(process.env, alreadySet);
  }
  return parseTestEnv(process.env);
}
