import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { BinaryDownloadOptions, BinaryResolutionOptions } from "./types.js";

const DEFAULT_REPO = "barzoj-co/llm-test-lab";
const DEFAULT_BINARY_NAME = "llmtestlab";

export interface NativePackageSpec {
  name: string;
  os: NodeJS.Platform;
  cpu: NodeJS.Architecture;
}

export const NATIVE_PACKAGES: NativePackageSpec[] = [
  { name: "@llm-test-lab/linux-x64", os: "linux", cpu: "x64" },
  { name: "@llm-test-lab/linux-arm64", os: "linux", cpu: "arm64" },
  { name: "@llm-test-lab/darwin-x64", os: "darwin", cpu: "x64" },
  { name: "@llm-test-lab/darwin-arm64", os: "darwin", cpu: "arm64" },
  { name: "@llm-test-lab/win32-x64", os: "win32", cpu: "x64" },
];

export async function resolveBinary(options: BinaryResolutionOptions = {}): Promise<string> {
  const envBin = process.env.LLMTESTLAB_BIN;
  if (envBin) {
    await assertExecutable(envBin, "LLMTESTLAB_BIN");
    return envBin;
  }

  const native = await findNativePackageBinary(options.platform ?? process.platform, options.arch ?? process.arch);
  if (native) return native;

  const binaryName = options.binaryName ?? DEFAULT_BINARY_NAME;
  const pathMatch = await findOnPath(binaryName);
  if (pathMatch) return pathMatch;
  const alternatePathMatch = await findOnPath("llm-test-lab");
  if (alternatePathMatch) return alternatePathMatch;

  const cached = await findCachedBinary(options);
  if (cached) return cached;

  throw new Error(
    "Could not find the llm-test-lab proxy binary. Set LLMTESTLAB_BIN, install the optional platform package (@llm-test-lab/<os>-<cpu>), or put llmtestlab on PATH. This client never downloads binaries at install or runtime.",
  );
}

export function nativePackageName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | undefined {
  return NATIVE_PACKAGES.find((pkg) => pkg.os === platform && pkg.cpu === arch)?.name;
}

export async function downloadBinary(options: BinaryDownloadOptions = {}): Promise<string> {
  const repo = options.repo ?? DEFAULT_REPO;
  const token = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.LLMTESTLAB_GITHUB_TOKEN;
  const release = await getRelease(repo, options.version, token);
  const asset = chooseAsset(release.assets, options.platform ?? process.platform, options.arch ?? process.arch);
  if (!asset) {
    throw new Error(
      `No llm-test-lab release asset matched ${options.platform ?? process.platform}/${options.arch ?? process.arch}. Set LLMTESTLAB_BIN to a local binary.`,
    );
  }

  const cacheDir = cacheRoot(options);
  const versionDir = join(cacheDir, release.tag_name);
  await mkdir(versionDir, { recursive: true });

  const archivePath = join(versionDir, asset.name);
  await downloadAsset(asset.browser_download_url, archivePath, token);
  const checksums = await downloadChecksumsIfPresent(release.assets, versionDir, token);
  if (!checksums) {
    throw new Error(`Release ${release.tag_name} did not include checksums.txt; refusing to use an unverified archive.`);
  }
  await verifyChecksum(archivePath, checksums);

  const binaryPath = join(versionDir, targetBinaryName(options.platform ?? process.platform));
  await extractArchive(archivePath, versionDir, binaryPath);
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

export function assetNameCandidates(platform: NodeJS.Platform, arch: NodeJS.Architecture): RegExp[] {
  const os = platform === "darwin" ? "Darwin" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  const machine =
    arch === "x64" ? "(x86_64|amd64|x64)" : arch === "arm64" ? "(arm64|aarch64)" : arch === "ia32" ? "(i386|386)" : arch;
  const ext = platform === "win32" ? "\\.zip" : "\\.tar\\.gz";
  return [
    new RegExp(`llmtestlab[_-]${os}[_-]${machine}${ext}$`, "i"),
    new RegExp(`llm-test-lab[_-]${os}[_-]${machine}${ext}$`, "i"),
    new RegExp(`${os}[_-]${machine}${ext}$`, "i"),
  ];
}

export function parseChecksumFile(checksums: string, fileName: string): string | undefined {
  const name = basename(fileName);
  const line = checksums
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.endsWith(`  ${name}`) || candidate.endsWith(` *${name}`) || candidate.split(/\s+/).includes(name));
  if (!line) return undefined;
  return line.split(/\s+/)[0];
}

