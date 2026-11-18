import { type NextRequest, NextResponse } from "next/server";
import { parseSessionEnv } from "./server/env";
import { ADMIN_COOKIE, verifyAdminCookieValue } from "./server/identity/admin-session";
import {
  issueSessionCookieValue,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifySessionCookieValue,
} from "./server/identity/identity";

function withSessionCookie(source: Headers, value: string): Headers {
  const headers = new Headers(source);
  const others = (source.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !pair.startsWith(`${SESSION_COOKIE}=`));
  headers.set("cookie", [...others, `${SESSION_COOKIE}=${value}`].join("; "));
  return headers;
}

export const ADMIN_LOGIN_PATH = "/admin/login";

function isGuardedAdminPath(pathname: string): boolean {
  return (pathname === "/admin" || pathname.startsWith("/admin/")) && pathname !== ADMIN_LOGIN_PATH;
}

/**
 * Guards the admin pages, then issues the guest session on first visit. A cookie that fails verification is replaced, never
 * trusted or repaired (ADR 0012). Known MVP limitation: clearing cookies yields a new session,
 * so per-session guest limits can be bypassed until authentication arrives in phase 2.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { SESSION_SECRET } = parseSessionEnv(process.env);

  // Page-level guard only: it keeps operators' pages away from visitors, but the data behind them
  // is protected by `adminProcedure`, which checks the same cookie on every call.
  if (
    isGuardedAdminPath(request.nextUrl.pathname) &&
    !(await verifyAdminCookieValue(
      SESSION_SECRET,
      request.cookies.get(ADMIN_COOKIE)?.value,
      new Date(),
    ))
  ) {
    return NextResponse.redirect(new URL(ADMIN_LOGIN_PATH, request.url));
  }

  const existing = request.cookies.get(SESSION_COOKIE)?.value;
  if (existing && (await verifySessionCookieValue(SESSION_SECRET, existing))) {
    return NextResponse.next();
  }

  const issued = await issueSessionCookieValue(SESSION_SECRET);
  // Forwarded on the downstream request too: without it the first request would run under an
  // ephemeral session the browser never receives.
  const response = NextResponse.next({
    request: { headers: withSessionCookie(request.headers, issued) },
  });
  response.cookies.set(SESSION_COOKIE, issued, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
