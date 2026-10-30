import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { proxy } from "./proxy";
import { issueSessionCookieValue } from "./server/identity/identity";
import { createTRPCContext } from "./server/trpc";

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

// Next forwards request-header overrides downstream as `x-middleware-request-<name>` headers on
// the proxy response; this is how the route handler's request sees what the proxy decided.
function downstreamRequest(original: NextRequest, response: Response): Request {
  const cookie = response.headers.get("x-middleware-request-cookie");
  return new Request(original.url, { headers: cookie ? { cookie } : {} });
}

describe("proxy and tRPC context agree on the first-visit session", () => {
  test("a cookie-less request resolves, downstream, to the session id of the issued cookie", async () => {
    const original = new NextRequest("https://ticketarena.example/");
    const response = await proxy(original);
    const issued = response.cookies.get(SESSION_COOKIE)?.value;

    const { principal } = await createTRPCContext({ req: downstreamRequest(original, response) });

    expect(issued).toBeTruthy();
    expect(principal.sessionId).toBe(issued?.split(".")[0]);
  });

  test("a request with an invalid signature resolves, downstream, to the reissued session", async () => {
    const forged = await issueSessionCookieValue("x".repeat(32));
    const original = new NextRequest("https://ticketarena.example/", {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });
    const response = await proxy(original);
    const issued = response.cookies.get(SESSION_COOKIE)?.value;

    const { principal } = await createTRPCContext({ req: downstreamRequest(original, response) });

    expect(issued).toBeTruthy();
    expect(principal.sessionId).toBe(issued?.split(".")[0]);
    expect(principal.sessionId).not.toBe(forged.split(".")[0]);
  });
});

describe("proxy configuration", () => {
  test("an unrelated missing variable does not break page requests", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    const response = await proxy(new NextRequest("https://ticketarena.example/"));

    expect(response.cookies.get(SESSION_COOKIE)?.value).toBeTruthy();
  });

  test("a missing SESSION_SECRET fails naming the field", async () => {
    vi.stubEnv("SESSION_SECRET", "");

    await expect(proxy(new NextRequest("https://ticketarena.example/"))).rejects.toThrow(
      /SESSION_SECRET/,
    );
  });
});
