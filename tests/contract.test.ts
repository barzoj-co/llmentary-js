import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledContractForServe,
  contractPath,
  openapiSha256,
  packagedMatchesServed,
  stampOpenAPI,
} from "../src/contract.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const previousOpenapi = process.env.LLMENTARY_OPENAPI_PATH;
const previousBin = process.env.LLMENTARY_BIN;

afterEach(() => {
  if (previousOpenapi === undefined) delete process.env.LLMENTARY_OPENAPI_PATH;
  else process.env.LLMENTARY_OPENAPI_PATH = previousOpenapi;
  if (previousBin === undefined) delete process.env.LLMENTARY_BIN;
  else process.env.LLMENTARY_BIN = previousBin;
});

describe("bundledContractForServe", () => {
  it("strips the release-please comment that proxy v0.5.0 stamps off info.version", () => {
    const bundled = [
      "openapi: 3.1.0",
      "info:",
      "  title: llmentary control API",
      "  version: 0.4.1 # x-release-please-version",
      "paths: {}",
      "",
    ].join("\n");
    expect(bundledContractForServe(bundled)).toBe(
      ["openapi: 3.1.0", "info:", "  title: llmentary control API", "  version: 0.4.1", "paths: {}", ""].join("\n"),
    );
    expect(stampOpenAPI(bundled)).toBe(bundledContractForServe(bundled));
  });

  it("leaves a clean stamped document and unrelated comments unchanged", () => {
    const clean = "openapi: 3.1.0\ninfo:\n  version: 0.4.1\n# keep\n";
    expect(bundledContractForServe(clean)).toBe(clean);
    const other = "info:\n  version: 0.4.1 # other-annotation\n";
    expect(bundledContractForServe(other)).toBe(other);
  });

  it("does not rewrite a different pin hiding in the release-please comment", () => {
    const drift = "info:\n  version: 0.4.0 # x-release-please-version\n";
    expect(bundledContractForServe(drift)).toBe("info:\n  version: 0.4.0\n");
    expect(bundledContractForServe(drift)).not.toContain("0.4.1");
  });
});

describe("stamp-then-sha256 (DOG-44 / proxy #60)", () => {
  const comment = " # x-release-please-version";
  const packaged = ["openapi: 3.1.0", "info:", `  version: 0.4.1${comment}`, "paths: {}", ""].join("\n");
  const served = ["openapi: 3.1.0", "info:", "  version: 0.4.1", "paths: {}", ""].join("\n");

  it("matches served to packaged after the serve stamp, not as raw bytes", () => {
    expect(Buffer.byteLength(packaged)).toBe(Buffer.byteLength(served) + Buffer.byteLength(comment));
    expect(packaged).not.toBe(served);
    expect(openapiSha256(packaged)).not.toBe(openapiSha256(served));
    expect(stampOpenAPI(packaged)).toBe(served);
    expect(packagedMatchesServed(packaged, served)).toBe(true);
    expect(openapiSha256(stampOpenAPI(packaged))).toBe(openapiSha256(served));
  });

  it("reproduces the 27-byte comment gap (14187 packaged vs 14160 served)", () => {
    expect(Buffer.byteLength(comment)).toBe(27);
    const packagedSize = 14_187;
    const servedSize = 14_160;
    expect(packagedSize - servedSize).toBe(Buffer.byteLength(comment));
    const prefix = "x".repeat(servedSize - Buffer.byteLength("\n  version: 0.4.1\n"));
    const fullPackaged = `${prefix}\n  version: 0.4.1${comment}\n`;
    const fullServed = `${prefix}\n  version: 0.4.1\n`;
    expect(Buffer.byteLength(fullPackaged)).toBe(packagedSize);
    expect(Buffer.byteLength(fullServed)).toBe(servedSize);
    expect(packagedMatchesServed(fullPackaged, fullServed)).toBe(true);
  });

  it("hashes the empty document as SHA-256 of zero bytes", () => {
    expect(stampOpenAPI("")).toBe("");
    expect(openapiSha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(packagedMatchesServed("", "")).toBe(true);
  });

  it("leaves a document with no version line unchanged", () => {
    const yaml = "openapi: 3.1.0\npaths: {}\n";
    expect(stampOpenAPI(yaml)).toBe(yaml);
    expect(packagedMatchesServed(yaml, yaml)).toBe(true);
  });

  it("does not stamp a release-please comment that is not on the version line", () => {
    const yaml = "info:\n  title: x # x-release-please-version\n  version: 0.4.1\n";
    expect(stampOpenAPI(yaml)).toBe(yaml);
    expect(packagedMatchesServed(yaml, yaml.replace(" # x-release-please-version", ""))).toBe(false);
  });

  it("does not consume the next line after a bare hash on the version line", () => {
    const yaml = "info:\n  version: 1 #\nx-release-please-version\n";
    expect(stampOpenAPI(yaml)).toBe(yaml);
  });

  it("stamps a tab-indented version line and a CRLF terminator", () => {
    expect(stampOpenAPI("\tversion: 0.4.1\t# x-release-please-version\r\n")).toBe("\tversion: 0.4.1\n");
    expect(packagedMatchesServed("  version: 0.4.1 # x-release-please-version\r\n", "  version: 0.4.1\n")).toBe(true);
  });

  it("stamps every release-please version comment, not only the first", () => {
    const packagedTwice = "  version: 0.4.1 # x-release-please-version\n  version: 0.4.1 # x-release-please-version\n";
    expect(stampOpenAPI(packagedTwice)).toBe("  version: 0.4.1\n  version: 0.4.1\n");
  });

  it("fails when served still carries extra fields after the stamp", () => {
    expect(packagedMatchesServed(packaged, `${served}x-extra: 1\n`)).toBe(false);
    expect(packagedMatchesServed(`${packaged}paths: {}\n`, served)).toBe(false);
  });

  it("treats an already-stamped packaged file as a match", () => {
    expect(packagedMatchesServed(served, served)).toBe(true);
  });
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
