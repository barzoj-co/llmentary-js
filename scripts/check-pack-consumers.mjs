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

function runTsc(dir, tsc, args) {
  try {
    const stdout = execFileSync(tsc, args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return { ok: false, output };
  }
}

function hasMissingExportDiagnostic(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codes = /error TS2305:|error TS2724:/;
  const member = new RegExp(`has no exported member(?: named)? ['"]${escaped}['"]`);
  return codes.test(output) && member.test(output);
}

{
  const dir = join(packDir, "esm-js");
  mkdirSync(dir);
  write(dir, "package.json", JSON.stringify({ name: "esm-js-consumer", type: "module", private: true }, null, 2));
  npmInstall(dir);
  write(
    dir,
    "index.js",
    `import { createLlmentary, llmentary } from "llmentary";
import { llmentary as current } from "llmentary/jest";
if (typeof createLlmentary !== "function") throw new Error("createLlmentary missing");
if (typeof llmentary !== "function") throw new Error("llmentary missing");
if (typeof current !== "function") throw new Error("jest llmentary missing");
const facade = llmentary({ proxyUrl: "http://127.0.0.1:9", controlUrl: "http://127.0.0.1:9" });
if (!facade.baseURL.endsWith("/v1")) throw new Error("baseURL");
if (createLlmentary !== llmentary) throw new Error("createLlmentary alias");
const core = await import("llmentary");
const jestApi = await import("llmentary/jest");
const old = ["l", "ab"].join("");
const Old = old[0].toUpperCase() + old.slice(1);
const removed = [old, "create" + Old, "cleanup" + Old, Old, Old + "Query", Old + "Config", Old + "Globals", Old + "AssertionError"];
for (const name of removed) {
  if (name in core) throw new Error("core still exports " + name);
  if (name in jestApi) throw new Error("jest still exports " + name);
}
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
    `const { createLlmentary, llmentary } = require("llmentary");
const { llmentary: current } = require("llmentary/jest");
if (typeof createLlmentary !== "function") throw new Error("createLlmentary missing");
if (typeof llmentary !== "function") throw new Error("llmentary missing");
if (typeof current !== "function") throw new Error("jest llmentary missing");
const facade = llmentary({ proxyUrl: "http://127.0.0.1:9", controlUrl: "http://127.0.0.1:9" });
if (!facade.baseURL.endsWith("/v1")) throw new Error("baseURL");
if (createLlmentary !== llmentary) throw new Error("createLlmentary alias");
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

const importSource = `import { createLlmentary, llmentary, type Llmentary, type LlmentaryQuery, type LlmentaryOptions } from "llmentary";
import { llmentary as currentLlmentary } from "llmentary/jest";
const options: LlmentaryOptions = { proxyUrl: "http://127.0.0.1:9", controlUrl: "http://127.0.0.1:9" };
export const facade: Llmentary = createLlmentary(options);
export const also: Llmentary = llmentary(options);
export const query: LlmentaryQuery = facade.query({});
export const current = currentLlmentary();
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
  const Old = ["L", "ab"].join("");
  const oldNames = [
    ["Llm", "Test", Old].join(""),
    ["Llm", "Test", Old, "Query"].join(""),
    ["Llm", "Test", Old, "Globals"].join(""),
    Old,
    Old + "Query",
    Old + "Config",
    Old + "Globals",
    Old + "AssertionError",
    "create" + Old,
  ];
  write(
    dir,
    "old-export.tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["old-export.ts"],
      },
      null,
      2,
    ),
  );
  for (const name of oldNames) {
    write(dir, "old-export.ts", `import type { ${name} } from "llmentary";\nexport type Probe = ${name};\n`);
    const result = runTsc(dir, tsc, ["-p", "old-export.tsconfig.json", "--pretty", "false", "--noEmit"]);
    if (result.ok) {
      throw new Error(`expected tsc to reject the removed public type ${name}`);
    }
    if (!hasMissingExportDiagnostic(result.output, name)) {
      throw new Error(
        `expected a missing-export diagnostic for ${name}, got unrelated tsc errors:\n${result.output}`,
      );
    }
  }
}

console.log("pack consumers: esm-js, cjs-js, ts-nodenext, ts-node16-cjs, ts-bundler ok");
}
