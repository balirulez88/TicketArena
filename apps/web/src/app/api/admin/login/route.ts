import { parseAdminEnv } from "@/server/env";
import { handleAdminLogin } from "@/server/identity/admin-login";
import { createWebLogger } from "@/server/logger";
import { createLazyAdminRateLimiter } from "@/server/upstash-metrics";

const logger = createWebLogger();

// The same Upstash-backed limiter the tRPC admin actions use, so the login window is global.
const rateLimiter = createLazyAdminRateLimiter({ readEnv: () => process.env, logger });

export async function POST(request: Request): Promise<Response> {
  const env = parseAdminEnv(process.env);
  return handleAdminLogin(request, {
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    now: new Date(),
    rateLimiter,
    logger,
  });
}
