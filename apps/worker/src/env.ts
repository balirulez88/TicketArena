import { z } from "zod";

/**
 * Bounds on every Redis call of the worker (ticket 63), so a stopped or hung Redis fails one
 * ticker or reaper pass within about two seconds instead of stalling it. Connecting (TCP plus
 * handshake) may take a cross-region round trip or a TLS setup, hence more room than a command,
 * which Redis answers in well under a millisecond when healthy.
 */
export const DEFAULT_REDIS_TIMEOUTS = { connectTimeoutMs: 2000, commandTimeoutMs: 1000 } as const;

const workerEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  NATS_URL: z.url({ protocol: /^(nats|tls)$/ }),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Bound on opening a Redis connection, handshake included (ms). */
  REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REDIS_TIMEOUTS.connectTimeoutMs),
  /** Bound on one Redis command once connected (ms). */
  REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REDIS_TIMEOUTS.commandTimeoutMs),
  /** Admissions per second per event, also the token bucket's burst (ADR 0008). */
  ADMIT_RATE_PER_SECOND: z.coerce.number().int().positive().default(10),
  /** Cap on each event's concurrently active shoppers. */
  MAX_ACTIVE: z.coerce.number().int().positive().default(100),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Validates worker configuration at the boundary and fails fast with every problem listed. */
export function parseWorkerEnv(source: Readonly<Record<string, string | undefined>>): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid worker environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
