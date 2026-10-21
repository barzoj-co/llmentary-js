import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assetNameCandidates,
  downloadBinary,
  extractArchive,
  fileExists,
  nativePackageName,
  parseChecksumFile,
  resolveBinary,
} from "../src/binary.js";

const envKeys = [
  "LLMENTARY_BIN",
  "PATH",
  "GITHUB_TOKEN",
  "LLMENTARY_GITHUB_TOKEN",
  "LLMENTARY_CACHE_DIR",
] as const;

const previousEnv: Record<string, string | undefined> = {};
const tmpRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of envKeys) {
    if (!(key in previousEnv)) continue;
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
    delete previousEnv[key];
  }
  for (const root of tmpRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function stash(key: (typeof envKeys)[number], value: string | undefined): void {
  if (!(key in previousEnv)) previousEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

async function writeExecutable(path: string, body = "#!/bin/sh\n"): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

async function makeTarGz(dir: string, archiveName: string, layout: Record<string, string>): Promise<string> {
  const src = join(dir, "src");
  for (const [rel, contents] of Object.entries(layout)) {
    await writeExecutable(join(src, rel), contents);
  }
  const archivePath = join(dir, archiveName);
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("tar", ["-czf", archivePath, "-C", src, ...Object.keys(layout)], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr}`);
  }
  return archivePath;
}

async function makeZip(dir: string, archiveName: string, layout: Record<string, string>): Promise<string> {
  const src = join(dir, "zipsrc");
  for (const [rel, contents] of Object.entries(layout)) {
    await writeExecutable(join(src, rel), contents);
  }
  const archivePath = join(dir, archiveName);
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("zip", ["-q", "-r", archivePath, ...Object.keys(layout)], {
    encoding: "utf8",
    cwd: src,
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr}`);
  }
  return archivePath;
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("nativePackageName and checksum parsing", () => {
  it("returns undefined for platforms without a published package", () => {
    expect(nativePackageName("aix", "x64")).toBeUndefined();
    expect(nativePackageName("linux", "ia32")).toBeUndefined();
  });

  it("defaults to the current process platform and arch", () => {
    expect(nativePackageName()).toBe(nativePackageName(process.platform, process.arch));
  });

  it("accepts binary-mode and token checksum lines", () => {
    expect(parseChecksumFile("deadbeef *archive.tar.gz\n", "archive.tar.gz")).toBe("deadbeef");
    expect(parseChecksumFile("cafe  extra  archive.tar.gz\n", "/tmp/nested/archive.tar.gz")).toBe("cafe");
    expect(parseChecksumFile("abc  other.tar.gz\r\n", "archive.tar.gz")).toBeUndefined();
  });

  it("matches ia32 and unknown GOOS/GOARCH asset names", () => {
    expect(assetNameCandidates("linux", "ia32").some((pattern) => pattern.test("llmentary_0.4.0_linux_386.tar.gz"))).toBe(
      true,
    );
    expect(
      assetNameCandidates("freebsd", "mips").some((pattern) => pattern.test("llmentary_0.4.0_freebsd_mips.tar.gz")),
    ).toBe(true);
  });
});

describe("fileExists", () => {
  it("is true for files and directories and false when missing", async () => {
    const dir = await scratch("llmentary-exists-");
    const file = join(dir, "present");
    await writeFile(file, "ok");
    await expect(fileExists(file)).resolves.toBe(true);
    await expect(fileExists(dir)).resolves.toBe(true);
    await expect(fileExists(join(dir, "missing"))).resolves.toBe(false);
  });
});

describe("resolveBinary fallbacks", () => {
  it("prefers a cwd-installed optional platform package over PATH", async () => {
    const pkg = nativePackageName("linux", "x64");
    expect(pkg).toBe("@llmentary/linux-x64");
    if (!pkg) throw new Error("expected linux-x64 native package name");
    stash("LLMENTARY_BIN", undefined);
    const root = await scratch("llmentary-native-");
    const decoy = await writeExecutable(join(root, "path", "llmentary"));
    const native = await writeExecutable(join(root, "node_modules", pkg, "bin", "llmentary"), "#!/bin/sh\necho native\n");
    stash("PATH", dirname(decoy));
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await expect(resolveBinary({ platform: "linux", arch: "x64", cacheDir: join(root, "empty-cache") })).resolves.toBe(
        native,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses PATH when no native package exists for the platform", async () => {
    stash("LLMENTARY_BIN", undefined);
    const dir = await scratch("llmentary-on-path-");
    const bin = await writeExecutable(join(dir, "llmentary"));
    stash("PATH", dir);
    await expect(resolveBinary({ platform: "aix", arch: "x64", cacheDir: join(dir, "empty-cache") })).resolves.toBe(bin);
  });

  it("uses a versioned cache entry when PATH is empty", async () => {
    stash("LLMENTARY_BIN", undefined);
    stash("PATH", "");
    const dir = await scratch("llmentary-cache-");
    const cached = await writeExecutable(join(dir, "v0.4.0", "llmentary"));
    await expect(resolveBinary({ platform: "aix", arch: "x64", cacheDir: dir, version: "v0.4.0" })).resolves.toBe(cached);
  });

  it("selects the newest cached release tag when version is omitted", async () => {
    stash("LLMENTARY_BIN", undefined);
    stash("PATH", "");
    const dir = await scratch("llmentary-cache-scan-");
    await writeExecutable(join(dir, "v0.3.0", "llmentary"));
    const newest = await writeExecutable(join(dir, "v0.4.0", "llmentary"));
    await mkdir(join(dir, "v0.5.0"), { recursive: true });
    await expect(resolveBinary({ platform: "aix", arch: "x64", cacheDir: dir })).resolves.toBe(newest);
  });

  it("orders non-numeric cache tags after numeric ones", async () => {
    stash("LLMENTARY_BIN", undefined);
    stash("PATH", "");
    const dir = await scratch("llmentary-cache-tags-");
    await writeExecutable(join(dir, "nightly", "llmentary"));
    const tagged = await writeExecutable(join(dir, "v1.0.0", "llmentary"));
    await expect(resolveBinary({ platform: "aix", arch: "x64", cacheDir: dir })).resolves.toBe(tagged);
  });

  it("breaks equal numeric cache versions with the tag string", async () => {
    stash("LLMENTARY_BIN", undefined);
    stash("PATH", "");
    const dir = await scratch("llmentary-cache-eq-");
    await writeExecutable(join(dir, "1.0.0", "llmentary"));
    const preferred = await writeExecutable(join(dir, "v1.0.0", "llmentary"));
    await expect(resolveBinary({ platform: "aix", arch: "x64", cacheDir: dir })).resolves.toBe(preferred);
  });

  it("throws when no env, native package, PATH, or cache entry exists", async () => {
    stash("LLMENTARY_BIN", undefined);
    stash("PATH", "");
    const dir = await scratch("llmentary-missing-");
    await expect(resolveBinary({ platform: "aix", arch: "x64", cacheDir: dir, binaryName: "llmentary" })).rejects.toThrow(
      /never downloads binaries/,
    );
  });
});

describe("extractArchive", () => {
  it("extracts a root-level binary from a tar.gz", async () => {
    const dir = await scratch("llmentary-tar-");
    const archive = await makeTarGz(dir, "llmentary_0.4.0_linux_amd64.tar.gz", { llmentary: "#!/bin/sh\necho root\n" });
    const dest = join(dir, "out", "llmentary");
    await mkdir(dirname(dest), { recursive: true });
    await extractArchive(archive, dirname(dest), dest);
    await expect(readFile(dest, "utf8")).resolves.toContain("echo root");
  });

  it("renames a nested archive member onto the target path", async () => {
    const dir = await scratch("llmentary-nested-");
    const archive = await makeTarGz(dir, "bundle.tar.gz", { "pkg/llmentary": "#!/bin/sh\necho nested\n" });
    const dest = join(dir, "out", "llmentary");
    await mkdir(dirname(dest), { recursive: true });
    await extractArchive(archive, dirname(dest), dest);
    await expect(readFile(dest, "utf8")).resolves.toContain("echo nested");
  });

  it("extracts a zip archive with unzip", async () => {
    const dir = await scratch("llmentary-zip-");
    const archive = await makeZip(dir, "llmentary_0.4.0_windows_amd64.zip", { "llmentary.exe": "MZ" });
    const dest = join(dir, "out", "llmentary.exe");
    await mkdir(dirname(dest), { recursive: true });
    await extractArchive(archive, dirname(dest), dest);
    await expect(fileExists(dest)).resolves.toBe(true);
  });

  it("rejects an archive that does not contain llmentary", async () => {
    const dir = await scratch("llmentary-empty-");
      const archive = await makeTarGz(dir, "empty.tar.gz", { "readme.txt": "no binary\n" });
    const dest = join(dir, "out", "llmentary");
    await mkdir(dirname(dest), { recursive: true });
    await expect(extractArchive(archive, dirname(dest), dest)).rejects.toThrow(/no llmentary binary/);
  });

  it("treats a missing extract directory as an empty snapshot before tar fails", async () => {
    const dir = await scratch("llmentary-missing-snap-");
    const archive = await makeTarGz(dir, "bundle.tar.gz", { llmentary: "#!/bin/sh\n" });
    const dest = join(dir, "missing", "llmentary");
    await expect(extractArchive(archive, join(dir, "missing"), dest)).rejects.toThrow(/tar .* exited with/);
  });

  it("rejects a corrupt archive", async () => {
    const dir = await scratch("llmentary-bad-tar-");
    const archive = join(dir, "broken.tar.gz");
    await writeFile(archive, "not a tar");
    const dest = join(dir, "llmentary");
    await expect(extractArchive(archive, dir, dest)).rejects.toThrow(/tar .* exited with/);
  });
});

describe("downloadBinary", () => {
  it("refuses a release with no matching asset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          tag_name: "v0.4.0",
          assets: [{ name: "llmentary_0.4.0_darwin_arm64.tar.gz", browser_download_url: "https://example.test/a" }],
        }),
      ),
    );
    const dir = await scratch("llmentary-no-asset-");
    await expect(downloadBinary({ cacheDir: dir, platform: "linux", arch: "x64" })).rejects.toThrow(
      /No llmentary release asset matched/,
    );
  });

  it("maps 401/403/404 to the private-repo hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })));
    const dir = await scratch("llmentary-404-");
    await expect(downloadBinary({ cacheDir: dir, repo: "barzoj-co/llmentary" })).rejects.toThrow(
      /repository is private/,
    );
  });

  it("surfaces other GitHub metadata failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 500, statusText: "Internal Server Error" })));
    const dir = await scratch("llmentary-500-");
    await expect(downloadBinary({ cacheDir: dir })).rejects.toThrow(/release metadata: 500/);
  });

  it("refuses an unverified archive when checksums.txt is missing", async () => {
    const dir = await scratch("llmentary-nocheck-");
    const archive = await makeTarGz(dir, "llmentary_0.4.0_linux_amd64.tar.gz", { llmentary: "#!/bin/sh\n" });
    const bytes = await readFile(archive);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = hrefOf(input);
        if (url.includes("api.github.com")) {
          return jsonResponse({
            tag_name: "v0.4.0",
            assets: [
              {
                name: "llmentary_0.4.0_linux_amd64.tar.gz",
                browser_download_url: "https://example.test/llmentary_0.4.0_linux_amd64.tar.gz",
              },
            ],
          });
        }
        return new Response(Buffer.from(bytes), { status: 200 });
      }),
    );
    await expect(downloadBinary({ cacheDir: dir, platform: "linux", arch: "x64" })).rejects.toThrow(
      /did not include checksums.txt/,
    );
  });

  it("rejects a checksums.txt that does not list the archive", async () => {
    const dir = await scratch("llmentary-unlist-");
    const archive = await makeTarGz(dir, "llmentary_0.4.0_linux_amd64.tar.gz", { llmentary: "#!/bin/sh\n" });
    const bytes = await readFile(archive);
    vi.stubGlobal("fetch", githubFetch({ archiveName: "llmentary_0.4.0_linux_amd64.tar.gz", bytes, checksums: "ffff  other.tar.gz\n" }));
    await expect(downloadBinary({ cacheDir: dir, platform: "linux", arch: "x64" })).rejects.toThrow(
      /checksums.txt did not list/,
    );
  });

  it("deletes the archive when the checksum does not match", async () => {
    const dir = await scratch("llmentary-mismatch-");
    const archive = await makeTarGz(dir, "llmentary_0.4.0_linux_amd64.tar.gz", { llmentary: "#!/bin/sh\n" });
    const bytes = await readFile(archive);
    vi.stubGlobal(
      "fetch",
      githubFetch({
        archiveName: "llmentary_0.4.0_linux_amd64.tar.gz",
        bytes,
        checksums: "0".repeat(64) + "  llmentary_0.4.0_linux_amd64.tar.gz\n",
      }),
    );
    await expect(downloadBinary({ cacheDir: dir, platform: "linux", arch: "x64" })).rejects.toThrow(
      /Checksum verification failed/,
    );
    await expect(fileExists(join(dir, "v0.4.0", "llmentary_0.4.0_linux_amd64.tar.gz"))).resolves.toBe(false);
  });

  it("downloads, verifies, and extracts a tagged release", async () => {
    const dir = await scratch("llmentary-ok-");
    const archive = await makeTarGz(dir, "llmentary_0.4.0_linux_amd64.tar.gz", { llmentary: "#!/bin/sh\necho downloaded\n" });
    const bytes = await readFile(archive);
    const checksums = `${sha256(bytes)}  llmentary_0.4.0_linux_amd64.tar.gz\n`;
    const fetchMock = githubFetch({
      archiveName: "llmentary_0.4.0_linux_amd64.tar.gz",
      bytes,
      checksums,
    });
    vi.stubGlobal("fetch", fetchMock);
    stash("GITHUB_TOKEN", undefined);
    stash("LLMENTARY_GITHUB_TOKEN", "tok-from-env");
    const binary = await downloadBinary({
      cacheDir: dir,
      platform: "linux",
      arch: "x64",
      version: "v0.4.0",
      repo: "barzoj-co/llmentary",
    });
    expect(binary).toBe(join(dir, "v0.4.0", "llmentary"));
    await expect(readFile(binary, "utf8")).resolves.toContain("echo downloaded");
    expect(hrefOf(fetchMock.mock.calls[0]?.[0])).toContain("/repos/barzoj-co/llmentary/releases/tags/v0.4.0");
    expect(authHeader(fetchMock.mock.calls[0])).toBe("Bearer tok-from-env");
  });

  it("sends an explicit githubToken and follows the latest release URL", async () => {
    const dir = await scratch("llmentary-latest-");
    const archive = await makeTarGz(dir, "llmentary_0.4.0_linux_amd64.tar.gz", { llmentary: "#!/bin/sh\n" });
    const bytes = await readFile(archive);
    const fetchMock = githubFetch({
      archiveName: "llmentary_0.4.0_linux_amd64.tar.gz",
      bytes,
      checksums: `${sha256(bytes)}  llmentary_0.4.0_linux_amd64.tar.gz\n`,
    });
    vi.stubGlobal("fetch", fetchMock);
    await downloadBinary({
      cacheDir: dir,
      platform: "linux",
      arch: "x64",
      githubToken: "explicit-token",
    });
    expect(hrefOf(fetchMock.mock.calls[0]?.[0])).toContain("/releases/latest");
    expect(authHeader(fetchMock.mock.calls[0])).toBe("Bearer explicit-token");
  });

  it("fails when the archive download has no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = hrefOf(input);
        if (url.includes("api.github.com")) {
          return jsonResponse({
            tag_name: "v0.4.0",
            assets: [
              {
                name: "llmentary_0.4.0_linux_amd64.tar.gz",
                browser_download_url: "https://example.test/llmentary_0.4.0_linux_amd64.tar.gz",
              },
              { name: "checksums.txt", browser_download_url: "https://example.test/checksums.txt" },
            ],
          });
        }
        return new Response(null, { status: 200 });
      }),
    );
    const dir = await scratch("llmentary-nobody-");
    await expect(downloadBinary({ cacheDir: dir, platform: "linux", arch: "x64" })).rejects.toThrow(
      /Could not download/,
    );
  });

  it("uses PowerShell on win32 zip extracts and reports the failure", async () => {
    const dir = await scratch("llmentary-winzip-");
    const archive = await makeZip(dir, "llmentary_0.4.0_windows_amd64.zip", { "llmentary.exe": "MZ" });
    const dest = join(dir, "out", "llmentary.exe");
    await mkdir(dirname(dest), { recursive: true });
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      await expect(extractArchive(archive, dirname(dest), dest)).rejects.toThrow(/powershell|exited with|ENOENT/i);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("fails when the archive download is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = hrefOf(input);
        if (url.includes("api.github.com")) {
          return jsonResponse({
            tag_name: "v0.4.0",
            assets: [
              {
                name: "llmentary_0.4.0_linux_amd64.tar.gz",
                browser_download_url: "https://example.test/llmentary_0.4.0_linux_amd64.tar.gz",
              },
              { name: "checksums.txt", browser_download_url: "https://example.test/checksums.txt" },
            ],
          });
        }
        return new Response("gone", { status: 410, statusText: "Gone" });
      }),
    );
    const dir = await scratch("llmentary-dlfail-");
    await expect(downloadBinary({ cacheDir: dir, platform: "linux", arch: "x64" })).rejects.toThrow(
      /Could not download/,
    );
  });
});

function hrefOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) {
    const url = Reflect.get(input, "url");
    if (typeof url === "string") return url;
  }
  return "";
}

function authHeader(call: unknown): string | undefined {
  if (!Array.isArray(call)) return undefined;
  const headers = (call[1] as RequestInit | undefined)?.headers;
  if (!headers || typeof headers !== "object" || headers instanceof Headers) {
    return headers instanceof Headers ? (headers.get("authorization") ?? undefined) : undefined;
  }
  return (headers as Record<string, string>).authorization;
}

function githubFetch(opts: { archiveName: string; bytes: Uint8Array; checksums: string }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = hrefOf(input);
    if (url.includes("api.github.com")) {
      return jsonResponse({
        tag_name: "v0.4.0",
        assets: [
          { name: opts.archiveName, browser_download_url: `https://example.test/${opts.archiveName}` },
          { name: "checksums.txt", browser_download_url: "https://example.test/checksums.txt" },
        ],
      });
    }
    if (url.endsWith("checksums.txt")) {
      return new Response(opts.checksums, { status: 200 });
    }
    if (url.endsWith(opts.archiveName)) {
      return new Response(Buffer.from(opts.bytes), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  });
}
