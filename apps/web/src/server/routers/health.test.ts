import { expect, test } from "vitest";
import { createCaller } from "./_app";

test("health check reports ok with the time it was checked", async () => {
  const fixedNow = new Date("2026-01-01T12:00:00.000Z");
  const caller = createCaller({ now: () => fixedNow });

  const result = await caller.health.check();

  expect(result).toEqual({ status: "ok", checkedAt: new Date("2026-01-01T12:00:00.000Z") });
});
