import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProxyHandle } from "../types.js";

export interface JestProxyState {
  proxyUrl: string;
  controlUrl: string;
  bearerToken?: string;
  pid?: number;
}

export function statePath(): string {
  return process.env.LLMTESTLAB_JEST_STATE_FILE ?? join(process.cwd(), ".llm-test-lab", "jest-state.json");
}

export async function writeState(handle: ProxyHandle): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const state: JestProxyState = {
    proxyUrl: handle.proxyUrl,
    controlUrl: handle.controlUrl,
    ...(handle.bearerToken ? { bearerToken: handle.bearerToken } : {}),
    ...(handle.pid ? { pid: handle.pid } : {}),
  };
  await writeFile(path, JSON.stringify(state, null, 2));
}

export async function readState(): Promise<JestProxyState> {
  return JSON.parse(await readFile(statePath(), "utf8")) as JestProxyState;
}

export async function deleteState(): Promise<void> {
  await rm(statePath(), { force: true });
}

export function applyState(state: JestProxyState): void {
  process.env.LLMTESTLAB_PROXY_URL = state.proxyUrl;
  process.env.LLMTESTLAB_CONTROL_URL = state.controlUrl;
  if (state.bearerToken) {
    process.env.LLMTESTLAB_BEARER_TOKEN = state.bearerToken;
    process.env.LLMTESTLAB_CONTROL_TOKEN = state.bearerToken;
  }
}
