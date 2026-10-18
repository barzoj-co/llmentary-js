const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = join(process.cwd(), "dist", "cjs");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));
