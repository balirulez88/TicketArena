import type { Logger } from "@ticketarena/contracts";
import { NextResponse } from "next/server";
import type { RateLimiter } from "../rate-limiter";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  adminPasswordMatches,
  issueAdminCookieValue,
} from "./admin-session";

const LOGIN_PATH = "/admin/login";

/** The admin limiter's action name for login attempts (key `admin:rate:login`). */
export const ADMIN_LOGIN_ACTION = "login";

export interface AdminLoginConfig {
  readonly adminPassword: string;
  readonly sessionSecret: string;
  readonly now: Date;
  /** The shared admin limiter, resolved per attempt so a misconfigured store also fails closed. */
  readonly rateLimiter: () => RateLimiter;
  readonly logger: Logger;
}

// Strict: the cookie authorises operator actions, so no cross-site request may carry it.
const cookieOptions = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;

function backToLogin(request: Request, params: Record<string, string>): NextResponse {
  const url = new URL(LOGIN_PATH, request.url);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return NextResponse.redirect(url, 303);
}

/**
 * Handles the login form (`password` field). Always answers with a 303 redirect so the browser
 * follows with a GET: to `/admin` with the signed cookie, or back to the login page with an error
 * that never says which part was wrong.
 *
 * Every attempt first takes the global admin limit for `login` (one per 10 s), right or wrong, so
 * guessing is slowed whatever the outcome. A refused attempt never reaches the password compare.
 * The limit is global, not per client: an attacker can keep the real operator waiting, which the
 * demo accepts in exchange for needing no per-IP state.
 */
export async function handleAdminLogin(
  request: Request,
  config: AdminLoginConfig,
): Promise<Response> {
  let decision: Awaited<ReturnType<RateLimiter["acquire"]>>;
  try {
    decision = await config.rateLimiter().acquire(ADMIN_LOGIN_ACTION);
  } catch (error) {
    // Fail closed, as the other admin actions do: without the limiter there is no guess limit.
    config.logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "admin login refused: the rate limiter is unavailable",
    );
    return backToLogin(request, { error: "unavailable" });
  }
  if (!decision.allowed) {
    const retrySeconds = String(Math.max(Math.ceil(decision.retryAfterMs / 1000), 1));
    const response = backToLogin(request, { error: "rate-limited", retry: retrySeconds });
    response.headers.set("retry-after", retrySeconds);
    return response;
  }

  const form = await request.formData().catch(() => undefined);
  const supplied = form?.get("password");
  const valid =
    typeof supplied === "string" &&
    (await adminPasswordMatches(config.sessionSecret, config.adminPassword, supplied));

  if (!valid) {
    return backToLogin(request, { error: "invalid" });
  }
  const response = NextResponse.redirect(new URL("/admin", request.url), 303);
  response.cookies.set(
    ADMIN_COOKIE,
    await issueAdminCookieValue(config.sessionSecret, config.now),
    { ...cookieOptions, maxAge: ADMIN_SESSION_TTL_SECONDS },
  );
  return response;
}

/**
 * Ends the operator session in this browser by expiring the cookie. There is no server-side
 * session store, so a copy of the cookie taken earlier stays valid until its own 8 h expiry.
 */
export function handleAdminLogout(request: Request): Response {
  const response = NextResponse.redirect(new URL(LOGIN_PATH, request.url), 303);
  response.cookies.set(ADMIN_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  return response;
}
