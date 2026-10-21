import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

describe("binary release asset matching", () => {
  it("pins PROXY_VERSION to v0.3.0", () => {
    const pin = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "PROXY_VERSION"), "utf8").trim();
    expect(pin).toBe("v0.3.0");
  });

  it("install-proxy.sh --self-test accepts the current pin and archive names", () => {
    const result = spawnSync("bash", ["scripts/install-proxy.sh", "--self-test"], {
      encoding: "utf8",
      cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("v0.3.0");
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
