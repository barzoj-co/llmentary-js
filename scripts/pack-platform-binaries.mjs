#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Keep in sync with PROXY_VERSION. Download URLs use this literal, not file bytes. */
export const BUNDLED_PROXY_TAG = "v0.5.3";
export const PUBLIC_RELEASE_REPO = "barzoj-co/llmentary";
export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_DOWNLOAD_ORIGIN = "https://github.com";
export const MAX_RELEASE_ASSET_BYTES = 80 * 1024 * 1024;
const REPO = process.env.LLMENTARY_REPO ?? PUBLIC_RELEASE_REPO;

export const PACKAGES = [
  { dir: "linux-x64", os: "linux", cpu: "x64", bin: "llmentary" },
  { dir: "linux-arm64", os: "linux", cpu: "arm64", bin: "llmentary" },
  { dir: "darwin-x64", os: "darwin", cpu: "x64", bin: "llmentary" },
  { dir: "darwin-arm64", os: "darwin", cpu: "arm64", bin: "llmentary" },
  { dir: "win32-x64", os: "win32", cpu: "x64", bin: "llmentary.exe" },
];

export function versionFromTag(tag) {
  return tag.replace(/^v/, "");
}

export async function readProxyVersion(root = ROOT) {
  try {
    return (await readFile(join(root, "PROXY_VERSION"), "utf8")).trim();
  } catch {
    return "";
  }
}

export function resolveTag({ env = process.env, proxyVersion = "" } = {}) {
  return env.LLMENTARY_TAG || env.GITHUB_REF_NAME || proxyVersion || "";
}

/**
 * Tag that may enter a GitHub URL. Env overrides win. A PROXY_VERSION file pin
 * is accepted only when it equals BUNDLED_PROXY_TAG; the returned string is
 * always that literal (or a regex-validated env tag), never the file bytes.
 */
export function resolveDownloadTag({ env = process.env, filePin = "" } = {}) {
  const fromEnv = env.LLMENTARY_TAG || env.GITHUB_REF_NAME || "";
  if (fromEnv) {
    return assertPublicReleaseRef(PUBLIC_RELEASE_REPO, fromEnv).tag;
  }
  if (filePin && filePin !== BUNDLED_PROXY_TAG) {
    throw new Error(`PROXY_VERSION ${filePin} does not match bundled pin ${BUNDLED_PROXY_TAG}`);
  }
  return BUNDLED_PROXY_TAG;
}

/**
 * Option B: when keepRootVersion is true (LLMENTARY_ROOT_VERSION set), leave
 * the root package version alone and pin optionalDependencies + platform
 * packages to the proxy tag. When false, keep the old lockstep behaviour.
 */
export function applyVersions(rootPkg, tag, { keepRootVersion = false } = {}) {
  const version = versionFromTag(tag);
  const next = structuredClone(rootPkg);
  if (!keepRootVersion) {
    next.version = version;
  }
  for (const name of Object.keys(next.optionalDependencies ?? {})) {
    next.optionalDependencies[name] = version;
  }
  return { version, rootPkg: next };
}

export async function writePackageVersions(root, tag, { keepRootVersion = false } = {}) {
  const rootPkgPath = join(root, "package.json");
  const rootPkg = JSON.parse(await readFile(rootPkgPath, "utf8"));
  const { version, rootPkg: nextRoot } = applyVersions(rootPkg, tag, { keepRootVersion });
  await writeFile(rootPkgPath, `${JSON.stringify(nextRoot, null, 2)}\n`);
  for (const spec of PACKAGES) {
    await setPackageVersion(root, spec.dir, version);
  }
  return { version, rootPkg: nextRoot };
}

export function githubToken(env = process.env) {
  return env.GH_TOKEN || env.GITHUB_TOKEN || "";
}

export function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "llmentary-js-pack-platform-binaries",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

const REPO_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;
const TAG_RE = /^(v?[A-Za-z0-9._-]+)$/;
const ASSET_RE = /^([A-Za-z0-9._+-]+)$/;

export function assertPublicReleaseRef(repo, tag) {
  const repoMatch = REPO_RE.exec(String(repo ?? ""));
  const tagMatch = TAG_RE.exec(String(tag ?? ""));
  if (!repoMatch) throw new Error(`invalid repo ${repo}`);
  if (!tagMatch) throw new Error(tag ? `invalid tag ${tag}` : "tag is required");
  return { repo: repoMatch[1], tag: tagMatch[1] };
}

