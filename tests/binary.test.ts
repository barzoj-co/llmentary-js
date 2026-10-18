import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assetNameCandidates, nativePackageName, parseChecksumFile, resolveBinary } from "../src/binary.js";

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
