import { createLab, type LlmTestLab } from "./lab.js";
import type { LabConfig } from "./types.js";

let currentLab: LlmTestLab | undefined;

export function lab(config?: LabConfig): LlmTestLab {
  if (config) return createLab(config);
  if (!currentLab) currentLab = createLab();
  return currentLab;
}

export async function cleanupLab(): Promise<void> {
  await currentLab?.cleanup().catch(() => undefined);
  currentLab = undefined;
}

export { createLab };
