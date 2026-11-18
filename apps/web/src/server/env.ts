import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  /** node-redis connection for the waiting-room queue (`redis://` locally, `rediss://` hosted). */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  SESSION_SECRET: z
    .string()
    .refine((secret) => new TextEncoder().encode(secret).length >= 32, "must be at least 32 bytes"),
});

const sessionEnvSchema = serverEnvSchema.pick({ SESSION_SECRET: true });

const metricsEnvSchema = serverEnvSchema.pick({
  UPSTASH_REDIS_REST_URL: true,
  UPSTASH_REDIS_REST_TOKEN: true,
});

const queueEnvSchema = serverEnvSchema.pick({ REDIS_URL: true });

const databaseEnvSchema = serverEnvSchema.pick({ DATABASE_URL: true });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

type EnvSource = Readonly<Record<string, string | undefined>>;

function parseEnv<T extends z.ZodType>(schema: T, source: EnvSource, label: string): z.output<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid ${label} environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Validates server configuration at the boundary and fails fast with every problem listed.
 *
 * Parsing is an explicit call (not a module-level side effect) so `next build` and unit tests
 * can import server code without a fully populated environment.
 */
export function parseServerEnv(source: EnvSource): ServerEnv {
  return parseEnv(serverEnvSchema, source, "server");
}

/**
 * Validates only the session configuration, for the proxy, which runs on every page request and
 * must not fail because of settings it never uses (e.g. the Redis token).
 */
export function parseSessionEnv(source: EnvSource): Pick<ServerEnv, "SESSION_SECRET"> {
  return parseEnv(sessionEnvSchema, source, "session");
}

/** Validates only the database URL, for the tRPC context, which needs nothing else yet. */
export function parseDatabaseEnv(source: EnvSource): Pick<ServerEnv, "DATABASE_URL"> {
  return parseEnv(databaseEnvSchema, source, "database");
}

/**
 * Validates only the Upstash settings, resolved lazily by the metrics dependency so a missing
 * or invalid value breaks only procedures that record metrics, never health or session requests.
 */
export function parseMetricsEnv(
  source: EnvSource,
): Pick<ServerEnv, "UPSTASH_REDIS_REST_URL" | "UPSTASH_REDIS_REST_TOKEN"> {
  return parseEnv(metricsEnvSchema, source, "metrics");
}

/**
 * Validates only the waiting-room Redis URL, resolved lazily by the queue store so a missing value
 * breaks only the queue procedures.
 */
export function parseQueueEnv(source: EnvSource): Pick<ServerEnv, "REDIS_URL"> {
  return parseEnv(queueEnvSchema, source, "queue");
}
