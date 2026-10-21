import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { contractPath } from "../src/contract.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const previousOpenapi = process.env.LLMENTARY_OPENAPI_PATH;
const previousBin = process.env.LLMENTARY_BIN;

afterEach(() => {
  if (previousOpenapi === undefined) delete process.env.LLMENTARY_OPENAPI_PATH;
  else process.env.LLMENTARY_OPENAPI_PATH = previousOpenapi;
  if (previousBin === undefined) delete process.env.LLMENTARY_BIN;
  else process.env.LLMENTARY_BIN = previousBin;
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

  it("prefers the contract beside LLMENTARY_BIN over the working directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "llmentary-contract-cwd-"));
    const binDir = await mkdtemp(join(tmpdir(), "llmentary-contract-bin-"));
    const prevCwd = process.cwd();
    try {
      await writeFile(join(cwd, "openapi.yaml"), "cwd: true\n");
      await writeFile(join(binDir, "openapi.yaml"), "bin: true\n");
      await writeFile(join(binDir, "llmentary"), "");
      delete process.env.LLMENTARY_OPENAPI_PATH;
      process.env.LLMENTARY_BIN = join(binDir, "llmentary");
      process.chdir(cwd);
      expect(contractPath()).toBe(join(binDir, "openapi.yaml"));
    } finally {
      process.chdir(prevCwd);
      await rm(cwd, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("finds the package contract when cwd is empty and env is unset", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "llmentary-contract-empty-"));
    const packaged = join(PACKAGE_ROOT, "openapi.yaml");
    const original = existsSync(packaged) ? await readFile(packaged) : undefined;
    const prevCwd = process.cwd();
    try {
      await writeFile(packaged, "from-package: true\n");
      delete process.env.LLMENTARY_OPENAPI_PATH;
      delete process.env.LLMENTARY_BIN;
      process.chdir(cwd);
      expect(contractPath()).toBe(packaged);
    } finally {
      process.chdir(prevCwd);
      if (original !== undefined) await writeFile(packaged, original);
      else await rm(packaged, { force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
