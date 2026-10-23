import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { thisModuleHref } from "./module-href.js";

const CONTRACT_NAME = "openapi.yaml";

/** Release-please leaves this on the on-disk `info.version` line; serve stamps it off. */
const RELEASE_PLEASE_VERSION_COMMENT = /^([ \t]*version:[ \t]*\S+)[ \t]+#[ \t]*x-release-please-version[ \t]*\r?$/gm;

/**
 * Apply the same serve-time stamp the proxy uses on `GET /openapi.yaml`
 * (DOG-37 / proxy #47 / #60): strip `# x-release-please-version` from the
 * `info.version` line. Does not rewrite the version value.
 */
export function stampOpenAPI(yaml: string): string {
  return yaml.replace(RELEASE_PLEASE_VERSION_COMMENT, "$1");
}

/**
 * The proxy serves the bundled contract with `info.version` stamped clean
 * (DOG-37). Proxy v0.5.0 keeps `# x-release-please-version` in the file (#47).
 * Proxy v0.5.1 serves the packaged bytes unchanged when `info.version` already
 * matches the release, including that marker.
 */
export function bundledContractForServe(yaml: string): string {
  return stampOpenAPI(yaml);
}

/** SHA-256 hex of UTF-8 bytes — same digest the proxy uses after stamping. */
export function openapiSha256(yaml: string): string {
  return createHash("sha256").update(Buffer.from(yaml, "utf8")).digest("hex");
}

/**
 * True when `GET /openapi.yaml` matches the packaged contract either
 * byte-for-byte (proxy v0.5.1) or after the serve stamp (DOG-44 / older pins).
 */
export function packagedMatchesServed(packaged: string, served: string): boolean {
  const servedHash = openapiSha256(served);
  return servedHash === openapiSha256(packaged) || servedHash === openapiSha256(stampOpenAPI(packaged));
}

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
