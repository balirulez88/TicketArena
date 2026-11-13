import { z } from "zod";

export interface Config {
  root: string;
  ref: string;
  host: string;
  port: number;
  staleAfterMs: number;
  refreshSeconds: number;
  failureLimit: number;
}

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

const schema = z.object({
  root: z.string().min(1, "--root (RALPH_CC_ROOT) must name the repository checkout"),
  ref: z.string().regex(/^[\w./-]+$/, "--ref (RALPH_CC_REF) must be a plain Git ref name"),
  // Loopback only: the page shows review findings, branch names and paths from a private
  // workspace, and nothing here authenticates a viewer.
  host: z.enum(LOOPBACK, {
    message: `--host (RALPH_CC_HOST) must be one of ${LOOPBACK.join(", ")}`,
  }),
  port: z.coerce.number().int().min(1).max(65_535, "--port (RALPH_CC_PORT) must be 1-65535"),
  staleAfterMinutes: z.coerce
    .number()
    .positive("--stale-after (RALPH_CC_STALE_AFTER_MINUTES) must be positive"),
  refreshSeconds: z.coerce
    .number()
    .int()
    .min(0, "--refresh (RALPH_CC_REFRESH_SECONDS) must be 0 (off) or more"),
});

const FLAGS: Record<string, keyof z.input<typeof schema>> = {
  "--root": "root",
  "--ref": "ref",
  "--host": "host",
  "--port": "port",
  "--stale-after": "staleAfterMinutes",
  "--refresh": "refreshSeconds",
};

const ENV: Record<keyof z.input<typeof schema>, string> = {
  root: "RALPH_CC_ROOT",
  ref: "RALPH_CC_REF",
  host: "RALPH_CC_HOST",
  port: "RALPH_CC_PORT",
  staleAfterMinutes: "RALPH_CC_STALE_AFTER_MINUTES",
  refreshSeconds: "RALPH_CC_REFRESH_SECONDS",
};

/**
 * Flags win over environment variables, which win over defaults. `defaultRoot` is resolved by
 * the caller (the main checkout that owns `.ralph/`). Throws naming the offending setting.
 */
export function parseConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  defaultRoot: string,
): Config {
  const input: Record<string, string> = {
    root: defaultRoot,
    ref: "main",
    host: "127.0.0.1",
    port: "4319",
    staleAfterMinutes: "15",
    refreshSeconds: "30",
  };
  for (const [key, name] of Object.entries(ENV)) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      input[key] = value;
    }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const key = FLAGS[flag];
    const value = argv[index + 1];
    if (key === undefined || value === undefined) {
      throw new Error(
        `unknown or incomplete option ${flag}; options: ${Object.keys(FLAGS).join(", ")}`,
      );
    }
    input[key] = value;
    index += 1;
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join("; "));
  }
  const { staleAfterMinutes, ...rest } = result.data;
  return { ...rest, staleAfterMs: staleAfterMinutes * 60_000, failureLimit: 25 };
}
