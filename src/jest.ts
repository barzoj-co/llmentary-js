import { createLlmentary, type Llmentary } from "./llmentary.js";
import type { LlmentaryOptions } from "./types.js";

let current: Llmentary | undefined;

export function llmentary(config?: LlmentaryOptions): Llmentary {
  if (config) return createLlmentary(config);
  if (!current) current = createLlmentary();
  return current;
}

export async function cleanupLlmentary(): Promise<void> {
  await current?.cleanup().catch(() => undefined);
  current = undefined;
}

export { createLlmentary };
