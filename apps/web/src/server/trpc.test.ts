import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { issueSessionCookieValue } from "./identity/identity";
import { createTRPCContext } from "./trpc";

const secret = "s".repeat(32);
const requestWith = (cookie?: string) =>
  new Request("https://ticketarena.example/api/trpc", { headers: cookie ? { cookie } : {} });

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", secret);
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example.com/ticketarena?sslmode=require");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createTRPCContext", () => {
  test("a valid signed cookie yields that session", async () => {
    const value = await issueSessionCookieValue(secret);

    const { principal } = await createTRPCContext({ req: requestWith(`ta_session=${value}`) });

    expect(principal).toEqual({ kind: "guest", sessionId: value.split(".")[0] });
  });

  test("a missing cookie yields a valid guest", async () => {
    const { principal } = await createTRPCContext({ req: requestWith() });

    expect(principal.kind).toBe("guest");
    expect(principal.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an invalid signature yields a valid guest and its id is never used", async () => {
    const forged = await issueSessionCookieValue("x".repeat(32));

    const { principal } = await createTRPCContext({ req: requestWith(`ta_session=${forged}`) });

    expect(principal.kind).toBe("guest");
    expect(principal.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(principal.sessionId).not.toBe(forged.split(".")[0]);
  });

  test("does not read the Upstash variables while building the context", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    await expect(createTRPCContext({ req: requestWith() })).resolves.toBeDefined();
  });

  test("resolving metrics without the Upstash variables fails naming the variable", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    const ctx = await createTRPCContext({ req: requestWith() });

    expect(() => ctx.metrics()).toThrow(/UPSTASH_REDIS_REST_URL/);
  });
});
