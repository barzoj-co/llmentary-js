#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packDir = mkdtempSync(join(tmpdir(), "ltl-pack-"));
execSync("npm pack --pack-destination " + JSON.stringify(packDir), { cwd: root, stdio: "inherit" });
const tarball = execFileSync("sh", ["-c", "ls *.tgz"], { cwd: packDir, encoding: "utf8" }).trim().split("\n")[0];
if (!tarball) throw new Error("npm pack did not produce a tarball");
const tarballPath = join(packDir, tarball);

function write(dir, name, contents) {
  writeFileSync(join(dir, name), contents);
}

function npmInstall(dir) {
  execSync(`npm install --omit=optional --no-audit --no-fund ${JSON.stringify(tarballPath)}`, {
    cwd: dir,
    stdio: "inherit",
  });
}

function runNode(dir, args) {
  execFileSync(process.execPath, args, { cwd: dir, stdio: "inherit" });
}

{
  const dir = join(packDir, "esm-js");
  mkdirSync(dir);
  write(dir, "package.json", JSON.stringify({ name: "esm-js-consumer", type: "module", private: true }, null, 2));
  npmInstall(dir);
  write(
    dir,
    "index.js",
    `import { createLab } from "llm-test-lab";
import { lab } from "llm-test-lab/jest";
if (typeof createLab !== "function") throw new Error("createLab missing");
if (typeof lab !== "function") throw new Error("lab missing");
const facade = createLab({ proxyUrl: "http://127.0.0.1:9", controlUrl: "http://127.0.0.1:9" });
if (!facade.baseURL.endsWith("/v1")) throw new Error("baseURL");
`,
  );
  runNode(dir, ["index.js"]);
}

{
  const dir = join(packDir, "cjs-js");
  mkdirSync(dir);
  write(dir, "package.json", JSON.stringify({ name: "cjs-js-consumer", type: "commonjs", private: true }, null, 2));
  npmInstall(dir);
  write(
    dir,
    "index.cjs",
    `const { createLab } = require("llm-test-lab");
const { lab } = require("llm-test-lab/jest");
if (typeof createLab !== "function") throw new Error("createLab missing");
if (typeof lab !== "function") throw new Error("lab missing");
const facade = createLab({ proxyUrl: "http://127.0.0.1:9", controlUrl: "http://127.0.0.1:9" });
if (!facade.baseURL.endsWith("/v1")) throw new Error("baseURL");
`,
  );
  runNode(dir, ["index.cjs"]);
}

function tsConsumer(name, pkg, tsconfig, sourceName, source) {
  const dir = join(packDir, name);
  mkdirSync(dir);
  write(dir, "package.json", JSON.stringify({ name, private: true, ...pkg }, null, 2));
  npmInstall(dir);
  execSync("npm install --no-audit --no-fund --save-dev typescript@6.0.3", { cwd: dir, stdio: "inherit" });
  write(dir, "tsconfig.json", JSON.stringify(tsconfig, null, 2));
  write(dir, sourceName, source);
  execFileSync(join(dir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--noEmit"], {
    cwd: dir,
    stdio: "inherit",
  });
}

const importSource = `import { createLab } from "llm-test-lab";
import { lab } from "llm-test-lab/jest";
export const facade = createLab({ proxyUrl: "http://127.0.0.1:9", controlUrl: "http://127.0.0.1:9" });
export const current = lab();
`;

tsConsumer(
  "ts-nodenext",
  { type: "module" },
  {
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["index.ts"],
  },
  "index.ts",
  importSource,
);

tsConsumer(
  "ts-node16-cjs",
  { type: "commonjs" },
  {
    compilerOptions: {
      module: "Node16",
      moduleResolution: "Node16",
      strict: true,
      esModuleInterop: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["index.ts"],
  },
  "index.ts",
  importSource,
);

tsConsumer(
  "ts-bundler",
  { type: "module" },
  {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["index.ts"],
  },
  "index.ts",
  importSource,
);

console.log("pack consumers: esm-js, cjs-js, ts-nodenext, ts-node16-cjs, ts-bundler ok");
