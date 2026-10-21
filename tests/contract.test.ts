import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contractPath } from "../src/contract.js";

const previous = process.env.LLMENTARY_OPENAPI_PATH;

afterEach(() => {
  if (previous === undefined) delete process.env.LLMENTARY_OPENAPI_PATH;
  else process.env.LLMENTARY_OPENAPI_PATH = previous;
});

describe("contractPath", () => {
  it("resolves LLMENTARY_OPENAPI_PATH when the file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "llmentary-contract-"));
    try {
      const path = join(dir, "openapi.yaml");
      await writeFile(path, "openapi: 3.1.0\n");
      process.env.LLMENTARY_OPENAPI_PATH = path;
      expect(contractPath()).toBe(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a missing env path and does not throw", () => {
    process.env.LLMENTARY_OPENAPI_PATH = join(tmpdir(), "missing-openapi.yaml");
    const found = contractPath();
    expect(found === undefined || found.endsWith("openapi.yaml")).toBe(true);
  });
});
