import { expect, test, vi } from "vitest";
import { createTRPCContext } from "../trpc";
import { createCaller } from "./_app";

// The context is built by the real boundary with the Upstash variables absent: a missing metrics
// configuration must never break a procedure that does not use metrics.
test("health check reports ok with the time it was checked, without Upstash configuration", async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  vi.stubEnv("DATABASE_URL", "postgresql://unused@127.0.0.1:1/unused");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  const fixedNow = new Date("2026-01-01T12:00:00.000Z");
  const ctx = await createTRPCContext({ req: new Request("https://ticketarena.example/") });
  const caller = createCaller({ ...ctx, now: () => fixedNow });

  const result = await caller.health.check();

  expect(result).toEqual({ status: "ok", checkedAt: new Date("2026-01-01T12:00:00.000Z") });
  vi.unstubAllEnvs();
});
