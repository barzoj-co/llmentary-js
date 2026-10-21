#!/usr/bin/env node
/**
 * Fail if vendored testdata/isolation drifts from the proxy copy.
 *
 * Lookup order for the proxy copy:
 * 1. LLMENTARY_ISOLATION_VECTORS_DIR (must exist when set)
 * 2. .proxy-testdata/isolation
 * 3. GitHub testdata/isolation on LLMENTARY_ISOLATION_VECTORS_REF
 *    (default main) when a GitHub token is set
 *
 * A 404/403 from GitHub is a visible SKIP (stderr), never a silent pass
 * and never reported as a match. Other fetch errors fail the check.
 * No token and no local checkout: visible SKIP.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = join(ROOT, "testdata", "isolation");
const DEFAULT_PROXY_DIR = join(ROOT, ".proxy-testdata", "isolation");
const PROXY_REPO = process.env.LLMENTARY_REPO || "barzoj-co/llmentary";
const PROXY_REF = process.env.LLMENTARY_ISOLATION_VECTORS_REF || "main";
const PROXY_PATH = "testdata/isolation";
const ENV_DIR = process.env.LLMENTARY_ISOLATION_VECTORS_DIR;

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function jsonFiles(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const files = {};
  for (const name of names) {
    files[name] = { digest: digest(await readFile(join(dir, name), "utf8")), path: join(dir, name) };
  }
  return files;
}

function skip(reason, localCount) {
  console.error(
    `isolation vectors: SKIP proxy compare (${reason}; using ${localCount} local vectors against ${PROXY_REPO}@${PROXY_REF}:${PROXY_PATH})`,
  );
  process.exit(0);
}

async function fetchProxyVectors() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.LLMTESTLAB_REPO_TOKEN;
  if (!token) return { skip: "no GH_TOKEN/GITHUB_TOKEN" };
  const listUrl = `https://api.github.com/repos/${PROXY_REPO}/contents/${PROXY_PATH}?ref=${encodeURIComponent(PROXY_REF)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "llmentary-js-isolation-vectors",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const listRes = await fetch(listUrl, { headers });
  if (listRes.status === 404 || listRes.status === 403) {
    return { skip: `HTTP ${listRes.status} from ${listUrl}` };
  }
  if (!listRes.ok) {
    const body = await listRes.text();
    throw new Error(`GET ${listUrl} failed: ${listRes.status} ${body.slice(0, 400)}`);
  }
  const entries = await listRes.json();
  if (!Array.isArray(entries)) {
    throw new Error(`unexpected contents payload for ${PROXY_PATH}`);
  }
  const dest = DEFAULT_PROXY_DIR;
  await mkdir(dest, { recursive: true });
  const files = {};
  for (const entry of entries) {
    if (entry.type !== "file" || typeof entry.name !== "string") continue;
    if (!entry.name.endsWith(".json") && entry.name !== "README.md") continue;
    const fileRes = await fetch(entry.download_url || entry.url, {
      headers: entry.download_url
        ? { "User-Agent": headers["User-Agent"], Authorization: headers.Authorization }
        : headers,
    });
    if (fileRes.status === 404 || fileRes.status === 403) {
      return { skip: `HTTP ${fileRes.status} fetching ${entry.name}` };
    }
    if (!fileRes.ok) {
      throw new Error(`GET ${entry.name} failed: ${fileRes.status}`);
    }
    const text =
      entry.download_url || !entry.content
        ? await fileRes.text()
        : Buffer.from(entry.content.replace(/\n/g, ""), "base64").toString("utf8");
    await writeFile(join(dest, entry.name), text);
    if (entry.name.endsWith(".json")) {
      files[entry.name] = { digest: digest(text), path: join(dest, entry.name), text };
    }
  }
  return { files };
}

function printOfficial(name, text) {
  console.error(`----- BEGIN official/${name} -----`);
  console.error(text);
  console.error(`----- END official/${name} -----`);
}

const local = await jsonFiles(LOCAL);
if (Object.keys(local).length === 0) {
  console.error("testdata/isolation has no JSON vectors");
  process.exit(1);
}

let remote;
let remoteLabel;

if (ENV_DIR) {
  if (!(await exists(ENV_DIR))) {
    console.error(`LLMENTARY_ISOLATION_VECTORS_DIR does not exist: ${ENV_DIR}`);
    process.exit(1);
  }
  remote = await jsonFiles(ENV_DIR);
  remoteLabel = ENV_DIR;
} else {
  try {
    const fetched = await fetchProxyVectors();
    if (fetched.skip) {
      // 404/403 must never fall through to a stale cache and look like a match.
      if (/^HTTP 40[34]\b/.test(fetched.skip) || !(await exists(DEFAULT_PROXY_DIR))) {
        skip(fetched.skip, Object.keys(local).length);
      }
      remote = await jsonFiles(DEFAULT_PROXY_DIR);
      remoteLabel = DEFAULT_PROXY_DIR;
    } else {
      remote = fetched.files;
      remoteLabel = `${PROXY_REPO}@${PROXY_REF}:${PROXY_PATH}`;
    }
  } catch (error) {
    console.error(`isolation vectors: failed to fetch proxy copy (${error instanceof Error ? error.message : error})`);
    process.exit(1);
  }
}

if (!remote) {
  skip("no proxy copy available", Object.keys(local).length);
}

const names = new Set([...Object.keys(local), ...Object.keys(remote)]);
const drift = [];
for (const name of names) {
  if (local[name]?.digest !== remote[name]?.digest) {
    drift.push(`${name}: local=${local[name]?.digest ?? "<missing>"} proxy=${remote[name]?.digest ?? "<missing>"}`);
    if (remote[name]?.path) {
      printOfficial(name, await readFile(remote[name].path, "utf8"));
    } else if (remote[name]?.text) {
      printOfficial(name, remote[name].text);
    }
  }
}
if (drift.length > 0) {
  console.error(`isolation vectors drifted from proxy copy at ${remoteLabel}:`);
  for (const line of drift) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`isolation vectors match proxy copy at ${remoteLabel} (${Object.keys(local).length} files)`);
