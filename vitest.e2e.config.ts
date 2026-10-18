import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxConcurrency: 1,
    passWithNoTests: false,
    reporters: ["verbose", "./tests/e2e/list-reporter.ts"],
  },
});
