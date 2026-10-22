import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BINARY_NAME,
  DEFAULT_REPO,
  assetNameCandidates,
  nativePackageName,
  parseChecksumFile,
  resolveBinary,
} from "../src/binary.js";
import { formatUpstreamSpec, looksLikeLlmentaryProxy, originForGoUpstream, redactArgs, resolveUpstreamSpec } from "../src/proxy.js";

function runVerifyAssets(
  assets: string,
  options: { token?: string; curlExit?: number; body?: string } = {},
): ReturnType<typeof spawnSync> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "llmentary-curl-"));
  const curl = join(dir, "curl");
  const seen = join(dir, "curl-args.txt");
  const names = assets
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  const payload =
    options.body ??
    JSON.stringify({
      assets: names.map((name) => ({ name })),
    });
  writeFileSync(join(dir, "release.json"), payload);
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(seen)}
url=""
for arg in "$@"; do
  if [[ "$arg" == http://* || "$arg" == https://* ]]; then
    url="$arg"
  fi
done
if [[ "\${CURL_EXIT:-0}" != "0" ]]; then
  exit "\${CURL_EXIT}"
fi
if [[ "$url" == *"/releases/tags/"* ]]; then
  cat ${JSON.stringify(join(dir, "release.json"))}
  exit 0
fi
echo "unexpected curl $*" >&2
exit 1
`,
  );
  chmodSync(curl, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    CURL_EXIT: options.curlExit ? String(options.curlExit) : "0",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.CURL_GITHUB_HOLD_FILE;
  delete env.CURL_GITHUB_PRINT_ARGS;
  delete env.CURL_FAKE_READY;
  if (options.token !== undefined) {
    env.GH_TOKEN = options.token;
  }
  try {
    return spawnSync("bash", ["scripts/install-proxy.sh", "--verify-assets"], {
      encoding: "utf8",
      cwd: root,
      env,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runVerifyAssetsKeepingLogs(
  assets: string,
  options: { token?: string } = {},
): { result: ReturnType<typeof spawnSync>; args: string } {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "llmentary-curl-log-"));
  const curl = join(dir, "curl");
  const seen = join(dir, "curl-args.txt");
  const names = assets
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  writeFileSync(join(dir, "release.json"), JSON.stringify({ assets: names.map((name) => ({ name })) }));
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'argv:%s\\n' "$*" >> ${JSON.stringify(seen)}
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-H" && "$arg" == @* ]]; then
    printf 'header:%s\\n' "$(cat "\${arg#@}")" >> ${JSON.stringify(seen)}
  fi
  prev="$arg"
done
url=""
for arg in "$@"; do
  if [[ "$arg" == http://* || "$arg" == https://* ]]; then
    url="$arg"
  fi
done
if [[ "$url" == *"/releases/tags/"* ]]; then
  cat ${JSON.stringify(join(dir, "release.json"))}
  exit 0
fi
echo "unexpected curl $*" >&2
exit 1
`,
  );
  chmodSync(curl, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.CURL_GITHUB_HOLD_FILE;
  delete env.CURL_GITHUB_PRINT_ARGS;
  delete env.CURL_FAKE_READY;
  if (options.token !== undefined) env.GH_TOKEN = options.token;
  const result = spawnSync("bash", ["scripts/install-proxy.sh", "--verify-assets"], {
    encoding: "utf8",
    cwd: root,
    env,
  });
  const args = readFileSync(seen, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { result, args };
}

describe("binary release asset matching", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pin = readFileSync(join(root, "PROXY_VERSION"), "utf8").trim();
  const version = pin.replace(/^v/, "");

  it("pins PROXY_VERSION to v0.5.0", () => {
    expect(pin).toBe("v0.5.0");
    expect(pin).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("locks every optional platform package so npm ci can resolve them", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      optionalDependencies: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
    };
    const optional = pkg.optionalDependencies;
    expect(Object.keys(optional).sort()).toEqual([
      "@llmentary/darwin-arm64",
      "@llmentary/darwin-x64",
      "@llmentary/linux-arm64",
      "@llmentary/linux-x64",
      "@llmentary/win32-x64",
    ]);
    for (const [name, expected] of Object.entries(optional)) {
      expect(expected, name).toBe(version);
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, `Missing: ${name}@${expected} from lock file`).toBeDefined();
      expect(entry?.version, name).toBe(expected);
      const tarball = `${name.split("/")[1]}-${expected}.tgz`;
      expect(entry?.resolved, name).toMatch(new RegExp(`/${tarball.replace(/\./g, "\\.")}$`));
      expect(entry?.integrity, name).toMatch(/^sha512-/);
    }
  });

  it("keeps installer self-test, pack example, and current-pin docs on PROXY_VERSION", () => {
    const installer = readFileSync(join(root, "scripts/install-proxy.sh"), "utf8");
    const packer = readFileSync(join(root, "scripts/pack-platform-binaries.mjs"), "utf8");
    const binaries = readFileSync(join(root, "docs/binaries.md"), "utf8");
    const releasing = readFileSync(join(root, "docs/releasing.md"), "utf8");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(installer).toContain(`[[ "$tag" == "${pin}" ]]`);
    expect(installer).toContain(`llmentary_${version}_linux_amd64.tar.gz`);
    expect(installer).toContain(`llmentary_${version}_linux_arm64.tar.gz`);
    expect(installer).toContain(`llmentary_${version}_darwin_amd64.tar.gz`);
    expect(installer).toContain(`llmentary_${version}_darwin_arm64.tar.gz`);
    expect(installer).toContain(`llmentary_${version}_windows_amd64.zip`);
    expect(installer).toContain(`llmentary_${version}_windows_arm64.zip`);
    expect(installer).not.toContain("LLMENTARY_RELEASE_ASSETS");
    expect(packer).toContain(`for example ${pin}`);
    expect(packer).toContain(`export const BUNDLED_PROXY_TAG = "${pin}"`);
    expect(packer).toContain("resolveDownloadTag");
    expect(installer).toContain("assert_blocked_curl_stops");
    expect(binaries).toContain(`currently \`${pin}\``);
    expect(releasing).toContain(`pin is \`${pin}\``);
    expect(readme).toContain(`proxy **${pin}**`);
    expect(readme).toContain(`Bundled proxy **${pin}**`);
  });

  it("install-proxy.sh --self-test accepts the current pin and archive names", () => {
    const result = spawnSync("bash", ["scripts/install-proxy.sh", "--self-test"], {
      encoding: "utf8",
      cwd: root,
    });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain(pin);
  });

  it("rejects a PROXY_VERSION that does not match the installer pin", () => {
    const mismatch = spawnSync(
      "bash",
      [
        "-c",
        'root="$1"; tmp="$(mktemp -d)"; trap \'rm -rf "$tmp"\' EXIT; mkdir -p "$tmp/scripts"; cp "$root/scripts/install-proxy.sh" "$tmp/scripts/install-proxy.sh"; printf "%s\\n" "v0.0.0" > "$tmp/PROXY_VERSION"; bash "$tmp/scripts/install-proxy.sh" --self-test',
        "mismatch",
        root,
      ],
      { encoding: "utf8" },
    );
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/PROXY_VERSION must be v0\.5\.0, got v0\.0\.0/);
  });

  it("install-proxy.sh downloads public releases with curl, not gh", () => {
    const installer = readFileSync(join(root, "scripts/install-proxy.sh"), "utf8");
    expect(installer).not.toMatch(/\bgh release\b/);
    expect(installer).not.toContain("command -v gh");
    expect(installer).not.toContain("LLMTESTLAB_REPO_TOKEN");
    expect(installer).toContain("https://github.com/${REPO}/releases/download/");
    expect(installer).toContain("https://api.github.com/repos/${REPO}/releases/tags/");
    expect(installer).toContain('args+=(-H "@${header_file}")');
    expect(installer).not.toContain('args+=(-H "Authorization: Bearer ${token}")');
    expect(installer).toContain("trap 'interrupt_install_proxy 130' INT");
    expect(installer).toContain("trap 'interrupt_install_proxy 143' TERM");
    expect(installer).toContain("stop_curl_pid");
    expect(installer).toContain("setsid curl");
    expect(installer).toContain("register_install_proxy_cleanup");
  });

  it("verify_pinned_release_assets accepts the six archives plus signed checksums and an SBOM", () => {
    const assets = [
      "checksums.txt",
      "checksums.txt.sigstore.json",
      `llmentary_${version}_linux_amd64.tar.gz`,
      `llmentary_${version}_linux_arm64.tar.gz`,
      `llmentary_${version}_darwin_amd64.tar.gz`,
      `llmentary_${version}_darwin_arm64.tar.gz`,
      `llmentary_${version}_windows_amd64.zip`,
      `llmentary_${version}_windows_arm64.zip`,
      `llmentary_${version}_linux_amd64.tar.gz.sbom.json`,
    ].join("\n");
    const result = runVerifyAssets(assets);
    expect(result.status, String(result.stderr)).toBe(0);
  });

  it.each([
    ["missing checksums.txt", { drop: "checksums.txt" }, /missing asset checksums\.txt/],
    [
      "missing linux amd64 archive",
      { drop: `llmentary_${version}_linux_amd64.tar.gz` },
      /missing asset llmentary_.*_linux_amd64\.tar\.gz/,
    ],
    ["no SBOM", { drop: `llmentary_${version}_linux_amd64.tar.gz.sbom.json` }, /has no SBOM assets/],
    ["windows archive with tar.gz suffix", { add: `llmentary_${version}_windows_amd64.tar.gz` }, /windows archive with tar\.gz suffix/],
    ["linux archive with zip suffix", { add: `llmentary_${version}_linux_amd64.zip` }, /linux archive with zip suffix/],
  ] as const)("verify_pinned_release_assets rejects %s", (_label, tweak, error) => {
    const complete = [
      "checksums.txt",
      "checksums.txt.sigstore.json",
      `llmentary_${version}_linux_amd64.tar.gz`,
      `llmentary_${version}_linux_arm64.tar.gz`,
      `llmentary_${version}_darwin_amd64.tar.gz`,
      `llmentary_${version}_darwin_arm64.tar.gz`,
      `llmentary_${version}_windows_amd64.zip`,
      `llmentary_${version}_windows_arm64.zip`,
      `llmentary_${version}_linux_amd64.tar.gz.sbom.json`,
    ];
    const names = complete.filter((name) => name !== ("drop" in tweak ? tweak.drop : ""));
    if ("add" in tweak) names.push(tweak.add);
    const result = runVerifyAssets(names.join("\n"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(error);
  });

  it("verify_pinned_release_assets rejects empty, non-JSON, and curl failures", () => {
    const complete = [
      "checksums.txt",
      "checksums.txt.sigstore.json",
      `llmentary_${version}_linux_amd64.tar.gz`,
      `llmentary_${version}_linux_arm64.tar.gz`,
      `llmentary_${version}_darwin_amd64.tar.gz`,
      `llmentary_${version}_darwin_arm64.tar.gz`,
      `llmentary_${version}_windows_amd64.zip`,
      `llmentary_${version}_windows_arm64.zip`,
      `llmentary_${version}_linux_amd64.tar.gz.sbom.json`,
    ].join("\n");
    expect(runVerifyAssets(complete, { body: "{" }).status).not.toBe(0);
    expect(runVerifyAssets(complete, { body: JSON.stringify({ assets: [] }) }).stderr).toMatch(/listed no assets/);
    expect(runVerifyAssets(complete, { curlExit: 22 }).status).not.toBe(0);
  });

  it("verify_pinned_release_assets never invokes gh", () => {
    const complete = [
      "checksums.txt",
      "checksums.txt.sigstore.json",
      `llmentary_${version}_linux_amd64.tar.gz`,
      `llmentary_${version}_linux_arm64.tar.gz`,
      `llmentary_${version}_darwin_amd64.tar.gz`,
      `llmentary_${version}_darwin_arm64.tar.gz`,
      `llmentary_${version}_windows_amd64.zip`,
      `llmentary_${version}_windows_arm64.zip`,
      `llmentary_${version}_linux_amd64.tar.gz.sbom.json`,
    ].join("\n");
    const result = runVerifyAssets(complete);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stderr).not.toMatch(/unexpected gh|gh must not be called/);
  });

  it("sends Authorization only when a rate-limit token is set", () => {
    const complete = [
      "checksums.txt",
      "checksums.txt.sigstore.json",
      `llmentary_${version}_linux_amd64.tar.gz`,
      `llmentary_${version}_linux_arm64.tar.gz`,
      `llmentary_${version}_darwin_amd64.tar.gz`,
      `llmentary_${version}_darwin_arm64.tar.gz`,
      `llmentary_${version}_windows_amd64.zip`,
      `llmentary_${version}_windows_arm64.zip`,
      `llmentary_${version}_linux_amd64.tar.gz.sbom.json`,
    ].join("\n");
    const anonymous = runVerifyAssetsKeepingLogs(complete);
    expect(anonymous.result.status, String(anonymous.result.stderr)).toBe(0);
    expect(anonymous.args).not.toMatch(/Authorization:/);
    const authed = runVerifyAssetsKeepingLogs(complete, { token: "rate-limit-only" });
    expect(authed.result.status, String(authed.result.stderr)).toBe(0);
    const argv = authed.args
      .split("\n")
      .filter((line) => line.startsWith("argv:"))
      .join("\n");
    expect(argv).toMatch(/-H @/);
    expect(argv).not.toMatch(/rate-limit-only/);
    expect(authed.args).toMatch(/^header:Authorization: Bearer rate-limit-only$/m);
  });

  it("matches GoReleaser-style Linux x64 tarballs", () => {
    const patterns = assetNameCandidates("linux", "x64");
    expect(patterns.some((pattern) => pattern.test("llmentary_0.2.0_linux_amd64.tar.gz"))).toBe(true);
    expect(patterns.some((pattern) => pattern.test("llmentary_linux_amd64.tar.gz"))).toBe(true);
  });

  it("matches macOS GoReleaser tarballs", () => {
    expect(assetNameCandidates("darwin", "arm64").some((pattern) => pattern.test("llmentary_0.2.0_darwin_arm64.tar.gz"))).toBe(
      true,
    );
    expect(assetNameCandidates("darwin", "x64").some((pattern) => pattern.test("llmentary_0.2.0_darwin_amd64.tar.gz"))).toBe(
      true,
    );
  });

  it("matches Windows zips", () => {
    const patterns = assetNameCandidates("win32", "x64");
    expect(patterns.some((pattern) => pattern.test("llmentary_0.2.0_windows_amd64.zip"))).toBe(true);
  });

  it("rejects the pre-rename archive names", () => {
    const linux = assetNameCandidates("linux", "x64");
    const darwin = assetNameCandidates("darwin", "arm64");
    const old = ["l", "ab"].join("");
    const hyphenated = ["llm", "test", old].join("-");
    const compact = ["llm", "test"].join("") + old;
    expect(linux.some((pattern) => pattern.test(`${hyphenated}_0.2.0_linux_amd64.tar.gz`))).toBe(false);
    expect(linux.some((pattern) => pattern.test(`${compact}_Linux_x86_64.tar.gz`))).toBe(false);
    expect(darwin.some((pattern) => pattern.test(`${hyphenated}_0.2.0_darwin_arm64.tar.gz`))).toBe(false);
  });

  it("defaults to the llmentary proxy repo and binary name", () => {
    expect(DEFAULT_REPO).toBe("barzoj-co/llmentary");
    expect(DEFAULT_BINARY_NAME).toBe("llmentary");
  });

  it("maps platform packages", () => {
    expect(nativePackageName("linux", "x64")).toBe("@llmentary/linux-x64");
    expect(nativePackageName("linux", "arm64")).toBe("@llmentary/linux-arm64");
    expect(nativePackageName("darwin", "x64")).toBe("@llmentary/darwin-x64");
    expect(nativePackageName("darwin", "arm64")).toBe("@llmentary/darwin-arm64");
    expect(nativePackageName("win32", "x64")).toBe("@llmentary/win32-x64");
  });

  it("parses GoReleaser checksum lines", () => {
    const checksums = "abc123  llmentary_0.2.0_linux_amd64.tar.gz\n";
    expect(parseChecksumFile(checksums, "llmentary_0.2.0_linux_amd64.tar.gz")).toBe("abc123");
  });
});

