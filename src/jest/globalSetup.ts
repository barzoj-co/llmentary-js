import { startProxy } from "../proxy.js";
import { applyState, writeState } from "./state.js";

export default async function globalSetup(): Promise<void> {
  const handle = await startProxy();
  applyState(handle);
  await writeState(handle);
}
