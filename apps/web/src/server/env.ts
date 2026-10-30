import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  SESSION_SECRET: z
    .string()
    .refine((secret) => new TextEncoder().encode(secret).length >= 32, "must be at least 32 bytes"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Validates server configuration at the boundary and fails fast with every problem listed.
 *
 * Parsing is an explicit call (not a module-level side effect) so `next build` and unit tests
 * can import server code without a fully populated environment.
 */
export function parseServerEnv(source: Readonly<Record<string, string | undefined>>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid server environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
