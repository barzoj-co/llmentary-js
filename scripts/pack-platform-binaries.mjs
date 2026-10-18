#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.LLMTESTLAB_REPO ?? "barzoj-co/llm-test-lab";
const TAG = process.env.LLMTESTLAB_TAG ?? process.env.GITHUB_REF_NAME ?? "";

const PACKAGES = [
  { dir: "linux-x64", os: "linux", cpu: "x64", bin: "llmtestlab" },
  { dir: "linux-arm64", os: "linux", cpu: "arm64", bin: "llmtestlab" },
  { dir: "darwin-x64", os: "darwin", cpu: "x64", bin: "llmtestlab" },
  { dir: "darwin-arm64", os: "darwin", cpu: "arm64", bin: "llmtestlab" },
  { dir: "win32-x64", os: "win32", cpu: "x64", bin: "llmtestlab.exe" },
];

function versionFromTag(tag) {
  return tag.replace(/^v/, "");
}

function assetPatterns(os, cpu) {
  const goreleaserOs = os === "darwin" ? "Darwin" : os === "win32" ? "Windows" : "Linux";
  const machine = cpu === "x64" ? "(x86_64|amd64|x64)" : "(arm64|aarch64)";
  const ext = os === "win32" ? "\\.zip" : "\\.tar\\.gz";
  return [
    new RegExp(`llmtestlab[_-]${goreleaserOs}[_-]${machine}${ext}$`, "i"),
    new RegExp(`llm-test-lab[_-]${goreleaserOs}[_-]${machine}${ext}$`, "i"),
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

async function findBinary(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const match = entries.find(
    (entry) => entry.isFile() && /(?:^|[/\\])llm(?:-?test-?lab|testlab)(?:\.exe)?$/i.test(join(entry.parentPath ?? entry.path, entry.name)),
  );
  if (!match) throw new Error(`No llmtestlab binary in ${dir}`);
  return join(match.parentPath ?? match.path, match.name);
}

async function setPackageVersion(dir, version) {
  const path = join(ROOT, "packages", dir, "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8"));
  pkg.version = version;
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function main() {
  if (!TAG) {
    throw new Error("LLMTESTLAB_TAG or GITHUB_REF_NAME is required (for example v0.1.0).");
  }
  const version = versionFromTag(TAG);
  const work = await mkdtemp(join(tmpdir(), "llm-test-lab-rel-"));
  try {
    await run("gh", ["release", "download", TAG, "--repo", REPO, "--dir", work]);
    const files = await readdir(work);
    const checksumFile = files.find((name) => /checksums?\.txt$/i.test(name));
    if (!checksumFile) throw new Error("GoReleaser checksums.txt was not in the release assets.");
    const checksums = await readFile(join(work, checksumFile), "utf8");

    const rootPkgPath = join(ROOT, "package.json");
    const rootPkg = JSON.parse(await readFile(rootPkgPath, "utf8"));
    rootPkg.version = version;
    for (const name of Object.keys(rootPkg.optionalDependencies ?? {})) {
      rootPkg.optionalDependencies[name] = version;
    }
    await writeFile(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);

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
      await setPackageVersion(spec.dir, version);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
