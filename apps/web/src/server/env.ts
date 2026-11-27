import { z } from "zod";

/**
 * Bounds on every node-redis call (ticket 63), so a stopped or hung Redis fails a request within
 * about two seconds instead of hanging it. Connecting (TCP plus handshake) may take a cross-region
 * round trip or a TLS setup, hence more room than a command, which Redis answers in well under a
 * millisecond when healthy.
 */
export const DEFAULT_REDIS_TIMEOUTS = { connectTimeoutMs: 2000, commandTimeoutMs: 1000 } as const;

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The Redis REST token travels in a header, so it must never cross a network in clear text;
 * plain http is allowed only to a local endpoint (the compose `redis-http` service).
 */
function isHttpsOrLocalHttp(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Zod runs this refinement even after `z.url()` failed; that check already reports it.
    return false;
  }
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname))
  );
}

/**
 * Neon names its PgBouncer endpoint `<endpoint>-pooler.<region>.neon.tech`. Each serverless
 * function instance opens its own connections, so the web app must go through the pooler; the
 * direct endpoint is for migrations and the long-running worker only (ADR 0013). Any other host
 * (local Postgres, tests) is not Neon and is accepted as is.
 */
function isPooledIfNeon(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Reported by `z.url()` already.
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".neon.tech")) {
    return true;
  }
  return host.split(".")[0]?.endsWith("-pooler") ?? false;
}

const atLeast32Bytes = z
  .string()
  .refine((secret) => new TextEncoder().encode(secret).length >= 32, "must be at least 32 bytes");

const serverEnvSchema = z.object({
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .refine(
      isPooledIfNeon,
      "must be Neon's pooled endpoint (host `<endpoint>-pooler.<region>.neon.tech`), not the direct one",
    ),
  /** `neon` (serverless driver, the default) for Neon; `pg` for a local or plain Postgres. */
  DATABASE_DRIVER: z.enum(["neon", "pg"]).default("neon"),
  UPSTASH_REDIS_REST_URL: z
    .url()
    .refine(isHttpsOrLocalHttp, "must be https, or http on localhost for local development"),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  /** node-redis connection for the waiting-room queue (`redis://` locally, `rediss://` hosted). */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Bound on opening a Redis connection, handshake included (ms); see `DEFAULT_REDIS_TIMEOUTS`. */
  REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REDIS_TIMEOUTS.connectTimeoutMs),
  /** Bound on one Redis command once connected (ms); see `DEFAULT_REDIS_TIMEOUTS`. */
  REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REDIS_TIMEOUTS.commandTimeoutMs),
  SESSION_SECRET: atLeast32Bytes,
  /**
   * HS256 key of the admission token (ADR 0008). Separate from SESSION_SECRET so rotating it
   * revokes every admission token without logging out any session.
   */
  ADMISSION_SECRET: atLeast32Bytes,
  /** The operator password for `/admin` (ADR 0012); only the login route reads it. */
  ADMIN_PASSWORD: z.string().min(12, "must be at least 12 characters"),
  /**
   * The worker's `/health` URL, the source of the dashboard's NATS figures. Optional: without it
   * the snapshot reports them as unavailable and everything else still works.
   */
  WORKER_HEALTH_URL: z.url({ protocol: /^https?$/ }).optional(),
});

const sessionEnvSchema = serverEnvSchema.pick({ SESSION_SECRET: true });

const admissionEnvSchema = serverEnvSchema.pick({ ADMISSION_SECRET: true });

const adminEnvSchema = serverEnvSchema.pick({ ADMIN_PASSWORD: true, SESSION_SECRET: true });

const metricsEnvSchema = serverEnvSchema.pick({
  UPSTASH_REDIS_REST_URL: true,
  UPSTASH_REDIS_REST_TOKEN: true,
});

const queueEnvSchema = serverEnvSchema.pick({
  REDIS_URL: true,
  REDIS_CONNECT_TIMEOUT_MS: true,
  REDIS_COMMAND_TIMEOUT_MS: true,
});

const workerHealthEnvSchema = z.object({
  WORKER_HEALTH_URL: serverEnvSchema.shape.WORKER_HEALTH_URL.unwrap(),
});

const databaseEnvSchema = serverEnvSchema.pick({ DATABASE_URL: true, DATABASE_DRIVER: true });

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

/**
 * Validates only the admission-token secret, resolved when a procedure first signs or verifies an
 * admission token, so a missing value never breaks requests that do not use admission.
 */
export function parseAdmissionEnv(source: EnvSource): Pick<ServerEnv, "ADMISSION_SECRET"> {
  return parseEnv(admissionEnvSchema, source, "admission");
}

/**
 * Validates the admin login configuration: the password to check and the secret that signs the
 * admin cookie. Only the login route calls it, so a missing password never breaks buyer requests.
 */
export function parseAdminEnv(
  source: EnvSource,
): Pick<ServerEnv, "ADMIN_PASSWORD" | "SESSION_SECRET"> {
  return parseEnv(adminEnvSchema, source, "admin");
}

/** Validates only the database URL and driver, for the tRPC context, which needs nothing else. */
export function parseDatabaseEnv(
  source: EnvSource,
): Pick<ServerEnv, "DATABASE_URL" | "DATABASE_DRIVER"> {
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
 * Validates only the waiting-room Redis URL and its timeouts, resolved lazily by the queue store so
 * a missing value breaks only the queue procedures.
 */
export function parseQueueEnv(
  source: EnvSource,
): Pick<ServerEnv, "REDIS_URL" | "REDIS_CONNECT_TIMEOUT_MS" | "REDIS_COMMAND_TIMEOUT_MS"> {
  return parseEnv(queueEnvSchema, source, "queue");
}

/**
 * Validates only the worker health URL, resolved lazily by the admin snapshot, so a missing value
 * only leaves the dashboard's NATS figures unavailable.
 */
export function parseWorkerHealthEnv(source: EnvSource): { WORKER_HEALTH_URL: string } {
  return parseEnv(workerHealthEnvSchema, source, "worker health");
}
