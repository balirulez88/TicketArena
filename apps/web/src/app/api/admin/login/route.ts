import { parseAdminEnv } from "@/server/env";
import { handleAdminLogin } from "@/server/identity/admin-login";

export async function POST(request: Request): Promise<Response> {
  const env = parseAdminEnv(process.env);
  return handleAdminLogin(request, {
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    now: new Date(),
  });
}
