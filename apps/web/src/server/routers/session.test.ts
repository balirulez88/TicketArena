import { createPrismaClient } from "@ticketarena/db";
import { expect, test } from "vitest";
import { createCaller } from "./_app";

// Procedures under test never touch the database; the client connects lazily, so no server is needed.
const unusedDb = () =>
  createPrismaClient({ connectionString: "postgresql://unused@127.0.0.1:1/unused", driver: "pg" });

test("whoami returns the principal on the context", async () => {
  const principal = { kind: "guest", sessionId: "0123456789abcdef0123456789abcdef" } as const;
  const caller = createCaller({ now: () => new Date(), principal, db: unusedDb() });

  expect(await caller.session.whoami()).toEqual(principal);
});
