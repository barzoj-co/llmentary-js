import { defineConfig } from "vitest/config";

/** Floored from Node 22 `test:coverage` after binary download/resolve tests (88.44 / 82.7 / 89.88). */
const MEASURED_FLOORS = {
  lines: 88,
  statements: 88,
  functions: 89,
  branches: 82,
} as const;

const RELEASE_FLOORS = {
  lines: 90,
  statements: 90,
  functions: 90,
  branches: 90,
} as const;

function coverageThresholds(): { lines: number; statements: number; functions: number; branches: number } {
  const head = process.env.GITHUB_HEAD_REF ?? "";
  const releasePlease = head.startsWith("release-please") || process.env.COVERAGE_RELEASE_PLEASE === "1";
  return releasePlease ? RELEASE_FLOORS : MEASURED_FLOORS;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // OpenAI e2e is opted in via `npm run test:e2e:openai` (vitest.e2e.config.ts).
    exclude: ["tests/jest/**", "tests/e2e/**", "tests/jest-concurrent-proxy.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      thresholds: coverageThresholds(),
    },
  },
});