async function findNativePackageBinary(platform: NodeJS.Platform, arch: NodeJS.Architecture): Promise<string | undefined> {
  const pkg = nativePackageName(platform, arch);
  if (!pkg) return undefined;
  const binName = targetBinaryName(platform);
  const roots = new Set<string>([process.cwd()]);
  if (process.argv[1]) roots.add(dirname(process.argv[1]));
  for (const root of roots) {
    let dir = root;
    for (let i = 0; i < 12; i += 1) {
      const candidate = join(dir, "node_modules", pkg, "bin", binName);
      try {
        await access(candidate);
        return candidate;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  return undefined;
}

async function assertExecutable(path: string, source: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${source} points to ${path}, but it is not readable.`);
  }
}

async function findOnPath(binaryName: string): Promise<string | undefined> {
  const paths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const names = process.platform === "win32" ? [binaryName, `${binaryName}.exe`] : [binaryName];
  for (const directory of paths) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

async function findCachedBinary(options: BinaryDownloadOptions): Promise<string | undefined> {
  const cacheDir = cacheRoot(options);
  const binaryName = targetBinaryName(options.platform ?? process.platform);
  try {
    if (options.version) {
      const candidate = join(cacheDir, options.version, binaryName);
      await access(candidate);
      return candidate;
    }
    const entries = await readdir(cacheDir, { withFileTypes: true });
    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareReleaseTags)
      .reverse();
    for (const version of versions) {
      const candidate = join(cacheDir, version, binaryName);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue scanning cache versions.
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function cacheRoot(options: BinaryDownloadOptions): string {
  return options.cacheDir ?? process.env.LLMTESTLAB_CACHE_DIR ?? join(homedir(), ".cache", "llm-test-lab");
}

function targetBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? `${DEFAULT_BINARY_NAME}.exe` : DEFAULT_BINARY_NAME;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

async function getRelease(repo: string, version: string | undefined, token: string | undefined): Promise<GitHubRelease> {
  const releasePath = version ? `releases/tags/${encodeURIComponent(version)}` : "releases/latest";
  const url = `https://api.github.com/repos/${repo}/${releasePath}`;
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new Error(
      `Could not download llm-test-lab from GitHub Releases (${response.status}). The ${repo} repository is private; set LLMTESTLAB_BIN to a locally built binary or provide LLMTESTLAB_GITHUB_TOKEN/GITHUB_TOKEN with release access.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Could not read llm-test-lab release metadata: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as GitHubRelease;
}

function chooseAsset(
  assets: GitHubAsset[],
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): GitHubAsset | undefined {
  const candidates = assetNameCandidates(platform, arch);
  return assets.find((asset) => candidates.some((candidate) => candidate.test(asset.name)));
}

function githubHeaders(token: string | undefined): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "llm-test-lab-js",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function downloadAsset(url: string, destination: string, token: string | undefined): Promise<void> {
  const response = await fetch(url, { headers: githubHeaders(token), redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${basename(destination)}: ${response.status} ${response.statusText}`);
  }
  const tmp = `${destination}.tmp`;
  await pipeline(response.body, createWriteStream(tmp));
  await rename(tmp, destination);
}

async function downloadChecksumsIfPresent(
  assets: GitHubAsset[],
  versionDir: string,
  token: string | undefined,
): Promise<string | undefined> {
  const asset = assets.find((candidate) => /checksums?\.txt$/i.test(candidate.name));
  if (!asset) return undefined;
  const destination = join(versionDir, asset.name);
  await downloadAsset(asset.browser_download_url, destination, token);
  return readFile(destination, "utf8");
}

async function verifyChecksum(path: string, checksums: string): Promise<void> {
  const expected = parseChecksumFile(checksums, path);
  if (!expected) {
    throw new Error(`checksums.txt did not list ${basename(path)}`);
  }
  const data = await readFile(path);
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) {
    await rm(path, { force: true });
    throw new Error(`Checksum verification failed for ${basename(path)}: expected ${expected}, got ${actual}`);
  }
}

export async function extractArchive(archivePath: string, versionDir: string, binaryPath: string): Promise<void> {
  const before = await snapshotFiles(versionDir);
  if (archivePath.endsWith(".zip")) {
    await extractZip(archivePath, versionDir);
  } else {
    await run("tar", ["-xzf", archivePath, "-C", versionDir]);
  }
  const after = await snapshotFiles(versionDir);
  const extracted = [...after].filter((path) => !before.has(path));
  const executable = extracted.find((path) => /(?:^|[/\\])llm(?:-?test-?lab|testlab)(?:\.exe)?$/i.test(path));
  if (!executable) {
    throw new Error(`Downloaded ${archivePath}, but no llmtestlab binary was found in the archive.`);
  }
  if (executable !== binaryPath) await rename(executable, binaryPath);
}

async function snapshotFiles(directory: string): Promise<Set<string>> {
  const out = new Set<string>();
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.add(path);
    }
  }
  try {
    await walk(directory);
  } catch {
    // Missing directories behave like empty snapshots.
  }
  return out;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function extractZip(archivePath: string, versionDir: string): Promise<void> {
  if (process.platform === "win32") {
    const command = [
      "Expand-Archive",
      "-LiteralPath",
      quotePowerShellLiteral(archivePath),
      "-DestinationPath",
      quotePowerShellLiteral(versionDir),
      "-Force",
    ].join(" ");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    return;
  }
  await run("unzip", ["-q", archivePath, "-d", versionDir]);
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function compareReleaseTags(a: string, b: string): number {
  const left = parseReleaseTag(a);
  const right = parseReleaseTag(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function parseReleaseTag(tag: string): number[] {
  const match = tag.match(/\d+(?:\.\d+)*/);
  return match ? match[0].split(".").map((part) => Number(part)) : [0];
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
