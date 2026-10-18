import { spawnSync as nodeSpawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync as nodeReadFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PROCESS_QUERY_TIMEOUT_MS = 3_000;

export interface ProcessQueryResult {
  error?: Error;
  status: number | null;
  stdout?: string;
  stderr?: string;
}

/** Test seam: stub `spawnSync` / `/proc` reads without mocking the whole module. */
export const processLookups = {
  spawnSync: nodeSpawnSync as (
    command: string,
    args?: readonly string[],
    options?: { encoding?: BufferEncoding; timeout?: number; windowsHide?: boolean },
  ) => ProcessQueryResult,
  readProcFileSync: nodeReadFileSync,
};

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
  chmodSync(dirname(path), 0o700);
  const startedAtMs = readProcessStartMs(identity.pid) ?? identity.startedAtMs ?? Date.now();
  writeFileSync(
    path,
    `${JSON.stringify({ instanceId: identity.instanceId, startedAtMs })}\n`,
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
    const result = processLookups.spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: PROCESS_QUERY_TIMEOUT_MS,
    });
    return result.error ? "" : result.stdout || "";
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
    const parsed = JSON.parse(nodeReadFileSync(sidecarPath(pid), "utf8")) as { instanceId?: string; startedAtMs?: number };
    if (!parsed.instanceId || parsed.startedAtMs === undefined) return undefined;
    const liveStart = readProcessStartMs(pid);
    if (liveStart === undefined) return undefined;
    if (Math.abs(liveStart - parsed.startedAtMs) > 5_000) return undefined;
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
    const result = processLookups.spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      timeout: PROCESS_QUERY_TIMEOUT_MS,
    });
    if (result.error) return undefined;
    const comm = result.stdout?.trim();
    return comm || undefined;
  }
}

export function readProcessStartMs(pid: number): number | undefined {
  if (process.platform === "win32") return readWindowsStartMs(pid);
  return readLinuxStartMs(pid) ?? readPsElapsedStartMs(pid);
}

function readLinuxStartMs(pid: number): number | undefined {
  try {
    const pidStat = String(processLookups.readProcFileSync(`/proc/${pid}/stat`, "utf8"));
    const procStat = String(processLookups.readProcFileSync("/proc/stat", "utf8"));
    const fromBoot = linuxStartMsFromProc(pidStat, procStat, clockTicksPerSecond());
    if (fromBoot !== undefined) return fromBoot;
    const closeParen = pidStat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const rest = pidStat.slice(closeParen + 2).trim().split(/\s+/);
    const startTicks = Number(rest[19]);
    if (!Number.isFinite(startTicks) || startTicks < 0) return undefined;
    const ticks = clockTicksPerSecond();
    const uptime = Number(processLookups.readProcFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]);
    if (!Number.isFinite(uptime) || uptime < 0) return undefined;
    const elapsedSec = uptime - startTicks / ticks;
    if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return undefined;
    return Date.now() - elapsedSec * 1000;
  } catch {
    return undefined;
  }
}

/** Field 22 of `/proc/<pid>/stat` plus `btime` from `/proc/stat`. Independent of `process.platform`. */
export function linuxStartMsFromProc(pidStat: string, procStat: string, clockTicks = 100): number | undefined {
  const closeParen = pidStat.lastIndexOf(")");
  if (closeParen < 0) return undefined;
  const rest = pidStat.slice(closeParen + 2).trim().split(/\s+/);
  const startTicks = Number(rest[19]);
  if (!Number.isFinite(startTicks) || startTicks < 0) return undefined;
  if (!Number.isFinite(clockTicks) || clockTicks <= 0) return undefined;
  const match = /^btime\s+(\d+)\b/m.exec(procStat);
  if (!match) return undefined;
  const bootSec = Number(match[1]);
  if (!Number.isFinite(bootSec) || bootSec <= 0) return undefined;
  return (bootSec + startTicks / clockTicks) * 1000;
}

function readPsElapsedStartMs(pid: number): number | undefined {
  const result = processLookups.spawnSync("ps", ["-p", String(pid), "-o", "etime="], {
    encoding: "utf8",
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return undefined;
  const elapsedSec = parsePsEtime(result.stdout ?? "");
  if (elapsedSec === undefined) return undefined;
  return Date.now() - elapsedSec * 1000;
}

/** `etime` is `[[dd-]hh:]mm:ss` on both GNU and Darwin ps. */
export function parsePsEtime(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const dayParts = trimmed.split("-");
  let days = 0;
  let clock = trimmed;
  if (dayParts.length === 2) {
    days = Number(dayParts[0]);
    clock = dayParts[1] ?? "";
    if (!Number.isFinite(days) || days < 0) return undefined;
  }
  const parts = clock.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  const seconds = parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts[0]! * 60 + parts[1]!;
  return days * 86_400 + seconds;
}

function clockTicksPerSecond(): number {
  const result = processLookups.spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: PROCESS_QUERY_TIMEOUT_MS });
  const value = Number(result.stdout?.trim());
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function readWindowsCommandLine(pid: number): string {
  return queryWindowsProcess(pid, "CommandLine");
}

function readWindowsExecutablePath(pid: number): string | undefined {
  return queryWindowsProcess(pid, "ExecutablePath") || undefined;
}

function readWindowsStartMs(pid: number): number | undefined {
  const script = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds`;
  const stdout = spawnWindowsQuery(script);
  if (stdout === undefined) return undefined;
  const value = Number(stdout);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function queryWindowsProcess(pid: number, property: "CommandLine" | "ExecutablePath"): string {
  return spawnWindowsQuery(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").${property}`) ?? "";
}

function spawnWindowsQuery(script: string): string | undefined {
  const result = processLookups.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  const stdout = result.stdout?.trim();
  return stdout ? stdout : undefined;
}

function sidecarPath(pid: number): string {
  return join(tmpdir(), "llm-test-lab", "proc", `${pid}.json`);
}
