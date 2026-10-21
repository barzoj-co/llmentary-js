import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const CONTRACT_NAME = "openapi.yaml";

/**
 * Path to the bundled control-API contract, when this install shipped one.
 *
 * Lookup order:
 * 1. `LLMENTARY_OPENAPI_PATH`
 * 2. beside `LLMENTARY_BIN` (the selected proxy binary)
 * 3. the published `llmentary` package root / `docs/`
 * 4. the caller working directory / `docs/` (last, so an unrelated cwd file cannot win)
 */
export function contractPath(): string | undefined {
  const env = process.env.LLMENTARY_OPENAPI_PATH?.trim();
  if (env && existsSync(env)) return env;

  const bin = process.env.LLMENTARY_BIN?.trim();
  if (bin) {
    const beside = join(dirname(bin), CONTRACT_NAME);
    if (existsSync(beside)) return beside;
  }

  for (const root of searchRoots()) {
    const direct = join(root, CONTRACT_NAME);
    if (existsSync(direct)) return direct;
    const docs = join(root, "docs", CONTRACT_NAME);
    if (existsSync(docs)) return docs;
  }
  return undefined;
}

function searchRoots(): string[] {
  const roots: string[] = [];
  try {
    const require = createRequire(join(process.cwd(), "package.json"));
    roots.push(dirname(require.resolve("llmentary/package.json")));
  } catch {
    // Not imported as the published package name from this cwd.
  }
  roots.push(process.cwd());
  return roots;
}
