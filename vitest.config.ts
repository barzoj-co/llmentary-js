import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/jest/**", "tests/e2e/openai.test.ts"],
    testTimeout: 30_000,
  },
});
