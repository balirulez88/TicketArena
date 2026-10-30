import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { proxy } from "./proxy";
import { issueSessionCookieValue } from "./server/identity/identity";

const SESSION_COOKIE = "ta_session";
const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example.com/ticketarena?sslmode=require");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy session issuing", () => {
  test("a first visit receives a signed, httpOnly, Secure, SameSite=Lax ta_session cookie valid for 7 days", async () => {
    const response = await proxy(new NextRequest("https://ticketarena.example/"));

    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SEVEN_DAYS_IN_SECONDS,
    });
  });

  test("two first visits receive different sessions", async () => {
    const first = await proxy(new NextRequest("https://ticketarena.example/"));
    const second = await proxy(new NextRequest("https://ticketarena.example/"));

    expect(first.cookies.get(SESSION_COOKIE)?.value).not.toBe(
      second.cookies.get(SESSION_COOKIE)?.value,
    );
  });

  test("a validly signed cookie is kept: no new session is issued", async () => {
    const value = await issueSessionCookieValue("s".repeat(32));
    const request = new NextRequest("https://ticketarena.example/", {
      headers: { cookie: `${SESSION_COOKIE}=${value}` },
    });

    const response = await proxy(request);

    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  test("a cookie with an invalid signature is replaced by a new session", async () => {
    const forged = await issueSessionCookieValue("x".repeat(32));
    const request = new NextRequest("https://ticketarena.example/", {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });

    const response = await proxy(request);

    const reissued = response.cookies.get(SESSION_COOKIE)?.value;
    expect(reissued).toBeTruthy();
    expect(reissued).not.toBe(forged);
  });
});
