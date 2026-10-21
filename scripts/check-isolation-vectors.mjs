#!/usr/bin/env node
/**
 * Fail if vendored testdata/isolation drifts from the proxy copy at PROXY_VERSION.
 * Until the proxy docs PR publishes those files, this check documents the gap
 * and exits 0 when the proxy copy is not available.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = join(ROOT, "testdata", "isolation");
const PROXY_DIR =
  process.env.LLMENTARY_ISOLATION_VECTORS_DIR ||
  join(ROOT, ".proxy-testdata", "isolation");

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function jsonFiles(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const files = {};
  for (const name of names) {
    files[name] = digest(await readFile(join(dir, name), "utf8"));
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const local = await jsonFiles(LOCAL);
if (Object.keys(local).length === 0) {
  console.error("testdata/isolation has no JSON vectors");
  process.exit(1);
}

if (!(await exists(PROXY_DIR))) {
  console.log(
    `isolation vectors: proxy copy not published yet (looked in ${PROXY_DIR}). Using ${Object.keys(local).length} local DOG-29 vectors.`,
  );
  process.exit(0);
}

const remote = await jsonFiles(PROXY_DIR);
const names = new Set([...Object.keys(local), ...Object.keys(remote)]);
const drift = [];
for (const name of names) {
  if (local[name] !== remote[name]) {
    drift.push(`${name}: local=${local[name] ?? "<missing>"} proxy=${remote[name] ?? "<missing>"}`);
  }
}
if (drift.length > 0) {
  console.error(`isolation vectors drifted from proxy copy at ${PROXY_DIR}:`);
  for (const line of drift) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`isolation vectors match proxy copy (${Object.keys(local).length} files)`);
