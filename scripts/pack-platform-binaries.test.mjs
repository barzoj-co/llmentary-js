import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyVersions,
  PACKAGES,
  readProxyVersion,
  resolveTag,
  writePackageVersions,
} from "./pack-platform-binaries.mjs";

const sampleRoot = {
  name: "llm-test-lab",
  version: "1.2.3",
  optionalDependencies: {
    "@llm-test-lab/linux-x64": "0.0.0",
    "@llm-test-lab/darwin-arm64": "0.0.0",
  },
};

test("Option B keeps the root version and pins optionalDependencies to PROXY_VERSION", () => {
  const { version, rootPkg } = applyVersions(sampleRoot, "v9.9.9", { keepRootVersion: true });
  assert.equal(version, "9.9.9");
  assert.equal(rootPkg.version, "1.2.3");
  assert.equal(rootPkg.optionalDependencies["@llm-test-lab/linux-x64"], "9.9.9");
  assert.equal(rootPkg.optionalDependencies["@llm-test-lab/darwin-arm64"], "9.9.9");
});

test("unset LLMTESTLAB_ROOT_VERSION keeps lockstep versions", () => {
  const { version, rootPkg } = applyVersions(sampleRoot, "v9.9.9", { keepRootVersion: false });
  assert.equal(version, "9.9.9");
  assert.equal(rootPkg.version, "9.9.9");
  assert.equal(rootPkg.optionalDependencies["@llm-test-lab/linux-x64"], "9.9.9");
});

test("resolveTag prefers LLMTESTLAB_TAG, then GITHUB_REF_NAME, then PROXY_VERSION", () => {
  assert.equal(resolveTag({ env: { LLMTESTLAB_TAG: "v1.0.0", GITHUB_REF_NAME: "v9" }, proxyVersion: "v2" }), "v1.0.0");
  assert.equal(resolveTag({ env: { GITHUB_REF_NAME: "v9.0.0" }, proxyVersion: "v2" }), "v9.0.0");
  assert.equal(resolveTag({ env: {}, proxyVersion: "v0.0.0" }), "v0.0.0");
});

test("writePackageVersions updates platform packages and honors keepRootVersion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ltl-pack-versions-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "llm-test-lab",
          version: "0.4.0",
          optionalDependencies: Object.fromEntries(PACKAGES.map((spec) => [`@llm-test-lab/${spec.dir}`, "0.0.0"])),
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(join(dir, "PROXY_VERSION"), "v8.1.0\n");
    for (const spec of PACKAGES) {
      const pkgDir = join(dir, "packages", spec.dir);
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: `@llm-test-lab/${spec.dir}`, version: "0.0.0" }, null, 2) + "\n",
      );
    }

    assert.equal(await readProxyVersion(dir), "v8.1.0");

    await writePackageVersions(dir, "v8.1.0", { keepRootVersion: true });
    const optionB = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(optionB.version, "0.4.0");
    for (const spec of PACKAGES) {
      assert.equal(optionB.optionalDependencies[`@llm-test-lab/${spec.dir}`], "8.1.0");
      const platform = JSON.parse(await readFile(join(dir, "packages", spec.dir, "package.json"), "utf8"));
      assert.equal(platform.version, "8.1.0");
    }

    await writePackageVersions(dir, "v7.0.0", { keepRootVersion: false });
    const lockstep = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(lockstep.version, "7.0.0");
    for (const spec of PACKAGES) {
      assert.equal(lockstep.optionalDependencies[`@llm-test-lab/${spec.dir}`], "7.0.0");
      const platform = JSON.parse(await readFile(join(dir, "packages", spec.dir, "package.json"), "utf8"));
      assert.equal(platform.version, "7.0.0");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
