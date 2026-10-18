import { describe, expect, it } from "vitest";
import { assetNameCandidates } from "../src/binary.js";

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
});
