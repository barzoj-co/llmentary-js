#!/usr/bin/env node
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = mkdtempSync(join(tmpdir(), "ltl-pack-licenses-"));

const required = ["package/dist/esm", "package/dist/cjs", "package/LICENSE", "package/licenses/AGPL-3.0.txt"];

try {
  execSync("npm pack --pack-destination " + JSON.stringify(dest), { cwd: root, stdio: "inherit" });
  const tarball = readdirSync(dest).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not produce a tarball");
  const listing = execSync(`tar -tzf ${JSON.stringify(join(dest, tarball))}`, { encoding: "utf8" });
  const missing = required.filter((entry) => !listing.split("\n").some((line) => line === entry || line.startsWith(`${entry}/`)));
  if (missing.length) {
    throw new Error(`root tarball missing ${missing.join(", ")}\n${listing}`);
  }
  console.log("root tarball contains dist/esm, dist/cjs, LICENSE, licenses/AGPL-3.0.txt");
} finally {
  rmSync(dest, { recursive: true, force: true });
}
