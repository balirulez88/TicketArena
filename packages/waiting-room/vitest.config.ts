import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: [require.resolve("@ticketarena/test-infra/global-setup")],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Own cache per package: Turbo runs packages in parallel, and a shared root cache is wiped by
    // each of them at once after a lockfile change (ENOTEMPTY on Windows; scripts/vitest-cache.test.mjs).
    fsModuleCachePath: "node_modules/.vitest-cache",
  },
});
