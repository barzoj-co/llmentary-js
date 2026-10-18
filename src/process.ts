import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ProcessIdentity {
  pid: number;
  instanceId?: string;
  exePath?: string;
  startedAtMs?: number;
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
  const instanceId = instanceIdFromEnviron(environ) ?? instanceIdFromSidecar(pid);
  const exePath = await readProcessExe(pid);
  const startedAtMs = readProcessStartMs(pid);
  return {
    pid,
    ...(instanceId ? { instanceId } : {}),
    ...(exePath ? { exePath } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
}

export async function processMatchesIdentity(pid: number, expected: ProcessIdentity): Promise<boolean> {
  if (!expected.instanceId) return false;
  const actual = await readProcessIdentity(pid);
  if (!actual?.instanceId) return false;
  return actual.instanceId === expected.instanceId;
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
    if (!pidExists(pid)) {
      forgetSpawnedProcess(pid);
      return true;
    }
    await delay(50);
  }
  if (await processMatchesIdentity(pid, expected)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return false;
    }
  }
  if (!pidExists(pid)) forgetSpawnedProcess(pid);
  return true;
}

export function rememberSpawnedProcess(identity: ProcessIdentity): void {
  if (!identity.pid || !identity.instanceId) return;
  const path = sidecarPath(identity.pid);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify({ instanceId: identity.instanceId, startedAtMs: identity.startedAtMs ?? Date.now() })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function forgetSpawnedProcess(pid: number): void {
  try {
    rmSync(sidecarPath(pid), { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

async function readProcessEnviron(pid: number): Promise<string> {
  try {
    const data = await readFile(`/proc/${pid}/environ`);
    return data.toString("utf8").split("\0").join("\n");
  } catch {
    if (process.platform === "win32") return readWindowsCommandLine(pid);
    const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return result.stdout || "";
  }
}

function instanceIdFromEnviron(environ: string): string | undefined {
  for (const line of environ.split("\n")) {
    const match = /LLMTESTLAB_INSTANCE_ID=([^\s]+)/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function instanceIdFromSidecar(pid: number): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath(pid), "utf8")) as { instanceId?: string; startedAtMs?: number };
    if (!parsed.instanceId) return undefined;
    const liveStart = readProcessStartMs(pid);
    if (parsed.startedAtMs !== undefined && liveStart !== undefined && Math.abs(liveStart - parsed.startedAtMs) > 5_000) {
      return undefined;
    }
    return parsed.instanceId;
  } catch {
    return undefined;
  }
}

async function readProcessExe(pid: number): Promise<string | undefined> {
  try {
    return await readlink(`/proc/${pid}/exe`);
  } catch {
    if (process.platform === "win32") return readWindowsExecutablePath(pid);
    const result = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    const comm = result.stdout?.trim();
    return comm || undefined;
  }
}

function readProcessStartMs(pid: number): number | undefined {
  if (process.platform === "win32") return readWindowsStartMs(pid);
  try {
    const value = statSync(`/proc/${pid}`).ctimeMs;
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readWindowsCommandLine(pid: number): string {
  return queryWindowsProcess(pid, "CommandLine");
}

function readWindowsExecutablePath(pid: number): string | undefined {
  return queryWindowsProcess(pid, "ExecutablePath") || undefined;
}

function readWindowsStartMs(pid: number): number | undefined {
  const script = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const value = Number(result.stdout?.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function queryWindowsProcess(pid: number, property: "CommandLine" | "ExecutablePath"): string {
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").${property}`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  return result.stdout?.trim() ?? "";
}

function sidecarPath(pid: number): string {
  return join(tmpdir(), "llm-test-lab", "proc", `${pid}.json`);
}