export function releaseAssetName(name) {
  const raw = String(name ?? "");
  if (isAbsolute(raw) || raw.includes("/") || raw.includes("\\")) {
    throw new Error(`invalid release asset name ${name}`);
  }
  const match = ASSET_RE.exec(raw);
  if (!match || basename(raw) !== raw) {
    throw new Error(`invalid release asset name ${name}`);
  }
  return match[1];
}

export function destFile(dest, name) {
  const safe = releaseAssetName(name);
  if (safe === "." || safe === ".." || isAbsolute(safe)) {
    throw new Error(`refusing to write outside dest: ${name}`);
  }
  const root = resolve(dest);
  const out = resolve(root, safe);
  if (dirname(out) !== root || out !== join(root, safe)) {
    throw new Error(`refusing to write outside dest: ${name}`);
  }
  return out;
}

function lockedGithubUrl(origin, pathname) {
  const url = new URL(pathname, origin);
  if (url.origin !== origin || url.username || url.password) {
    throw new Error(`refusing non-GitHub origin ${url.origin}`);
  }
  return url.href;
}

export function publicReleaseApiUrl(repo, tag) {
  const ref = assertPublicReleaseRef(repo, tag);
  return lockedGithubUrl(
    GITHUB_API_ORIGIN,
    `/repos/${ref.repo}/releases/tags/${encodeURIComponent(ref.tag)}`,
  );
}

export function publicReleaseAssetUrl(repo, tag, name) {
  const ref = assertPublicReleaseRef(repo, tag);
  return lockedGithubUrl(
    GITHUB_DOWNLOAD_ORIGIN,
    `/${ref.repo}/releases/download/${ref.tag}/${releaseAssetName(name)}`,
  );
}

const SHA256_RE = /^[a-f0-9]{64}$/;

export function githubAssetSize(asset, name = asset?.name) {
  const size = Number(asset?.size);
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`trusted size required for ${name ?? "asset"}`);
  }
  if (size > MAX_RELEASE_ASSET_BYTES) {
    throw new Error(`release asset ${name} exceeds ${MAX_RELEASE_ASSET_BYTES} bytes`);
  }
  return size;
}

export function githubAssetDigest(asset) {
  const raw = String(asset?.digest ?? "").trim();
  const match = /^(?:sha256:)?([a-fA-F0-9]{64})$/.exec(raw);
  return match ? match[1].toLowerCase() : "";
}

export function parseChecksumManifest(checksums) {
  const map = new Map();
  for (const line of String(checksums ?? "").split(/\r?\n/)) {
    const match = /^(?:sha256:)?([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (!match) continue;
    try {
      map.set(releaseAssetName(match[2]), match[1].toLowerCase());
    } catch {
      // skip traversal / absolute names in the manifest
    }
  }
  return map;
}

export function parseChecksum(checksums, fileName) {
  try {
    return parseChecksumManifest(checksums).get(releaseAssetName(basename(fileName)));
  } catch {
    return undefined;
  }
}

export function trustedManifest(name, asset, checksums = new Map()) {
  const size = githubAssetSize(asset, name);
  const fromApi = githubAssetDigest(asset);
  const fromManifest = checksums.get(name) ?? "";
  if (fromApi && fromManifest && fromApi !== fromManifest) {
    throw new Error(`digest disagreement for ${name}`);
  }
  const sha256 = fromManifest || fromApi;
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`trusted sha256 required for ${name}`);
  }
  return { sha256, size };
}

export function assertVerifiedAsset(name, bytes, expected) {
  const sha256 = String(expected?.sha256 ?? "").toLowerCase();
  const size = Number(expected?.size);
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`trusted sha256 required for ${name}`);
  }
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`trusted size required for ${name}`);
  }
  if (size > MAX_RELEASE_ASSET_BYTES) {
    throw new Error(`release asset ${name} exceeds ${MAX_RELEASE_ASSET_BYTES} bytes`);
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.byteLength !== size) {
    const kind = buf.byteLength < size ? "truncated download" : "size mismatch";
    throw new Error(`${kind} for ${name}: expected ${size}, got ${buf.byteLength}`);
  }
  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual !== sha256) {
    throw new Error(`sha256 mismatch for ${name}: expected ${sha256}, got ${actual}`);
  }
  return buf;
}

