import { z } from "zod";

const workerEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  NATS_URL: z.url({ protocol: /^(nats|tls)$/ }),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
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
