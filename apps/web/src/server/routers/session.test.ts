import { expect, test } from "vitest";
import { createCaller } from "./_app";

test("whoami returns the principal on the context", async () => {
  const principal = { kind: "guest", sessionId: "0123456789abcdef0123456789abcdef" } as const;
  const caller = createCaller({ now: () => new Date(), principal });

  expect(await caller.session.whoami()).toEqual(principal);
});