export async function writeReleaseAsset(dest, name, bytes, expected) {
  const verified = assertVerifiedAsset(name, bytes, expected);
  const finalPath = destFile(dest, name);
  const partPath = destFile(dest, `.${releaseAssetName(name)}.part`);
  try {
    await writeFile(partPath, verified);
    await rename(partPath, finalPath);
  } catch (err) {
    await rm(partPath, { force: true });
    throw err;
  }
  return finalPath;
}

async function fetchReleaseBytes(fetchImpl, url, name) {
  const fileRes = await fetchImpl(url, {
    headers: {
      "user-agent": "llmentary-js-pack-platform-binaries",
    },
    redirect: "follow",
  });
  if (!fileRes.ok) {
    throw new Error(`Could not download ${name}: ${fileRes.status}`);
  }
  const buf = Buffer.from(await fileRes.arrayBuffer());
  if (buf.byteLength > MAX_RELEASE_ASSET_BYTES) {
    throw new Error(`release asset ${name} exceeds ${MAX_RELEASE_ASSET_BYTES} bytes`);
  }
  return buf;
}

function listedReleaseAssets(assets) {
  const listed = [];
  for (const asset of assets) {
    if (!asset?.name) continue;
    try {
      listed.push({ asset, name: releaseAssetName(asset.name) });
    } catch {
      // skip path traversal / absolute names
    }
  }
  return listed;
}

