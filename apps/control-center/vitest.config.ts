import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Own cache per package: Turbo runs packages in parallel, and a shared root cache is wiped by
    // each of them at once after a lockfile change (ENOTEMPTY on Windows; scripts/vitest-cache.test.mjs).
    fsModuleCachePath: "node_modules/.vitest-cache",
  },
});
