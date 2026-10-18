import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { firstNonEmpty } from "../env.js";
import { processMatchesIdentity, stopProcessIfMatches, type ProcessIdentity } from "../process.js";
import type { ProxyHandle } from "../types.js";

export interface JestProxyState {
  runId: string;
  proxyUrl: string;
  controlUrl: string;
  pid?: number;
  instanceId?: string;
  exePath?: string;
}

export function jestOwnerPid(): number {
  const explicit = Number(firstNonEmpty(process.env.LLMTESTLAB_JEST_OWNER_PID));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (process.env.JEST_WORKER_ID) return process.ppid;
  const argv = process.argv.join(" ");
  if (/\bjest\b/i.test(argv) && !/globalSetup|globalTeardown/i.test(argv)) return process.pid;
  return process.ppid;
}

export function pointerPath(ownerPid = jestOwnerPid()): string {
  return join(process.cwd(), ".llm-test-lab", "jest-runs", String(ownerPid));
}

export function stateFilePath(runId: string): string {
  return join(tmpdir(), "llm-test-lab", "jest", runId, "state.json");
}

export function statePath(): string {
  return firstNonEmpty(process.env.LLMTESTLAB_JEST_STATE_FILE) ?? stateFilePath(currentRunId());
}

export function currentRunId(): string {
  const fromEnv = firstNonEmpty(process.env.LLMTESTLAB_JEST_RUN_ID);
  if (fromEnv) return fromEnv;
  const fromPointer = fallbackRunIdFromPointersSync();
  if (fromPointer) return fromPointer;
  throw new Error(
    "llm-test-lab Jest run id is missing; globalSetup should create a pointer under .llm-test-lab/jest-runs/.",
  );
}

function fallbackRunIdFromPointersSync(): string | undefined {
  for (const pid of [process.pid, process.ppid]) {
    try {
      const runId = readFileSync(pointerPath(pid), "utf8").trim();
      if (runId) return runId;
    } catch {
      // Try the next owner pid.
    }
  }
  return undefined;
}

export async function resolveRunId(): Promise<string> {
  const fromEnv = firstNonEmpty(process.env.LLMTESTLAB_JEST_RUN_ID);
  if (fromEnv) return fromEnv;
  for (const pid of [process.pid, process.ppid]) {
    try {
      const runId = (await readFile(pointerPath(pid), "utf8")).trim();
      if (runId) return runId;
    } catch {
      // Try the next owner pid.
    }
  }
  throw new Error(
    "llm-test-lab Jest run id is missing; globalSetup should create a pointer under .llm-test-lab/jest-runs/.",
  );
}

export async function allocateRun(ownerPid = jestOwnerPid()): Promise<{ runId: string; statePath: string }> {
  const runId = firstNonEmpty(process.env.LLMTESTLAB_JEST_RUN_ID) ?? randomUUID();
  process.env.LLMTESTLAB_JEST_RUN_ID = runId;
  process.env.LLMTESTLAB_JEST_OWNER_PID = String(ownerPid);
  const path = firstNonEmpty(process.env.LLMTESTLAB_JEST_STATE_FILE) ?? stateFilePath(runId);
  process.env.LLMTESTLAB_JEST_STATE_FILE = path;
  const pointer = pointerPath(ownerPid);
  await mkdir(dirname(pointer), { recursive: true, mode: 0o700 });
  await chmod(dirname(pointer), 0o700);
  await writeFile(pointer, `${runId}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(pointer, 0o600);
  return { runId, statePath: path };
}

export async function writeState(handle: ProxyHandle, runId?: string): Promise<string> {
  const allocated = runId ?? (await resolveRunId());
  process.env.LLMTESTLAB_JEST_RUN_ID = allocated;
  const generated = stateFilePath(allocated);
  const path = firstNonEmpty(process.env.LLMTESTLAB_JEST_STATE_FILE) ?? generated;
  process.env.LLMTESTLAB_JEST_STATE_FILE = path;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Only chmod directories we created for this run. A custom
  // LLMTESTLAB_JEST_STATE_FILE may live under a shared parent such as /tmp.
  if (path === generated) {
    await chmod(dir, 0o700);
  }
  const state: JestProxyState = {
    runId: allocated,
    proxyUrl: handle.proxyUrl,
    controlUrl: handle.controlUrl,
    ...(handle.pid ? { pid: handle.pid } : {}),
    ...(handle.instanceId ? { instanceId: handle.instanceId } : {}),
    ...(handle.exePath ? { exePath: handle.exePath } : {}),
  };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function readState(): Promise<JestProxyState> {
  return JSON.parse(await readFile(statePath(), "utf8")) as JestProxyState;
}

export async function deleteState(): Promise<void> {
  const path = firstNonEmpty(process.env.LLMTESTLAB_JEST_STATE_FILE);
  const runId = firstNonEmpty(process.env.LLMTESTLAB_JEST_RUN_ID);
  const generated = runId ? stateFilePath(runId) : undefined;
  if (path) await rm(path, { force: true });
  if (generated && generated !== path) await rm(generated, { force: true });
  if (generated) await rm(dirname(generated), { recursive: true, force: true });
  await rm(pointerPath(), { force: true }).catch(() => undefined);
  await rm(pointerPath(process.pid), { force: true }).catch(() => undefined);
  await rm(pointerPath(process.ppid), { force: true }).catch(() => undefined);
}

export function applyState(state: Pick<JestProxyState, "proxyUrl" | "controlUrl" | "runId">): void {
  process.env.LLMTESTLAB_PROXY_URL = state.proxyUrl;
  process.env.LLMTESTLAB_CONTROL_URL = state.controlUrl;
  process.env.LLMTESTLAB_JEST_RUN_ID = state.runId;
  // Control tokens stay in the parent environment; they are never written to disk.
}

export function identityFromState(state: JestProxyState): ProcessIdentity | undefined {
  if (!state.pid || !state.instanceId) return undefined;
  return {
    pid: state.pid,
    instanceId: state.instanceId,
    ...(state.exePath ? { exePath: state.exePath } : {}),
  };
}

export async function stopOwnedProxy(state: JestProxyState): Promise<boolean> {
  const identity = identityFromState(state);
  if (!identity) return false;
  if (!(await processMatchesIdentity(identity.pid, identity))) return false;
  return stopProcessIfMatches(identity.pid, identity);
}
