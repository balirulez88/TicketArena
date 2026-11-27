import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved through the package's own `exports` map, so the test sees exactly what an importer of
// `@ticketarena/db` and `@ticketarena/db/seed` gets.
const manifest: { exports: Record<string, string> } = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8"),
);

async function exportNamesOf(subpath: string): Promise<string[]> {
  const target = manifest.exports[subpath];
  if (target === undefined) {
    throw new Error(`@ticketarena/db has no "${subpath}" export`);
  }
  const module: Record<string, unknown> = await import(resolve(__dirname, "..", target));
  return Object.keys(module);
}

describe("@ticketarena/db entry points", () => {
  it("the runtime entry point does not export the seeder", async () => {
    const names = await exportNamesOf(".");

    expect(names).toContain("createPrismaClient");
    expect(names).not.toContain("seedCatalog");
  });

  it("the seed entry point exports the seeder", async () => {
    expect(await exportNamesOf("./seed")).toContain("seedCatalog");
  });
});
