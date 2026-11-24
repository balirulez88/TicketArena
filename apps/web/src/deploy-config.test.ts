import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vercel.json is read only by Vercel, so this pins what the deployment relies on (ADR 0013).
const vercel: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "../vercel.json"), "utf8"),
);

describe("vercel.json", () => {
  it("turns off Vercel's git deployments, so only the deploy workflow deploys, after the migrations", () => {
    expect(vercel).toMatchObject({ git: { deploymentEnabled: false } });
  });

  it("generates the Prisma client before building the app", () => {
    expect(vercel).toMatchObject({
      buildCommand: expect.stringMatching(/db:generate[\s\S]*&&[\s\S]*build/),
    });
  });
});
