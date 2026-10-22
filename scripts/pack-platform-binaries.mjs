#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.LLMENTARY_REPO ?? "barzoj-co/llmentary";

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
  const match = ASSET_RE.exec(raw);
  if (!match || basename(raw) !== raw) {
    throw new Error(`invalid release asset name ${name}`);
  }
  return match[1];
}

export function destFile(dest, name) {
  const safe = releaseAssetName(name);
  const root = resolve(dest);
  const out = resolve(root, safe);
  if (out !== join(root, safe)) {
    throw new Error(`refusing to write outside dest: ${name}`);
  }
  return out;
}

export function publicReleaseAssetUrl(repo, tag, name) {
  const ref = assertPublicReleaseRef(repo, tag);
  return `https://github.com/${ref.repo}/releases/download/${ref.tag}/${releaseAssetName(name)}`;
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
  const api = `https://api.github.com/repos/${ref.repo}/releases/tags/${encodeURIComponent(ref.tag)}`;
  const metaRes = await fetchImpl(api, { headers: githubHeaders(token) });
  if (!metaRes.ok) {
    throw new Error(`Could not read public release ${tag} for ${repo}: ${metaRes.status}`);
  }
  const meta = await metaRes.json();
  if (!Array.isArray(meta.assets) || meta.assets.length === 0) {
    throw new Error(`release ${tag} listed no assets`);
  }
  await mkdir(dest, { recursive: true });
  for (const asset of meta.assets) {
    if (!asset?.name) continue;
    let name;
    try {
      name = releaseAssetName(asset.name);
    } catch {
      continue;
    }
    const url = publicReleaseAssetUrl(ref.repo, ref.tag, name);
    const fileRes = await fetchImpl(url, {
      headers: {
        "user-agent": "llmentary-js-pack-platform-binaries",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: "follow",
    });
    if (!fileRes.ok) {
      throw new Error(`Could not download ${name}: ${fileRes.status}`);
    }
    await writeFile(destFile(dest, name), Buffer.from(await fileRes.arrayBuffer()));
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

function parseChecksum(checksums, fileName) {
  const name = basename(fileName);
  const line = checksums
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.endsWith(`  ${name}`) || candidate.endsWith(` *${name}`) || candidate.split(/\s+/).includes(name),
    );
  return line?.split(/\s+/)[0];
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
  const proxyVersion = await readProxyVersion(ROOT);
  const tag = resolveTag({ env: process.env, proxyVersion });
  if (!tag) {
    throw new Error("LLMENTARY_TAG, GITHUB_REF_NAME, or PROXY_VERSION is required (for example v0.4.1).");
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