export async function downloadPublicRelease({
  repo = REPO,
  tag,
  dest,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const ref = assertPublicReleaseRef(repo, tag);
  const token = githubToken(env);
  const api = publicReleaseApiUrl(ref.repo, ref.tag);
  const metaRes = await fetchImpl(api, { headers: githubHeaders(token) });
  if (!metaRes.ok) {
    throw new Error(`Could not read public release ${tag} for ${repo}: ${metaRes.status}`);
  }
  const meta = await metaRes.json();
  if (!Array.isArray(meta.assets) || meta.assets.length === 0) {
    throw new Error(`release ${tag} listed no assets`);
  }
  const listed = listedReleaseAssets(meta.assets);
  const checksum = listed.find(({ name }) => /^checksums?\.txt$/i.test(name));
  if (!checksum) {
    throw new Error("GoReleaser checksums.txt was not in the release assets.");
  }
  await mkdir(dest, { recursive: true });
  const checksumUrl = publicReleaseAssetUrl(ref.repo, ref.tag, checksum.name);
  const checksumBytes = await fetchReleaseBytes(fetchImpl, checksumUrl, checksum.name);
  const checksumSize = githubAssetSize(checksum.asset, checksum.name);
  const parsedChecksums = parseChecksumManifest(checksumBytes.toString("utf8"));
  const checksumExpected = trustedManifest(checksum.name, checksum.asset, parsedChecksums);
  if (checksumBytes.byteLength !== checksumSize) {
    const kind = checksumBytes.byteLength < checksumSize ? "truncated download" : "size mismatch";
    throw new Error(`${kind} for ${checksum.name}: expected ${checksumSize}, got ${checksumBytes.byteLength}`);
  }
  // Size/digest come from the GitHub API listing (and a self-hash if the
  // manifest lists itself). The body is checked before any persist, then used
  // as the sha256 map for the remaining assets.
  const verifiedChecksums = assertVerifiedAsset(checksum.name, checksumBytes, checksumExpected);
  const checksums = parseChecksumManifest(verifiedChecksums.toString("utf8"));
  await writeReleaseAsset(dest, checksum.name, verifiedChecksums, checksumExpected);

  for (const { asset, name } of listed) {
    if (name === checksum.name) continue;
    const expected = trustedManifest(name, asset, checksums);
    const url = publicReleaseAssetUrl(ref.repo, ref.tag, name);
    const bytes = await fetchReleaseBytes(fetchImpl, url, name);
    await writeReleaseAsset(dest, name, bytes, expected);
  }
}

export function assetPatterns(os, cpu) {
  // Match goreleaser archives llmentary_<ver>_<os>_<arch> from barzoj-co/llmentary.
  const goreleaserOs = os === "darwin" ? "darwin" : os === "win32" ? "windows" : "linux";
  const machine = cpu === "x64" ? "(amd64|x86_64|x64)" : "(arm64|aarch64)";
  const ext = os === "win32" ? "\\.zip" : "\\.tar\\.gz";
  return [
    new RegExp(`^llmentary_[^/]+_${goreleaserOs}_${machine}${ext}$`, "i"),
    new RegExp(`^llmentary_${goreleaserOs}_${machine}${ext}$`, "i"),
  ];
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function extract(archivePath, dest) {
  await mkdir(dest, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    await run("unzip", ["-q", archivePath, "-d", dest]);
  } else {
    await run("tar", ["-xzf", archivePath, "-C", dest]);
  }
}

async function findOpenApi(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const match = entries.find(
    (entry) => entry.isFile() && /(?:^|[/\\])openapi\.ya?ml$/i.test(join(entry.parentPath ?? entry.path, entry.name)),
  );
  return match ? join(match.parentPath ?? match.path, match.name) : undefined;
}

async function findBinary(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const match = entries.find(
    (entry) =>
      entry.isFile() &&
      /(?:^|[/\\])llmentary(?:\.exe)?$/i.test(join(entry.parentPath ?? entry.path, entry.name)),
  );
  if (!match) throw new Error(`No llmentary binary in ${dir}`);
  return join(match.parentPath ?? match.path, match.name);
}

async function setPackageVersion(root, dir, version) {
  const path = join(root, "packages", dir, "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8"));
  pkg.version = version;
  pkg.files = ["bin", "openapi.yaml", "README.md", "LICENSE", "LICENSE.AGPL-3.0"];
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function main() {
  const filePin = await readProxyVersion(ROOT);
  const tag = resolveDownloadTag({ env: process.env, filePin });
  if (!tag) {
    throw new Error("LLMENTARY_TAG, GITHUB_REF_NAME, or PROXY_VERSION is required (for example v0.5.3).");
  }
  const keepRootVersion = Boolean(process.env.LLMENTARY_ROOT_VERSION);
  const work = await mkdtemp(join(tmpdir(), "llmentary-rel-"));
  try {
    await downloadPublicRelease({ repo: REPO, tag, dest: work });
    const files = await readdir(work);
    const checksumFile = files.find((name) => /checksums?\.txt$/i.test(name));
    if (!checksumFile) throw new Error("GoReleaser checksums.txt was not in the release assets.");
    const checksums = await readFile(join(work, checksumFile), "utf8");

    await writePackageVersions(ROOT, tag, { keepRootVersion });

    for (const spec of PACKAGES) {
      const patterns = assetPatterns(spec.os, spec.cpu);
      const asset = files.find((name) => patterns.some((pattern) => pattern.test(name)));
      if (!asset) throw new Error(`No GoReleaser asset for ${spec.dir}`);
      const archivePath = join(work, asset);
      const expected = parseChecksum(checksums, asset);
      if (!expected) throw new Error(`checksums.txt does not list ${asset}`);
      const actual = createHash("sha256").update(await readFile(archivePath)).digest("hex");
      if (actual !== expected) {
        throw new Error(`sha256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
      }
      const extractDir = join(work, spec.dir);
      await extract(archivePath, extractDir);
      const binary = await findBinary(extractDir);
      const destDir = join(ROOT, "packages", spec.dir, "bin");
      await mkdir(destDir, { recursive: true });
      await rename(binary, join(destDir, spec.bin));
      const contract = await findOpenApi(extractDir);
      if (!contract) {
        throw new Error(`No openapi.yaml or openapi.yml in ${asset}`);
      }
      await writeFile(join(ROOT, "packages", spec.dir, "openapi.yaml"), await readFile(contract));
      await writeFile(join(ROOT, "openapi.yaml"), await readFile(contract));
      await writeFile(join(ROOT, "packages", spec.dir, "LICENSE"), await readFile(join(ROOT, "LICENSE")));
      await writeFile(
        join(ROOT, "packages", spec.dir, "LICENSE.AGPL-3.0"),
        await readFile(join(ROOT, "licenses", "AGPL-3.0.txt")),
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
