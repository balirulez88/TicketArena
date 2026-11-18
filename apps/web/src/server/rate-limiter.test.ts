import { randomUUID } from "node:crypto";
import { setupTestUpstash } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import {
  ADMIN_ACTION_WINDOW_MS,
  createAdminRateLimiter,
  createRedisRateLimiter,
} from "./rate-limiter";
import { createUpstashMetricsClient } from "./upstash-metrics";

const upstash = setupTestUpstash();
const client = () => createUpstashMetricsClient({ url: upstash.url, token: upstash.token });
const prefix = () => `${upstash.prefix}${randomUUID()}:`;

describe("createRedisRateLimiter", () => {
  test("allows one call per action per window and tells the caller how long to wait", async () => {
    const limiter = createRedisRateLimiter(client(), { prefix: prefix(), windowMs: 5_000 });

    expect(await limiter.acquire("runRace")).toEqual({ allowed: true });
    const refused = await limiter.acquire("runRace");

    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false && refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.allowed === false && refused.retryAfterMs).toBeLessThanOrEqual(5_000);
    expect(await limiter.acquire("resetDemo")).toEqual({ allowed: true });
  });

  test("allows the action again once its window has passed", async () => {
    const limiter = createRedisRateLimiter(client(), { prefix: prefix(), windowMs: 200 });
    await limiter.acquire("runRace");

    await expect
      .poll(() => limiter.acquire("runRace"), { timeout: 5_000, interval: 100 })
      .toEqual({ allowed: true });
  });

  test("the admin limiter is global per action with a 10 s window", async () => {
    const namespace = prefix();
    const limiter = createAdminRateLimiter(client(), namespace);
    const other = createAdminRateLimiter(client(), namespace);

    await limiter.acquire("runRace");

    expect(ADMIN_ACTION_WINDOW_MS).toBe(10_000);
    expect((await other.acquire("runRace")).allowed).toBe(false);
    const ttl = await upstash.command(["PTTL", `${namespace}admin:rate:runRace`]);
    expect(ttl).toBeGreaterThan(9_000);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });
});
