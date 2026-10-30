import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  SESSION_SECRET: z
    .string()
    .refine((secret) => new TextEncoder().encode(secret).length >= 32, "must be at least 32 bytes"),
});

const sessionEnvSchema = serverEnvSchema.pick({ SESSION_SECRET: true });

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
