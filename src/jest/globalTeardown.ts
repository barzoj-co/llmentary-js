import { deleteState, readState } from "./state.js";

export default async function globalTeardown(): Promise<void> {
  const state = await readState().catch(() => undefined);
  if (state?.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }
  await deleteState();
}
