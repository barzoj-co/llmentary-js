import { llmentary as createSession, type Session } from "./session.js";
import type { SessionOptions } from "./types.js";

let current: Session | undefined;

export function llmentary(config?: SessionOptions): Session {
  if (config) return createSession(config);
  if (!current) current = createSession();
  return current;
}

export async function cleanupSession(): Promise<void> {
  await current?.cleanup().catch(() => undefined);
  current = undefined;
}

export type { Session, SessionOptions };
