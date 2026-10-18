import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/jest-concurrent-proxy.test.ts"],
    testTimeout: 90_000,
  },
});
