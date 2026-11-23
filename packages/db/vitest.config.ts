import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

// TD-006: these files must pass in any order, so they run once more with their tests shuffled.
// The seed is fixed so a failure reproduces; Vitest reads it from the root config only (a project's
// own seed is ignored). With this seed the test that marks a seat SOLD runs before the one that
// asserts every seat AVAILABLE (checked with --reporter=verbose).
const ORDER_INDEPENDENT = ["src/seed.test.ts"];
const SHUFFLE_SEED = 3;

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: [require.resolve("@ticketarena/test-infra/global-setup")],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Own cache per package: Turbo runs packages in parallel, and a shared root cache is wiped by
    // each of them at once after a lockfile change (ENOTEMPTY on Windows; scripts/vitest-cache.test.mjs).
    fsModuleCachePath: "node_modules/.vitest-cache",
    sequence: { seed: SHUFFLE_SEED },
    projects: [
      // Each project names its own files: an extended project's include is merged with the root's,
      // so a root include would put every file in the shuffled project too.
      { extends: true, test: { name: "db", include: ["src/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "db-shuffled",
          include: ORDER_INDEPENDENT,
          sequence: { shuffle: { tests: true } },
        },
      },
    ],
  },
});
