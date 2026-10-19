import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyVersions,
  PACKAGES,
  assetPatterns,
  readProxyVersion,
  resolveTag,
  writePackageVersions,
} from "./pack-platform-binaries.mjs";

const sampleRoot = {
  name: "llmentary",
  version: "1.2.3",
  optionalDependencies: {
    "@llmentary/linux-x64": "0.0.0",
    "@llmentary/darwin-arm64": "0.0.0",
  },
};

test("assetPatterns accept goreleaser llmentary_<ver>_<os>_<arch> names and reject the old archives", () => {
  const linux = assetPatterns("linux", "x64");
  const darwin = assetPatterns("darwin", "arm64");
  const hyphenated = ["llm", "test", "lab"].join("-");
  const compact = ["llm", "testlab"].join("");
  assert.equal(linux.some((pattern) => pattern.test("llmentary_0.1.0_linux_amd64.tar.gz")), true);
  assert.equal(darwin.some((pattern) => pattern.test("llmentary_0.1.0_darwin_arm64.tar.gz")), true);
  assert.equal(linux.some((pattern) => pattern.test(`${hyphenated}_0.1.0_linux_amd64.tar.gz`)), false);
  assert.equal(linux.some((pattern) => pattern.test(`${compact}_Linux_x86_64.tar.gz`)), false);
});

test("Option B keeps the root version and pins optionalDependencies to PROXY_VERSION", () => {
  const { version, rootPkg } = applyVersions(sampleRoot, "v9.9.9", { keepRootVersion: true });
  assert.equal(version, "9.9.9");
  assert.equal(rootPkg.version, "1.2.3");
  assert.equal(rootPkg.optionalDependencies["@llmentary/linux-x64"], "9.9.9");
  assert.equal(rootPkg.optionalDependencies["@llmentary/darwin-arm64"], "9.9.9");
});

test("unset LLMENTARY_ROOT_VERSION keeps lockstep versions", () => {
  const { version, rootPkg } = applyVersions(sampleRoot, "v9.9.9", { keepRootVersion: false });
  assert.equal(version, "9.9.9");
  assert.equal(rootPkg.version, "9.9.9");
  assert.equal(rootPkg.optionalDependencies["@llmentary/linux-x64"], "9.9.9");
});

test("resolveTag prefers LLMENTARY_TAG, then GITHUB_REF_NAME, then PROXY_VERSION", () => {
  assert.equal(resolveTag({ env: { LLMENTARY_TAG: "v1.0.0", GITHUB_REF_NAME: "v9" }, proxyVersion: "v2" }), "v1.0.0");
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
          name: "llmentary",
          version: "0.4.0",
          optionalDependencies: Object.fromEntries(PACKAGES.map((spec) => [`@llmentary/${spec.dir}`, "0.0.0"])),
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
        JSON.stringify({ name: `@llmentary/${spec.dir}`, version: "0.0.0" }, null, 2) + "\n",
      );
    }

    assert.equal(await readProxyVersion(dir), "v8.1.0");

    await writePackageVersions(dir, "v8.1.0", { keepRootVersion: true });
    const optionB = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(optionB.version, "0.4.0");
    for (const spec of PACKAGES) {
      assert.equal(optionB.optionalDependencies[`@llmentary/${spec.dir}`], "8.1.0");
      const platform = JSON.parse(await readFile(join(dir, "packages", spec.dir, "package.json"), "utf8"));
      assert.equal(platform.version, "8.1.0");
    }

    await writePackageVersions(dir, "v7.0.0", { keepRootVersion: false });
    const lockstep = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(lockstep.version, "7.0.0");
    for (const spec of PACKAGES) {
      assert.equal(lockstep.optionalDependencies[`@llmentary/${spec.dir}`], "7.0.0");
      const platform = JSON.parse(await readFile(join(dir, "packages", spec.dir, "package.json"), "utf8"));
      assert.equal(platform.version, "7.0.0");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
