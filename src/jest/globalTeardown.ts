import { deleteState, readState, stopOwnedProxy } from "./state.js";

export default async function globalTeardown(): Promise<void> {
  const state = await readState().catch(() => undefined);
  if (state) {
    await stopOwnedProxy(state);
  }
  await deleteState();
}
