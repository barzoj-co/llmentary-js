import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyVersions,
  BUNDLED_PROXY_TAG,
  GITHUB_API_ORIGIN,
  GITHUB_DOWNLOAD_ORIGIN,
  MAX_RELEASE_ASSET_BYTES,
  PACKAGES,
  PUBLIC_RELEASE_REPO,
  assetPatterns,
  assertPublicReleaseRef,
  assertVerifiedAsset,
  destFile,
  downloadPublicRelease,
  githubHeaders,
  githubToken,
  parseChecksumManifest,
  publicReleaseApiUrl,
  publicReleaseAssetUrl,
  readProxyVersion,
  releaseAssetName,
  resolveDownloadTag,
  resolveTag,
  trustedManifest,
  writePackageVersions,
  writeReleaseAsset,
} from "./pack-platform-binaries.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pinnedAsset(name, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    name,
    size: buf.byteLength,
    digest: `sha256:${sha256(buf)}`,
    body: buf,
    ...extra,
  };
}

function releaseFetch(assets, { mutate } = {}) {
  const byUrlName = new Map(assets.map((asset) => [asset.name, asset]));
  return async (url, init = {}) => {
    if (String(url).includes("/releases/tags/")) {
      return new Response(
        JSON.stringify({
          assets: assets.map(({ name, size, digest }) => ({ name, size, digest })),
        }),
        { status: 200 },
      );
    }
    const name = decodeURIComponent(String(url).split("/").pop() ?? "");
    const asset = byUrlName.get(name);
    if (!asset) return new Response("gone", { status: 404 });
    const body = mutate ? mutate(asset) : asset.body;
    return new Response(body, { status: 200, headers: { authorization: init.headers?.authorization ?? "" } });
  };
}

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
  const old = ["l", "ab"].join("");
  const hyphenated = ["llm", "test", old].join("-");
  const compact = ["llm", "test"].join("") + old;
  assert.equal(linux.some((pattern) => pattern.test("llmentary_0.2.0_linux_amd64.tar.gz")), true);
  assert.equal(darwin.some((pattern) => pattern.test("llmentary_0.2.0_darwin_arm64.tar.gz")), true);
  assert.equal(linux.some((pattern) => pattern.test(`${hyphenated}_0.2.0_linux_amd64.tar.gz`)), false);
  assert.equal(linux.some((pattern) => pattern.test(`${compact}_Linux_x86_64.tar.gz`)), false);
});

