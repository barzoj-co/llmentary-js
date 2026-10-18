import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // OpenAI e2e is opted in via `npm run test:e2e:openai` (vitest.e2e.config.ts).
    exclude: ["tests/jest/**", "tests/e2e/**", "tests/jest-concurrent-proxy.test.ts"],
    testTimeout: 30_000,
  },
});
