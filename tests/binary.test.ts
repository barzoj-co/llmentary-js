import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assetNameCandidates, nativePackageName, parseChecksumFile, resolveBinary } from "../src/binary.js";
import { formatUpstreamSpec, originForGoUpstream, redactArgs, resolveUpstreamSpec } from "../src/proxy.js";

describe("binary release asset matching", () => {
  it("matches GoReleaser-style Linux x64 tarballs", () => {
    const patterns = assetNameCandidates("linux", "x64");
    expect(patterns.some((pattern) => pattern.test("llmtestlab_Linux_x86_64.tar.gz"))).toBe(true);
    expect(patterns.some((pattern) => pattern.test("llm-test-lab_Linux_amd64.tar.gz"))).toBe(true);
  });

  it("matches macOS GoReleaser tarballs", () => {
    expect(assetNameCandidates("darwin", "arm64").some((pattern) => pattern.test("llmtestlab_Darwin_arm64.tar.gz"))).toBe(true);
    expect(assetNameCandidates("darwin", "x64").some((pattern) => pattern.test("llmtestlab_Darwin_x86_64.tar.gz"))).toBe(true);
  });

  it("matches Windows zips", () => {
    const patterns = assetNameCandidates("win32", "x64");
    expect(patterns.some((pattern) => pattern.test("llmtestlab_Windows_x86_64.zip"))).toBe(true);
  });

  it("maps platform packages", () => {
    expect(nativePackageName("linux", "x64")).toBe("@llm-test-lab/linux-x64");
    expect(nativePackageName("linux", "arm64")).toBe("@llm-test-lab/linux-arm64");
    expect(nativePackageName("darwin", "x64")).toBe("@llm-test-lab/darwin-x64");
    expect(nativePackageName("darwin", "arm64")).toBe("@llm-test-lab/darwin-arm64");
    expect(nativePackageName("win32", "x64")).toBe("@llm-test-lab/win32-x64");
  });

  it("parses GoReleaser checksum lines", () => {
    const checksums = "abc123  llmtestlab_Linux_x86_64.tar.gz\n";
    expect(parseChecksumFile(checksums, "llmtestlab_Linux_x86_64.tar.gz")).toBe("abc123");
  });
});

describe("resolveBinary LLMTESTLAB_BIN override", () => {
  const previous = process.env.LLMTESTLAB_BIN;

  afterEach(() => {
    if (previous === undefined) delete process.env.LLMTESTLAB_BIN;
    else process.env.LLMTESTLAB_BIN = previous;
  });

  it("uses LLMTESTLAB_BIN when it points at a readable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "llm-test-lab-bin-"));
    const bin = join(dir, "custom-llmtestlab");
    await writeFile(bin, "#!/bin/sh\n");
    process.env.LLMTESTLAB_BIN = bin;
    await expect(resolveBinary()).resolves.toBe(bin);
  });

  it("throws when LLMTESTLAB_BIN is set but missing", async () => {
    process.env.LLMTESTLAB_BIN = join(tmpdir(), "missing-llmtestlab-binary");
    await expect(resolveBinary()).rejects.toThrow(/LLMTESTLAB_BIN/);
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
  });

  it("strips trailing /v1 so the Go binary does not join /v1/v1", () => {
    expect(originForGoUpstream("https://api.openai.com/v1")).toBe("https://api.openai.com");
    expect(originForGoUpstream("http://127.0.0.1:9/v1/")).toBe("http://127.0.0.1:9");
    expect(originForGoUpstream("https://host/openai/deployments/x?api-version=2024-02-01")).toBe(
      "https://host/openai/deployments/x?api-version=2024-02-01",
    );
    expect(originForGoUpstream("https://host/v1?api-version=2024-02-01")).toBe("https://host/?api-version=2024-02-01");
    expect(originForGoUpstream("https://host/foo?redirect=/v1")).toBe("https://host/foo?redirect=/v1");
    expect(resolveUpstreamSpec({ upstreamBaseUrl: "http://127.0.0.1:9/v1" })).toBe("openai=http://127.0.0.1:9");
    expect(resolveUpstreamSpec({ upstreams: "openai=https://api.openai.com/v1" })).toBe("openai=https://api.openai.com");
    expect(
      resolveUpstreamSpec({
        env: { LLMTESTLAB_UPSTREAM_BASE_URL: "", OPENAI_BASE_URL: "  " },
      }),
    ).toBe("openai=https://api.openai.com");
    expect(
      resolveUpstreamSpec({
        upstreamBaseUrl: "",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      }),
    ).toBe("openai=https://api.openai.com");
    expect(resolveUpstreamSpec({ upstreamBaseUrl: "https://host/v1?api-version=2024-02-01" })).toBe(
      "openai=https://host/?api-version=2024-02-01",
    );
  });
});
