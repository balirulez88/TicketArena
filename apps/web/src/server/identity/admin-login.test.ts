import { randomUUID } from "node:crypto";
import { silentLogger } from "@ticketarena/contracts";
import { setupTestUpstash } from "@ticketarena/test-infra";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { proxy } from "@/proxy";
import { createAdminRateLimiter, type RateLimiter } from "../rate-limiter";
import { createUpstashMetricsClient } from "../upstash-metrics";
import { handleAdminLogin, handleAdminLogout } from "./admin-login";

const PASSWORD = "correct horse battery";
const SECRET = "s".repeat(32);
const NOW = new Date("2027-03-01T12:00:00.000Z");

const upstash = setupTestUpstash();
const upstashClient = createUpstashMetricsClient({ url: upstash.url, token: upstash.token });

// A fresh limiter namespace per test: each test starts with the login window open.
let limiterPrefix = "";
beforeEach(() => {
  limiterPrefix = `${upstash.prefix}${randomUUID()}:`;
});

const limiter = (): RateLimiter => createAdminRateLimiter(upstashClient, limiterPrefix);

function login(password?: string): Request {
  const body = new FormData();
  if (password !== undefined) {
    body.set("password", password);
  }
  return new Request("https://ticketarena.example/api/admin/login", { method: "POST", body });
}

function attempt(password: string | undefined, rateLimiter: () => RateLimiter = limiter) {
  return handleAdminLogin(login(password), {
    adminPassword: PASSWORD,
    sessionSecret: SECRET,
    now: NOW,
    rateLimiter,
    logger: silentLogger,
  });
}

describe("handleAdminLogin", () => {
  test("the admin password sets a signed, httpOnly, Secure, SameSite=Strict ta_admin cookie and redirects to /admin", async () => {
    const response = await attempt(PASSWORD);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://ticketarena.example/admin");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^ta_admin=\d+\.[0-9a-f]{64};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=strict/i);
    expect(setCookie).toMatch(/Max-Age=28800/);
  });

  test("the issued cookie opens /admin through the proxy", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const response = await attempt(PASSWORD);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const page = await proxy(
      new NextRequest("https://ticketarena.example/admin", { headers: { cookie } }),
    );

    expect(page.headers.get("location")).toBeNull();
  });

  test.each([
    ["a wrong password", "wrong password!"],
    ["no password", undefined],
  ])("%s sets no cookie and returns to the login page with an error", async (_case, password) => {
    const response = await attempt(password);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://ticketarena.example/admin/login?error=invalid",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("every attempt takes the admin limit for action login, so even the right password is refused within 10 s", async () => {
    await attempt("wrong password!");

    const refused = await attempt(PASSWORD);

    expect(refused.status).toBe(303);
    const location = new URL(refused.headers.get("location") ?? "");
    expect(location.pathname).toBe("/admin/login");
    expect(location.searchParams.get("error")).toBe("rate-limited");
    const retry = Number(location.searchParams.get("retry"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(10);
    expect(refused.headers.get("retry-after")).toBe(String(retry));
    expect(refused.headers.get("set-cookie")).toBeNull();
    const ttl = await upstash.command(["PTTL", `${limiterPrefix}admin:rate:login`]);
    expect(ttl).toBeGreaterThan(0);
  });

  test("an unreachable limiter refuses the login without setting a cookie", async () => {
    const unreachable = createUpstashMetricsClient({
      url: "http://localhost:1",
      token: "token",
      timeoutMs: 500,
    });

    const response = await attempt(PASSWORD, () => createAdminRateLimiter(unreachable));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://ticketarena.example/admin/login?error=unavailable",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a limiter that cannot be configured refuses the login without setting a cookie", async () => {
    const response = await attempt(PASSWORD, () => {
      throw new Error("Invalid metrics environment: UPSTASH_REDIS_REST_URL");
    });

    expect(response.headers.get("location")).toBe(
      "https://ticketarena.example/admin/login?error=unavailable",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("handleAdminLogout", () => {
  test("clears the ta_admin cookie and redirects with 303 to the login page", () => {
    const response = handleAdminLogout(
      new Request("https://ticketarena.example/api/admin/logout", { method: "POST" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://ticketarena.example/admin/login");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^ta_admin=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
    expect(setCookie).toMatch(/Path=\//);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
