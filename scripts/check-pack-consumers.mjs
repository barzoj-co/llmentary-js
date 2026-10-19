#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packDir = mkdtempSync(join(tmpdir(), "ltl-pack-"));
try {
  runPackConsumerChecks();
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

function runPackConsumerChecks() {
  execSync("npm pack --pack-destination " + JSON.stringify(packDir), { cwd: root, stdio: "inherit" });
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one .tgz in ${packDir}, found ${JSON.stringify(tarballs)}`);
  }
  const tarballPath = join(packDir, tarballs[0]);

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
    `import { createLab } from "llmentary";
import { lab } from "llmentary/jest";
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
    `const { createLab } = require("llmentary");
const { lab } = require("llmentary/jest");
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

const importSource = `import { createLab, type Lab, type LabQuery } from "llmentary";
import { lab } from "llmentary/jest";
export const facade: Lab = createLab({ proxyUrl: "http://127.0.0.1:9", controlUrl: "http://127.0.0.1:9" });
export const query: LabQuery = facade.query({});
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

{
  const dir = join(packDir, "ts-nodenext");
  const tsc = join(dir, "node_modules", ".bin", "tsc");
  const oldNames = [
    ["Llm", "Test", "Lab"].join(""),
    ["Llm", "Test", "Lab", "Query"].join(""),
    ["Llm", "Test", "Lab", "Globals"].join(""),
  ];
  for (const name of oldNames) {
    write(dir, "old-export.ts", `import type { ${name} } from "llmentary";\nexport type Probe = ${name};\n`);
    let failed = false;
    try {
      execFileSync(tsc, ["--pretty", "false", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--noEmit", "old-export.ts"], {
        cwd: dir,
        stdio: "pipe",
      });
    } catch {
      failed = true;
    }
    if (!failed) {
      throw new Error(`expected tsc to reject the removed public type ${name}`);
    }
  }
}

console.log("pack consumers: esm-js, cjs-js, ts-nodenext, ts-node16-cjs, ts-bundler ok");
}
