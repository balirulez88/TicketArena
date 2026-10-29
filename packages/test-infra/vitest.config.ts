import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/global-setup.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
