import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCaller } from "./routers/_app";
import { createTRPCContext } from "./trpc";

// Built by the real request boundary with DATABASE_URL absent (TD-003). Its own file: the database
// client is shared per process, so a client built by another test would hide a missing variable.
const contextWithoutDatabase = () =>
  createTRPCContext({
    req: new Request("https://ticketarena.example/api/trpc"),
    resHeaders: new Headers(),
  });

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  vi.stubEnv("DATABASE_URL", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DATABASE_URL is read only by procedures that use the database", () => {
  test("health.check and session.whoami succeed without it", async () => {
    const caller = createCaller(await contextWithoutDatabase());

    await expect(caller.health.check()).resolves.toMatchObject({ status: "ok" });
    await expect(caller.session.whoami()).resolves.toMatchObject({ kind: "guest" });
  });

  test("a procedure that needs the database fails fast naming DATABASE_URL", async () => {
    const caller = createCaller(await contextWithoutDatabase());

    await expect(caller.events.list()).rejects.toThrow(/DATABASE_URL/);
  });
});
