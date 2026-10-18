import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pinPlatformPackage, pinRootPackage } from "./pack-platform-binaries.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("LLMTESTLAB_ROOT_VERSION keeps the root version and pins optionalDependencies to PROXY_VERSION", () => {
  const root = {
    version: "0.0.0",
    optionalDependencies: {
      "@llm-test-lab/linux-x64": "0.0.0",
      "@llm-test-lab/darwin-arm64": "0.0.0",
    },
  };
  const out = pinRootPackage(structuredClone(root), "1.2.3", "0.0.0");
  assert.equal(out.version, "0.0.0");
  assert.equal(out.optionalDependencies["@llm-test-lab/linux-x64"], "1.2.3");
  assert.equal(out.optionalDependencies["@llm-test-lab/darwin-arm64"], "1.2.3");

  const platform = pinPlatformPackage({ name: "@llm-test-lab/linux-x64", version: "0.0.0" }, "1.2.3");
  assert.equal(platform.version, "1.2.3");
});

test("unset LLMTESTLAB_ROOT_VERSION keeps lockstep root and platform versions", () => {
  const root = {
    version: "0.0.0",
    optionalDependencies: {
      "@llm-test-lab/linux-x64": "0.0.0",
    },
  };
  const out = pinRootPackage(structuredClone(root), "1.2.3", undefined);
  assert.equal(out.version, "1.2.3");
  assert.equal(out.optionalDependencies["@llm-test-lab/linux-x64"], "1.2.3");

  const emptyEnv = pinRootPackage(structuredClone(root), "9.9.9", "");
  assert.equal(emptyEnv.version, "9.9.9");
});

test("release.yml publish job is trusted-publishing-ready and gated", () => {
  const release = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const please = readFileSync(join(ROOT, ".github/workflows/release-please.yml"), "utf8");

  assert.match(release, /^on:\n(?:  .+\n)+/m);
  assert.match(release, /tags:\n\s+- ["']v\*["']/);
  assert.match(release, /workflow_dispatch:/);
  assert.doesNotMatch(release, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(release, /NPM_TOKEN/);
  assert.match(release, /environment:\s*npm/);
  assert.match(release, /id-token:\s*write/);
  assert.match(release, /vars\.NPM_PUBLISH_ENABLED == 'true'/);
  assert.match(release, /--provenance/);
  assert.match(release, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);

  assert.match(release, /^  build:\n/m);
  assert.match(release, /^  publish:\n/m);
  assert.match(release, /if: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.NPM_PUBLISH_ENABLED == 'true' \}\}/);

  assert.match(please, /steps\.release\.outputs\.release_created/);
  assert.match(please, /gh workflow run release\.yml --repo/);
});
