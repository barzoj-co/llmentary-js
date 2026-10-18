import { startProxy } from "../proxy.js";
import { allocateRun, applyState, readState, writeState } from "./state.js";

export default async function globalSetup(): Promise<void> {
  await allocateRun();
  const handle = await startProxy();
  await writeState(handle);
  applyState(await readState());
}