test("assetPatterns accept every PROXY_VERSION platform archive and reject suffix swaps", async () => {
  const pin = await readProxyVersion();
  const version = pin.replace(/^v/, "");
  assert.equal(pin, "v0.5.1");
  const cases = [
    ["linux", "x64", `llmentary_${version}_linux_amd64.tar.gz`, `llmentary_${version}_linux_amd64.zip`],
    ["linux", "arm64", `llmentary_${version}_linux_arm64.tar.gz`, `llmentary_${version}_linux_arm64.zip`],
    ["darwin", "x64", `llmentary_${version}_darwin_amd64.tar.gz`, `llmentary_${version}_darwin_amd64.zip`],
    ["darwin", "arm64", `llmentary_${version}_darwin_arm64.tar.gz`, `llmentary_${version}_darwin_arm64.zip`],
    ["win32", "x64", `llmentary_${version}_windows_amd64.zip`, `llmentary_${version}_windows_amd64.tar.gz`],
  ];
  for (const [os, cpu, ok, bad] of cases) {
    const patterns = assetPatterns(os, cpu);
    assert.equal(patterns.some((pattern) => pattern.test(ok)), true, `${os}/${cpu} should match ${ok}`);
    assert.equal(patterns.some((pattern) => pattern.test(bad)), false, `${os}/${cpu} should reject ${bad}`);
  }
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

test("githubToken and githubHeaders treat a PAT as optional rate-limit auth", () => {
  assert.equal(githubToken({}), "");
  assert.equal(githubToken({ GH_TOKEN: "abc", GITHUB_TOKEN: "def" }), "abc");
  assert.equal(githubToken({ GITHUB_TOKEN: "def" }), "def");
  assert.equal(githubHeaders("").authorization, undefined);
  assert.equal(githubHeaders("abc").authorization, "Bearer abc");
  assert.equal(githubHeaders("abc").accept, "application/vnd.github+json");
});

test("release asset names and URLs reject path traversal", async () => {
  assert.deepEqual(assertPublicReleaseRef("barzoj-co/llmentary", "v0.4.1"), {
    repo: "barzoj-co/llmentary",
    tag: "v0.4.1",
  });
  assert.equal(releaseAssetName("checksums.txt"), "checksums.txt");
  assert.equal(releaseAssetName("llmentary_0.4.1_linux_amd64.tar.gz"), "llmentary_0.4.1_linux_amd64.tar.gz");
  assert.equal(
    publicReleaseAssetUrl("barzoj-co/llmentary", "v0.4.1", "checksums.txt"),
    "https://github.com/barzoj-co/llmentary/releases/download/v0.4.1/checksums.txt",
  );
  assert.equal(
    publicReleaseApiUrl("barzoj-co/llmentary", "v0.4.1"),
    "https://api.github.com/repos/barzoj-co/llmentary/releases/tags/v0.4.1",
  );
  assert.ok(publicReleaseApiUrl("barzoj-co/llmentary", "v0.4.1").startsWith(`${GITHUB_API_ORIGIN}/`));
  assert.ok(publicReleaseAssetUrl("barzoj-co/llmentary", "v0.4.1", "checksums.txt").startsWith(`${GITHUB_DOWNLOAD_ORIGIN}/`));
  const dest = await mkdtemp(join(tmpdir(), "ltl-dest-"));
  try {
    assert.equal(destFile(dest, "checksums.txt"), join(dest, "checksums.txt"));
    assert.throws(() => destFile(dest, "../passwd"), /invalid release asset name/);
    assert.throws(() => destFile(dest, "/etc/passwd"), /invalid release asset name/);
    assert.throws(() => destFile(dest, ".."), /refusing to write outside dest/);
    assert.throws(() => destFile(dest, "."), /refusing to write outside dest/);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
  assert.throws(() => releaseAssetName("../etc/passwd"), /invalid release asset name/);
  assert.throws(() => releaseAssetName("/etc/passwd"), /invalid release asset name/);
  assert.throws(() => releaseAssetName("dir/checksums.txt"), /invalid release asset name/);
  assert.throws(() => releaseAssetName(""), /invalid release asset name/);
  assert.throws(() => releaseAssetName("checksums.txt;curl"), /invalid release asset name/);
  assert.throws(() => releaseAssetName("checksums.txt\n"), /invalid release asset name/);
  assert.throws(() => releaseAssetName("checksums.txt "), /invalid release asset name/);
  assert.throws(() => releaseAssetName("..\\passwd"), /invalid release asset name/);
  assert.throws(() => releaseAssetName(null), /invalid release asset name/);
  assert.throws(() => publicReleaseAssetUrl("https://evil.test/x", "v0.4.1", "checksums.txt"), /invalid repo/);
  assert.throws(() => publicReleaseAssetUrl("barzoj-co/llmentary/extra", "v0.4.1", "checksums.txt"), /invalid repo/);
  assert.throws(() => publicReleaseAssetUrl("barzoj-co/llmentary", "v0.4.1/../../../x", "checksums.txt"), /invalid tag/);
  assert.throws(() => publicReleaseApiUrl("barzoj-co/llmentary", "v0.4.1\n"), /invalid tag/);
  assert.throws(() => publicReleaseApiUrl("barzoj-co/llmentary", "v0.4.1@evil"), /invalid tag/);
  assert.throws(() => publicReleaseApiUrl("barzoj-co/llmentary", "v0.4.1+build"), /invalid tag/);
  assert.throws(() => assertPublicReleaseRef("", "v0.4.1"), /invalid repo/);
  assert.throws(() => assertPublicReleaseRef("barzoj-co/llmentary", ""), /tag is required/);
  assert.throws(() => assertPublicReleaseRef(undefined, "v0.4.1"), /invalid repo/);
});

test("downloadPublicRelease fetches anonymously and writes assets", async () => {
  const dest = await mkdtemp(join(tmpdir(), "ltl-public-rel-"));
  const calls = [];
  const checksums = pinnedAsset("checksums.txt", "abc  checksums.txt\n");
  try {
    await downloadPublicRelease({
      repo: "barzoj-co/llmentary",
      tag: "v0.4.1",
      dest,
      env: {},
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), auth: init.headers?.authorization });
        return releaseFetch([checksums, { name: "../etc/passwd", size: 3, digest: "sha256:" + "ab".repeat(32) }])(url, init);
      },
    });
    assert.equal(await readFile(join(dest, "checksums.txt"), "utf8"), "abc  checksums.txt\n");
    assert.equal(calls[0].auth, undefined);
    assert.equal(
      calls.some((call) => call.url === "https://github.com/barzoj-co/llmentary/releases/download/v0.4.1/checksums.txt"),
      true,
    );
    assert.equal(calls.some((call) => String(call.url).includes("etc/passwd")), false);
    assert.equal((await readdir(dest)).includes("passwd"), false);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("downloadPublicRelease sends a rate-limit token and fails on empty/HTTP errors", async () => {
  const dest = await mkdtemp(join(tmpdir(), "ltl-public-rel-err-"));
  try {
    const checksums = pinnedAsset("checksums.txt", "ok\n");
    const calls = [];
    await downloadPublicRelease({
      repo: "barzoj-co/llmentary",
      tag: "v0.4.1",
      dest,
      env: { GH_TOKEN: "rate-limit-only" },
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), auth: init.headers?.authorization });
        return releaseFetch([checksums])(url, init);
      },
    });
    assert.equal(
      calls.find((call) => call.url.includes("/releases/tags/"))?.auth,
      "Bearer rate-limit-only",
    );
    assert.equal(
      calls.some((call) => call.url.includes("/releases/download/") && call.auth),
      false,
    );
    await assert.rejects(
      () =>
        downloadPublicRelease({
          repo: "barzoj-co/llmentary",
          tag: "v0.4.1",
          dest,
          env: { GH_TOKEN: "rate-limit-only" },
          fetchImpl: async (url, init = {}) => {
            assert.equal(String(url).includes("/releases/tags/"), true);
            assert.equal(init.headers?.authorization, "Bearer rate-limit-only");
            return new Response("nope", { status: 403 });
          },
        }),
      /Could not read public release/,
    );
    await assert.rejects(
      () =>
        downloadPublicRelease({
          repo: "barzoj-co/llmentary",
          tag: "v0.4.1",
          dest,
          env: {},
          fetchImpl: async () => new Response(JSON.stringify({ assets: [] }), { status: 200 }),
        }),
      /listed no assets/,
    );
    await assert.rejects(() => downloadPublicRelease({ dest, env: {} }), /tag is required/);
    await assert.rejects(
      () =>
        downloadPublicRelease({
          repo: "barzoj-co/llmentary",
          tag: "v0.4.1",
          dest,
          env: {},
          fetchImpl: async () => new Response("gone", { status: 404 }),
        }),
      /Could not read public release/,
    );
    await assert.rejects(
      () =>
        downloadPublicRelease({
          repo: "barzoj-co/llmentary",
          tag: "v0.4.1",
          dest,
          env: {},
          fetchImpl: async (url) => {
            if (String(url).includes("/releases/tags/")) {
              return new Response(
                JSON.stringify({
                  assets: [{ name: "checksums.txt", size: 4, digest: `sha256:${"ab".repeat(32)}` }],
                }),
                { status: 200 },
              );
            }
            return new Response("gone", { status: 404 });
          },
        }),
      /Could not download checksums.txt: 404/,
    );
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("downloadPublicRelease skips junk names, ignores browser_download_url, and rejects oversized bytes", async () => {
  const dest = await mkdtemp(join(tmpdir(), "ltl-public-rel-corners-"));
  const calls = [];
  const notes = pinnedAsset("ok+notes.txt", "ok\n");
  const checksums = pinnedAsset("checksums.txt", `${notes.digest.slice("sha256:".length)}  ok+notes.txt\n`);
  try {
    await downloadPublicRelease({
      repo: "barzoj-co/llmentary",
      tag: "v0.4.1",
      dest,
      env: {},
      fetchImpl: async (url) => {
        calls.push(String(url));
        return releaseFetch([
          { name: "", size: 1, digest: `sha256:${"ab".repeat(32)}` },
          { name: null, size: 1, digest: `sha256:${"ab".repeat(32)}` },
          {},
          { name: "../etc/passwd", size: 3, digest: `sha256:${"cd".repeat(32)}`, browser_download_url: "https://evil.test/passwd" },
          { ...checksums, browser_download_url: "https://evil.test/checksums.txt" },
          { ...notes, browser_download_url: "https://evil.test/ok+notes.txt" },
        ])(url);
      },
    });
    assert.equal(await readFile(join(dest, "checksums.txt"), "utf8"), checksums.body.toString("utf8"));
    assert.equal(await readFile(join(dest, "ok+notes.txt"), "utf8"), "ok\n");
    assert.equal(calls.includes("https://api.github.com/repos/barzoj-co/llmentary/releases/tags/v0.4.1"), true);
    assert.equal(
      calls.includes("https://github.com/barzoj-co/llmentary/releases/download/v0.4.1/checksums.txt"),
      true,
    );
    assert.equal(calls.some((url) => url.includes("evil.test")), false);
    assert.equal(calls.some((url) => url.includes("passwd")), false);
    const written = await readdir(dest);
    assert.equal(written.includes("passwd"), false);

    await assert.rejects(
      () =>
        downloadPublicRelease({
          repo: "barzoj-co/llmentary",
          tag: "v0.4.1",
          dest,
          env: {},
          fetchImpl: async (url) => {
            if (String(url).includes("/releases/tags/")) {
              return new Response(
                JSON.stringify({
                  assets: [{ name: "huge.bin", size: MAX_RELEASE_ASSET_BYTES + 1, digest: `sha256:${"ab".repeat(32)}` }],
                }),
                { status: 200 },
              );
            }
            return new Response(Buffer.alloc(MAX_RELEASE_ASSET_BYTES + 1), { status: 200 });
          },
        }),
      /checksums\.txt was not in the release assets|exceeds/,
    );
    await assert.rejects(
      () =>
        writeReleaseAsset(dest, "huge.bin", Buffer.alloc(MAX_RELEASE_ASSET_BYTES + 1), {
          sha256: "ab".repeat(32),
          size: MAX_RELEASE_ASSET_BYTES + 1,
        }),
      /exceeds/,
    );
    const empty = Buffer.alloc(0);
    await writeReleaseAsset(dest, "empty.txt", empty, { sha256: sha256(empty), size: 0 });
    assert.equal((await readFile(join(dest, "empty.txt"))).byteLength, 0);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("writeReleaseAsset verifies sha256 and size before persist and rejects corners", async () => {
  const dest = await mkdtemp(join(tmpdir(), "ltl-verified-write-"));
  const body = Buffer.from("payload\n");
  const expected = { sha256: sha256(body), size: body.byteLength };
  try {
    assert.equal(await writeReleaseAsset(dest, "ok.bin", body, expected), join(dest, "ok.bin"));
    assert.equal(await readFile(join(dest, "ok.bin"), "utf8"), "payload\n");
    assert.equal((await readdir(dest)).some((name) => name.endsWith(".part")), false);

    await assert.rejects(
      () => writeReleaseAsset(dest, "bad.bin", Buffer.from("PAYLOAD\n"), expected),
      /sha256 mismatch/,
    );
    assert.equal((await readdir(dest)).includes("bad.bin"), false);
    assert.equal((await readdir(dest)).some((name) => name.includes("bad.bin")), false);

    await assert.rejects(
      () => writeReleaseAsset(dest, "trunc.bin", body.subarray(0, 3), { sha256: expected.sha256, size: body.byteLength }),
      /truncated download/,
    );
    assert.equal((await readdir(dest)).includes("trunc.bin"), false);

    await assert.rejects(
      () => writeReleaseAsset(dest, "big.bin", Buffer.concat([body, Buffer.from("x")]), expected),
      /size mismatch/,
    );
    assert.equal((await readdir(dest)).includes("big.bin"), false);

    await assert.rejects(() => writeReleaseAsset(dest, "../passwd", body, expected), /invalid release asset name/);
    await assert.rejects(() => writeReleaseAsset(dest, "/tmp/passwd", body, expected), /invalid release asset name/);
    await assert.rejects(() => writeReleaseAsset(dest, "..", body, expected), /refusing to write outside dest|invalid/);
    await assert.rejects(() => writeReleaseAsset(dest, "ok.bin", body), /trusted sha256 required/);

    const manifest = parseChecksumManifest(`${expected.sha256}  ok.bin\n../etc/passwd  nope\n`);
    assert.equal(manifest.get("ok.bin"), expected.sha256);
    assert.equal(manifest.has("passwd"), false);
    assert.deepEqual(trustedManifest("ok.bin", { size: expected.size, digest: `sha256:${expected.sha256}` }), expected);
    assert.throws(() => assertVerifiedAsset("ok.bin", Buffer.from("PAYLOAD\n"), expected), /sha256 mismatch/);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("downloadPublicRelease rejects bad checksum, truncated body, size mismatch, and traversal names", async () => {
  const dest = await mkdtemp(join(tmpdir(), "ltl-download-verify-"));
  const archive = pinnedAsset("llmentary_0.4.1_linux_amd64.tar.gz", "archive-bytes");
  const checksums = pinnedAsset(
    "checksums.txt",
    `${archive.digest.slice("sha256:".length)}  llmentary_0.4.1_linux_amd64.tar.gz\n`,
  );
  try {
    await downloadPublicRelease({
      repo: "barzoj-co/llmentary",
      tag: "v0.4.1",
      dest,
      env: {},
      fetchImpl: releaseFetch([checksums, archive]),
    });
    assert.deepEqual(await readFile(join(dest, archive.name)), archive.body);

    await assert.rejects(
      () =>
        downloadPublicRelease({
          repo: "barzoj-co/llmentary",
          tag: "v0.4.1",
          dest,
          env: {},
          fetchImpl: releaseFetch([checksums, archive], {
            mutate: (asset) => (asset.name === archive.name ? Buffer.from("ARCHIVE-BYTES") : asset.body),
          }),
        }),
      /sha256 mismatch/,
    );

    await assert.rejects(
      () =>
        downloadPublicRelease({
          repo: "barzoj-co/llmentary",
          tag: "v0.4.1",
          dest,
          env: {},
          fetchImpl: releaseFetch([checksums, archive], {
            mutate: (asset) => (asset.name === archive.name ? archive.body.subarray(0, 3) : asset.body),
          }),
        }),
      /truncated download/,
    );

    const oversizedListing = {
      ...archive,
      size: archive.body.byteLength + 4,
    };
    await assert.rejects(
      () =>
        downloadPublicRelease({
          repo: "barzoj-co/llmentary",
          tag: "v0.4.1",
          dest,
          env: {},
          fetchImpl: releaseFetch([checksums, oversizedListing]),
        }),
      /size mismatch|truncated download/,
    );

    const traversal = { name: "../etc/passwd", size: 3, digest: `sha256:${"ab".repeat(32)}` };
    await downloadPublicRelease({
      repo: "barzoj-co/llmentary",
      tag: "v0.4.1",
      dest,
      env: {},
      fetchImpl: releaseFetch([checksums, traversal]),
    });
    assert.equal((await readdir(dest)).includes("passwd"), false);
    assert.equal((await readdir(dest)).some((name) => name.includes("etc")), false);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("resolveTag prefers LLMENTARY_TAG, then GITHUB_REF_NAME, then PROXY_VERSION", () => {
  assert.equal(resolveTag({ env: { LLMENTARY_TAG: "v1.0.0", GITHUB_REF_NAME: "v9" }, proxyVersion: "v2" }), "v1.0.0");
  assert.equal(resolveTag({ env: { GITHUB_REF_NAME: "v9.0.0" }, proxyVersion: "v2" }), "v9.0.0");
  assert.equal(resolveTag({ env: {}, proxyVersion: "v0.0.0" }), "v0.0.0");
});

test("resolveDownloadTag never returns PROXY_VERSION file bytes", async () => {
  assert.equal(BUNDLED_PROXY_TAG, "v0.5.1");
  assert.equal(PUBLIC_RELEASE_REPO, "barzoj-co/llmentary");
  assert.equal(await readProxyVersion(), BUNDLED_PROXY_TAG);
  assert.equal(resolveDownloadTag({ env: {}, filePin: "v0.5.1" }), BUNDLED_PROXY_TAG);
  assert.equal(resolveDownloadTag({ env: {}, filePin: BUNDLED_PROXY_TAG }), BUNDLED_PROXY_TAG);
  assert.equal(resolveDownloadTag({ env: {}, filePin: "" }), BUNDLED_PROXY_TAG);
  assert.equal(
    resolveDownloadTag({ env: { LLMENTARY_TAG: "v9.9.9", GITHUB_REF_NAME: "v8" }, filePin: "v0.0.0" }),
    "v9.9.9",
  );
  assert.equal(resolveDownloadTag({ env: { GITHUB_REF_NAME: "v8.1.0" }, filePin: "v0.0.0" }), "v8.1.0");
  assert.throws(() => resolveDownloadTag({ env: {}, filePin: "v0.0.0" }), /does not match bundled pin/);
  assert.throws(() => resolveDownloadTag({ env: { LLMENTARY_TAG: "v1/../x" } }), /invalid tag/);
  assert.throws(() => resolveDownloadTag({ env: { GITHUB_REF_NAME: "v1.0.0+build" } }), /invalid tag/);
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
