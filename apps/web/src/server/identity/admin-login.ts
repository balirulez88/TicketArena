import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  adminPasswordMatches,
  issueAdminCookieValue,
} from "./admin-session";

export interface AdminLoginConfig {
  readonly adminPassword: string;
  readonly sessionSecret: string;
  readonly now: Date;
}

/**
 * Handles the login form (`password` field). Always answers with a 303 redirect so the browser
 * follows with a GET: to `/admin` with the signed cookie, or back to the login page with an error
 * that never says which part was wrong. Not rate-limited yet.
 */
export async function handleAdminLogin(
  request: Request,
  config: AdminLoginConfig,
): Promise<Response> {
  const form = await request.formData().catch(() => undefined);
  const supplied = form?.get("password");
  const valid =
    typeof supplied === "string" &&
    (await adminPasswordMatches(config.sessionSecret, config.adminPassword, supplied));

  if (!valid) {
    return NextResponse.redirect(new URL("/admin/login?error=invalid", request.url), 303);
  }
  const response = NextResponse.redirect(new URL("/admin", request.url), 303);
  response.cookies.set(
    ADMIN_COOKIE,
    await issueAdminCookieValue(config.sessionSecret, config.now),
    {
      httpOnly: true,
      secure: true,
      // Strict: the cookie authorises operator actions, so no cross-site request may carry it.
      sameSite: "strict",
      maxAge: ADMIN_SESSION_TTL_SECONDS,
      path: "/",
    },
  );
  return response;
}
