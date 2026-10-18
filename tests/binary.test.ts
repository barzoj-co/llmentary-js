import { describe, expect, it } from "vitest";
import { assetNameCandidates, nativePackageName, parseChecksumFile } from "../src/binary.js";

describe("binary release asset matching", () => {
  it("matches GoReleaser-style Linux x64 tarballs", () => {
    const patterns = assetNameCandidates("linux", "x64");
    expect(patterns.some((pattern) => pattern.test("llmtestlab_Linux_x86_64.tar.gz"))).toBe(true);
    expect(patterns.some((pattern) => pattern.test("llm-test-lab_Linux_amd64.tar.gz"))).toBe(true);
  });

  it("matches Windows zips", () => {
    const patterns = assetNameCandidates("win32", "x64");
    expect(patterns.some((pattern) => pattern.test("llmtestlab_Windows_x86_64.zip"))).toBe(true);
  });

  it("maps platform packages", () => {
    expect(nativePackageName("linux", "x64")).toBe("@llm-test-lab/linux-x64");
    expect(nativePackageName("darwin", "arm64")).toBe("@llm-test-lab/darwin-arm64");
    expect(nativePackageName("win32", "x64")).toBe("@llm-test-lab/win32-x64");
  });

  it("parses GoReleaser checksum lines", () => {
    const checksums = "abc123  llmtestlab_Linux_x86_64.tar.gz\n";
    expect(parseChecksumFile(checksums, "llmtestlab_Linux_x86_64.tar.gz")).toBe("abc123");
  });
});
