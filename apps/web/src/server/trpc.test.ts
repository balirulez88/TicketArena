import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { issueSessionCookieValue } from "./identity/identity";
import { createTRPCContext } from "./trpc";

const secret = "s".repeat(32);
const requestWith = (cookie?: string) =>
  new Request("https://ticketarena.example/api/trpc", { headers: cookie ? { cookie } : {} });
const contextFor = (req: Request, resHeaders = new Headers()) =>
  createTRPCContext({ req, resHeaders });

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

    const { principal } = await contextFor(requestWith(`ta_session=${value}`));

    expect(principal).toEqual({ kind: "guest", sessionId: value.split(".")[0] });
  });

  test("a missing cookie yields a valid guest", async () => {
    const { principal } = await contextFor(requestWith());

    expect(principal.kind).toBe("guest");
    expect(principal.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an invalid signature yields a valid guest and its id is never used", async () => {
    const forged = await issueSessionCookieValue("x".repeat(32));

    const { principal } = await contextFor(requestWith(`ta_session=${forged}`));

    expect(principal.kind).toBe("guest");
    expect(principal.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(principal.sessionId).not.toBe(forged.split(".")[0]);
  });

  test("does not read the Upstash variables while building the context", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    await expect(contextFor(requestWith())).resolves.toBeDefined();
  });

  test("resolving metrics without the Upstash variables fails naming the variable", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    const ctx = await contextFor(requestWith());

    expect(() => ctx.metrics()).toThrow(/UPSTASH_REDIS_REST_URL/);
  });

  test("does not read REDIS_URL while building the context", async () => {
    vi.stubEnv("REDIS_URL", "");

    await expect(contextFor(requestWith())).resolves.toBeDefined();
  });

  test("resolving the queue store without REDIS_URL fails naming the variable", async () => {
    vi.stubEnv("REDIS_URL", "");

    const ctx = await contextFor(requestWith());

    await expect(ctx.queueStore()).rejects.toThrow(/REDIS_URL/);
  });
});

describe("createTRPCContext admission tokens", () => {
  const eventId = randomUUID();
  const admission = {
    sessionId: "a".repeat(32),
    eventId,
    jti: randomUUID(),
    expiresAt: new Date(Date.now() + 30 * 60_000),
  };

  test("an issued admission is an httpOnly, Secure, SameSite=Lax cookie ta_adm_<eventId>", async () => {
    vi.stubEnv("ADMISSION_SECRET", "t".repeat(32));
    const resHeaders = new Headers();
    const ctx = await contextFor(requestWith(), resHeaders);

    await ctx.admissionTokens.issue(admission);

    const cookie = resHeaders.get("set-cookie") ?? "";
    expect(cookie.startsWith(`ta_adm_${eventId}=`)).toBe(true);
    expect(cookie.split(";")[0]?.split("=")[1]).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Expires=${admission.expiresAt.toUTCString()}`);
  });

  test("the cookie sent back on a request reads back as the admission", async () => {
    vi.stubEnv("ADMISSION_SECRET", "t".repeat(32));
    const resHeaders = new Headers();
    await (await contextFor(requestWith(), resHeaders)).admissionTokens.issue(admission);
    const [pair] = (resHeaders.get("set-cookie") ?? "").split(";");

    const ctx = await contextFor(requestWith(pair));

    expect(await ctx.admissionTokens.read(eventId)).toEqual({
      ...admission,
      expiresAt: new Date(Math.floor(admission.expiresAt.getTime() / 1000) * 1000),
    });
  });

  test("does not read ADMISSION_SECRET while building the context; using it names the variable", async () => {
    vi.stubEnv("ADMISSION_SECRET", "");

    const ctx = await contextFor(requestWith());

    await expect(ctx.admissionTokens.issue(admission)).rejects.toThrow(/ADMISSION_SECRET/);
  });
});
