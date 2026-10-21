import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const CONTRACT_NAME = "openapi.yaml";

/**
 * Path to the bundled control-API contract, when this install shipped one.
 * Looks next to the package, under `docs/`, beside `LLMENTARY_BIN`, and
 * `LLMENTARY_OPENAPI_PATH`.
 */
export function contractPath(): string | undefined {
  const env = process.env.LLMENTARY_OPENAPI_PATH?.trim();
  if (env && existsSync(env)) return env;
  for (const root of searchRoots()) {
    const direct = join(root, CONTRACT_NAME);
    if (existsSync(direct)) return direct;
    const docs = join(root, "docs", CONTRACT_NAME);
    if (existsSync(docs)) return docs;
  }
  const bin = process.env.LLMENTARY_BIN?.trim();
  if (bin) {
    const beside = join(dirname(bin), CONTRACT_NAME);
    if (existsSync(beside)) return beside;
  }
  return undefined;
}

function searchRoots(): string[] {
  const roots = new Set<string>([process.cwd()]);
  try {
    const require = createRequire(join(process.cwd(), "package.json"));
    roots.add(dirname(require.resolve("llmentary/package.json")));
  } catch {
    // Not imported as the published package name from this cwd.
  }
  return [...roots];
}
