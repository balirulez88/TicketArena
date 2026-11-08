import { expect, test, vi } from "vitest";
import { createTRPCContext } from "../trpc";
import { createCaller } from "./_app";

// The context is built by the real boundary with the Upstash variables absent: a missing metrics
// configuration must never break a procedure that does not use metrics.
test("whoami returns the principal on the context, without Upstash configuration", async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  vi.stubEnv("DATABASE_URL", "postgresql://unused@127.0.0.1:1/unused");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  const ctx = await createTRPCContext({ req: new Request("https://ticketarena.example/") });

  expect(await createCaller(ctx).session.whoami()).toEqual(ctx.principal);
  vi.unstubAllEnvs();
});
