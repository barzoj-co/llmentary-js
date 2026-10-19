import { createLab, type Lab } from "./lab.js";
import type { LabConfig } from "./types.js";

let currentLab: Lab | undefined;

export function lab(config?: LabConfig): Lab {
  if (config) return createLab(config);
  if (!currentLab) currentLab = createLab();
  return currentLab;
}

export async function cleanupLab(): Promise<void> {
  await currentLab?.cleanup().catch(() => undefined);
  currentLab = undefined;
}

export { createLab };
