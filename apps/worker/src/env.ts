import { z } from "zod";

const workerEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  NATS_URL: z.url({ protocol: /^(nats|tls)$/ }),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
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
