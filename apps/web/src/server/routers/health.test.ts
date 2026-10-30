import { createPrismaClient } from "@ticketarena/db";
import { expect, test } from "vitest";
import { createCaller } from "./_app";

// Procedures under test never touch the database; the client connects lazily, so no server is needed.
const unusedDb = () =>
  createPrismaClient({ connectionString: "postgresql://unused@127.0.0.1:1/unused", driver: "pg" });

test("health check reports ok with the time it was checked", async () => {
  const fixedNow = new Date("2026-01-01T12:00:00.000Z");
  const caller = createCaller({
    now: () => fixedNow,
    principal: { kind: "guest", sessionId: "0123456789abcdef0123456789abcdef" },
    db: unusedDb(),
  });

  const result = await caller.health.check();

  expect(result).toEqual({ status: "ok", checkedAt: new Date("2026-01-01T12:00:00.000Z") });
});
