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
  },
});
