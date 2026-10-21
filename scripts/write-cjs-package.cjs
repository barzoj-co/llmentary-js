const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = join(process.cwd(), "dist", "cjs");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));
// CJS tsc cannot emit import.meta; replace that helper with __filename.
writeFileSync(
  join(dir, "module-href.js"),
  [
    '"use strict";',
    "Object.defineProperty(exports, \"__esModule\", { value: true });",
    "const { pathToFileURL } = require(\"node:url\");",
    "function thisModuleHref() {",
    "  return pathToFileURL(__filename).href;",
    "}",
    "exports.thisModuleHref = thisModuleHref;",
    "",
  ].join("\n"),
);
writeFileSync(join(dir, "module-href.d.ts"), "export declare function thisModuleHref(): string;\n");
