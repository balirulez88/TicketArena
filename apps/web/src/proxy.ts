import { type NextRequest, NextResponse } from "next/server";
import { parseServerEnv } from "./server/env";
import {
  issueSessionCookieValue,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifySessionCookieValue,
} from "./server/identity/identity";

/**
 * Issues the guest session on first visit. A cookie that fails verification is replaced, never
 * trusted or repaired (ADR 0012). Known MVP limitation: clearing cookies yields a new session,
 * so per-session guest limits can be bypassed until authentication arrives in phase 2.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { SESSION_SECRET } = parseServerEnv(process.env);
  const response = NextResponse.next();

  const existing = request.cookies.get(SESSION_COOKIE)?.value;
  if (existing && (await verifySessionCookieValue(SESSION_SECRET, existing))) {
    return response;
  }

  response.cookies.set(SESSION_COOKIE, await issueSessionCookieValue(SESSION_SECRET), {
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