describe("resolveBinary LLMENTARY_BIN override", () => {
  const previous = process.env.LLMENTARY_BIN;

  afterEach(() => {
    if (previous === undefined) delete process.env.LLMENTARY_BIN;
    else process.env.LLMENTARY_BIN = previous;
  });

  it("uses LLMENTARY_BIN when it points at a readable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "llmentary-bin-"));
    const bin = join(dir, "custom-llmentary");
    await writeFile(bin, "#!/bin/sh\n");
    process.env.LLMENTARY_BIN = bin;
    await expect(resolveBinary()).resolves.toBe(bin);
  });

  it("throws when LLMENTARY_BIN is set but missing", async () => {
    process.env.LLMENTARY_BIN = join(tmpdir(), "missing-llmentary-binary");
    await expect(resolveBinary()).rejects.toThrow(/LLMENTARY_BIN/);
  });
});

describe("proxy CLI helpers", () => {
  it("formats named upstream specs", () => {
    expect(formatUpstreamSpec("openai", "https://api.openai.com/v1")).toBe("openai=https://api.openai.com/v1");
    expect(formatUpstreamSpec("openai", "openai=http://127.0.0.1:9/v1")).toBe("openai=http://127.0.0.1:9/v1");
    expect(formatUpstreamSpec("openai", "https://host/openai/deployments/x?api-version=2024-02-01")).toBe(
      "openai=https://host/openai/deployments/x?api-version=2024-02-01",
    );
    expect(() => formatUpstreamSpec("openai;rm", "http://127.0.0.1")).toThrow(/Invalid upstream name/);
  });

  it("redacts control tokens from logged args", () => {
    expect(redactArgs(["-listen", ":7777", "-control-token", "secret", "-upstream", "openai=http://x"])).toEqual([
      "-listen",
      ":7777",
      "-control-token",
      "***",
      "-upstream",
      "openai=http://x",
    ]);
    expect(redactArgs(["-listen", ":7777", "-control-token=secret", "--bearer-token=other"])).toEqual([
      "-listen",
      ":7777",
      "-control-token=***",
      "--bearer-token=***",
    ]);
  });

  it("keeps originForGoUpstream available but resolveUpstreamSpec no longer strips /v1", () => {
    expect(originForGoUpstream("https://api.openai.com/v1")).toBe("https://api.openai.com");
    expect(originForGoUpstream("http://127.0.0.1:9/v1/")).toBe("http://127.0.0.1:9");
    expect(originForGoUpstream("https://host/openai/deployments/x?api-version=2024-02-01")).toBe(
      "https://host/openai/deployments/x?api-version=2024-02-01",
    );
    expect(originForGoUpstream("https://host/v1?api-version=2024-02-01")).toBe("https://host/?api-version=2024-02-01");
    expect(originForGoUpstream("https://host/foo?redirect=/v1")).toBe("https://host/foo?redirect=/v1");
    expect(resolveUpstreamSpec({ upstreamBaseUrl: "http://127.0.0.1:9/v1" })).toBe("openai=http://127.0.0.1:9/v1");
    expect(resolveUpstreamSpec({ upstreams: "openai=https://api.openai.com/v1" })).toBe(
      "openai=https://api.openai.com/v1",
    );
    expect(
      resolveUpstreamSpec({
        env: { LLMENTARY_UPSTREAM_BASE_URL: "", OPENAI_BASE_URL: "  " },
      }),
    ).toBeUndefined();
    expect(
      resolveUpstreamSpec({
        upstreamBaseUrl: "",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      }),
    ).toBeUndefined();
    expect(resolveUpstreamSpec({ upstreamBaseUrl: "https://host/v1?api-version=2024-02-01" })).toBe(
      "openai=https://host/v1?api-version=2024-02-01",
    );
    expect(resolveUpstreamSpec({ env: {} })).toBeUndefined();
  });

  it("does not read OPENAI_BASE_URL as the upstream", () => {
    expect(
      resolveUpstreamSpec({
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      }),
    ).toBeUndefined();
    expect(
      resolveUpstreamSpec({
        env: { LLMENTARY_UPSTREAM_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_BASE_URL: "http://127.0.0.1:7777/v1" },
      }),
    ).toBe("openai=https://openrouter.ai/api/v1");
  });

  it("warns when OPENAI_BASE_URL points at a llmentary proxy", () => {
    expect(looksLikeLlmentaryProxy("http://127.0.0.1:7777/s/t1/v1")).toBe(true);
    expect(looksLikeLlmentaryProxy("https://api.openai.com/v1")).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      resolveUpstreamSpec({
        env: {
          OPENAI_BASE_URL: "http://127.0.0.1:4010/s/abc/v1",
          LLMENTARY_PROXY_URL: "http://127.0.0.1:4010",
        },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/OPENAI_BASE_URL points at a llmentary proxy/));
    } finally {
      warn.mockRestore();
    }
  });
});
