import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { proxy } from "./proxy";
import { issueAdminCookieValue } from "./server/identity/admin-session";
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

    const { principal } = await createTRPCContext({
      req: downstreamRequest(original, response),
      resHeaders: new Headers(),
    });

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

    const { principal } = await createTRPCContext({
      req: downstreamRequest(original, response),
      resHeaders: new Headers(),
    });

    expect(issued).toBeTruthy();
    expect(principal.sessionId).toBe(issued?.split(".")[0]);
    expect(principal.sessionId).not.toBe(forged.split(".")[0]);
  });
});

describe("proxy guards /admin", () => {
  const adminRequest = (path: string, cookie?: string) =>
    new NextRequest(`https://ticketarena.example${path}`, {
      headers: cookie ? { cookie: `ta_admin=${cookie}` } : {},
    });
  const redirectTarget = (response: Response) => response.headers.get("location");

  test.each(["/admin", "/admin/anything"])(
    "%s without an admin cookie redirects to the login page",
    async (path) => {
      const response = await proxy(adminRequest(path));

      expect(response.status).toBe(307);
      expect(redirectTarget(response)).toBe("https://ticketarena.example/admin/login");
    },
  );

  test("an admin cookie signed with another secret redirects to the login page", async () => {
    const forged = await issueAdminCookieValue("x".repeat(32), new Date());

    const response = await proxy(adminRequest("/admin", forged));

    expect(redirectTarget(response)).toBe("https://ticketarena.example/admin/login");
  });

  test("an expired admin cookie redirects to the login page", async () => {
    const expired = await issueAdminCookieValue("s".repeat(32), new Date("2020-01-01T00:00:00Z"));

    const response = await proxy(adminRequest("/admin", expired));

    expect(redirectTarget(response)).toBe("https://ticketarena.example/admin/login");
  });

  test("a valid admin cookie reaches /admin", async () => {
    const valid = await issueAdminCookieValue("s".repeat(32), new Date());

    const response = await proxy(adminRequest("/admin", valid));

    expect(redirectTarget(response)).toBeNull();
  });

  test("the login page is reachable without an admin cookie", async () => {
    const response = await proxy(adminRequest("/admin/login"));

    expect(redirectTarget(response)).toBeNull();
  });

  test("a path that only starts with the letters admin is not guarded", async () => {
    const response = await proxy(adminRequest("/administrators"));

    expect(redirectTarget(response)).toBeNull();
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
