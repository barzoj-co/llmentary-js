import { readFile, readlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface ProcessIdentity {
  pid: number;
  instanceId?: string;
  exePath?: string;
}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!pidExists(pid)) return undefined;
  const environ = await readProcessEnviron(pid);
  const instanceId = instanceIdFromEnviron(environ);
  const exePath = await readProcessExe(pid);
  return {
    pid,
    ...(instanceId ? { instanceId } : {}),
    ...(exePath ? { exePath } : {}),
  };
}

export async function processMatchesIdentity(pid: number, expected: ProcessIdentity): Promise<boolean> {
  const actual = await readProcessIdentity(pid);
  if (!actual) return false;
  if (expected.instanceId) return actual.instanceId === expected.instanceId;
  if (expected.exePath && actual.exePath) {
    return samePath(actual.exePath, expected.exePath) && isProxyExecutable(actual.exePath);
  }
  return Boolean(actual.exePath && isProxyExecutable(actual.exePath));
}

export async function stopProcessIfMatches(pid: number, expected: ProcessIdentity): Promise<boolean> {
  if (!(await processMatchesIdentity(pid, expected))) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await delay(50);
  }
  if (await processMatchesIdentity(pid, expected)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return false;
    }
  }
  return true;
}

async function readProcessEnviron(pid: number): Promise<string> {
  try {
    const data = await readFile(`/proc/${pid}/environ`);
    return data.toString("utf8").split("\0").join("\n");
  } catch {
    const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return result.stdout || "";
  }
}

function instanceIdFromEnviron(environ: string): string | undefined {
  for (const line of environ.split("\n")) {
    if (line.startsWith("LLMTESTLAB_INSTANCE_ID=")) return line.slice("LLMTESTLAB_INSTANCE_ID=".length) || undefined;
  }
  const embedded = environ.match(/LLMTESTLAB_INSTANCE_ID=([^\s]+)/);
  return embedded?.[1];
}

async function readProcessExe(pid: number): Promise<string | undefined> {
  try {
    return await readlink(`/proc/${pid}/exe`);
  } catch {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    const comm = result.stdout?.trim();
    return comm || undefined;
  }
}

function isProxyExecutable(exePath: string): boolean {
  return /llmtestlab|llm-test-lab/i.test(exePath);
}

function samePath(left: string, right: string): boolean {
  return left === right || left.endsWith(right) || right.endsWith(left);
}
