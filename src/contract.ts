import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_NAME = "openapi.yaml";

/**
 * Path to the bundled control-API contract, when this install shipped one.
 *
 * Lookup order:
 * 1. `LLMENTARY_OPENAPI_PATH`
 * 2. beside `LLMENTARY_BIN` (the selected proxy binary)
 * 3. the loaded SDK package root / `docs/` (resolved from this module, not cwd)
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
  const href = thisModuleHref();
  if (href) {
    try {
      const require = createRequire(href);
      roots.push(dirname(require.resolve("llmentary/package.json")));
    } catch {
      // Not resolved as the published package name from this module.
    }
    try {
      let dir = dirname(fileURLToPath(href));
      for (let i = 0; i < 8; i += 1) {
        if (existsSync(join(dir, "package.json"))) {
          roots.push(dir);
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // fileURLToPath can throw for non-file URLs.
    }
  }
  roots.push(process.cwd());
  return [...new Set(roots)];
}

/** ESM `import.meta.url` without putting `import.meta` in the CJS compile. */
function thisModuleHref(): string | undefined {
  try {
    const href = (0, eval)("import.meta.url") as unknown;
    return typeof href === "string" && href.length > 0 ? href : undefined;
  } catch {
    return undefined;
  }
}
