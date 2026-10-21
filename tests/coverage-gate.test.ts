import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { coverageThresholds, MEASURED_FLOORS, RELEASE_FLOORS } from "../vitest.config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const envKeys = ["GITHUB_HEAD_REF", "COVERAGE_RELEASE_PLEASE"] as const;
const previous: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of envKeys) {
    if (!(key in previous)) continue;
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
    delete previous[key];
  }
});

function stash(key: (typeof envKeys)[number], value: string | undefined): void {
  if (!(key in previous)) previous[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("coverage gate wiring", () => {
  it("documents test:unit:coverage so --coverage reaches Vitest, not the isolation script", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const contributing = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
    expect(pkg.scripts["test:unit"]).toBe(
      "npm run test:vitest:unit && node scripts/check-isolation-vectors.mjs",
    );
    expect(pkg.scripts["test:unit:coverage"]).toMatch(/test:vitest:unit -- --coverage/);
    expect(pkg.scripts["test:unit:coverage"]).toMatch(/check-isolation-vectors/);
    expect(contributing).toMatch(/test:unit:coverage/);
    expect(contributing).not.toMatch(/test:unit -- --coverage/);
  });

  it("selects release floors for release-please heads and measured floors otherwise", () => {
    stash("COVERAGE_RELEASE_PLEASE", undefined);
    stash("GITHUB_HEAD_REF", "release-please--branches--main--components--llmentary");
    expect(coverageThresholds()).toEqual(RELEASE_FLOORS);

    stash("GITHUB_HEAD_REF", "cursor/coverage-measure-a722");
    expect(coverageThresholds()).toEqual(MEASURED_FLOORS);

    stash("COVERAGE_RELEASE_PLEASE", "1");
    expect(coverageThresholds()).toEqual(RELEASE_FLOORS);
  });
});
