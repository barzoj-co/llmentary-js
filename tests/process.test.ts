import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetSpawnedProcess,
  linuxStartMsFromProc,
  parsePsEtime,
  pidExists,
  processLookups,
  type ProcessQueryResult,
  processMatchesIdentity,
  readProcessIdentity,
  readProcessStartMs,
  rememberSpawnedProcess,
  stopProcessIfMatches,
} from "../src/process.js";

const children: ReturnType<typeof spawn>[] = [];
const originalLookups = { ...processLookups };

afterEach(async () => {
  processLookups.spawnSync = originalLookups.spawnSync;
  processLookups.readProcFileSync = originalLookups.readProcFileSync;
  for (const child of children.splice(0)) {
    if (child.pid && pidExists(child.pid)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

describe("process identity", () => {
  it("does not treat an unrelated process as the proxy", async () => {
    const child = spawnUnrelated();
    expect(child.pid).toBeDefined();
    const pid = child.pid!;
    await delay(50);
    await expect(
      processMatchesIdentity(pid, { pid, instanceId: "not-this-instance", exePath: "/usr/bin/llmentary" }),
    ).resolves.toBe(false);
    await expect(stopProcessIfMatches(pid, { pid, instanceId: "not-this-instance" })).resolves.toBe(false);
    expect(pidExists(pid)).toBe(true);
  });

  it("kills a process only when LLMENTARY_INSTANCE_ID still matches", async () => {
    const instanceId = randomUUID();
    const child = spawnUnrelated({ LLMENTARY_INSTANCE_ID: instanceId });
    const pid = child.pid!;
    await delay(50);
    await expect(processMatchesIdentity(pid, { pid, instanceId })).resolves.toBe(true);
    await expect(stopProcessIfMatches(pid, { pid, instanceId })).resolves.toBe(true);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && pidExists(pid)) await delay(50);
    expect(pidExists(pid)).toBe(false);
  });

  it("refuses to kill a recycled pid that lost the original identity", async () => {
    const instanceId = randomUUID();
    const first = spawnUnrelated({ LLMENTARY_INSTANCE_ID: instanceId });
    const pid = first.pid!;
    first.kill("SIGKILL");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && pidExists(pid)) await delay(50);

    const recycled = spawnUnrelated();
    children.push(recycled);
    const recycledPid = recycled.pid!;
    await delay(50);
    await expect(stopProcessIfMatches(recycledPid, { pid: recycledPid, instanceId })).resolves.toBe(false);
    expect(pidExists(recycledPid)).toBe(true);
  });

  it("refuses to kill when the persisted record has no instance id", async () => {
    const child = spawnUnrelated();
    const pid = child.pid!;
    await delay(50);
    await expect(processMatchesIdentity(pid, { pid, exePath: process.execPath })).resolves.toBe(false);
    await expect(stopProcessIfMatches(pid, { pid, exePath: process.execPath })).resolves.toBe(false);
    expect(pidExists(pid)).toBe(true);
  });

  it("matches a sidecar recorded at spawn using the live process start time", async () => {
    const child = spawnWithoutInstanceId();
    const pid = child.pid!;
    const instanceId = randomUUID();
    await delay(50);
    const liveStart = readProcessStartMs(pid);
    expect(liveStart).toBeDefined();
    expect(Math.abs((liveStart ?? 0) - Date.now())).toBeLessThan(15_000);
    rememberSpawnedProcess({ pid, instanceId, startedAtMs: Date.now() });
    await expect(processMatchesIdentity(pid, { pid, instanceId })).resolves.toBe(true);
    forgetSpawnedProcess(pid);
  });

  it("rejects a sidecar whose recorded start time is stale", async () => {
    const child = spawnWithoutInstanceId();
    const pid = child.pid!;
    const instanceId = randomUUID();
    await delay(50);
    writeSidecar(pid, instanceId, Date.now() - 60_000);
    await expect(processMatchesIdentity(pid, { pid, instanceId })).resolves.toBe(false);
    expect(pidExists(pid)).toBe(true);
    forgetSpawnedProcess(pid);
  });

  it("rejects a sidecar when the live start time is missing", async () => {
    const child = spawnWithoutInstanceId();
    const pid = child.pid!;
    const instanceId = randomUUID();
    await delay(50);
    rememberSpawnedProcess({ pid, instanceId, startedAtMs: Date.now() });
    processLookups.readProcFileSync = () => {
      throw new Error("proc unavailable");
    };
    processLookups.spawnSync = () => emptySpawnResult(1);
    await expect(processMatchesIdentity(pid, { pid, instanceId })).resolves.toBe(false);
    await expect(stopProcessIfMatches(pid, { pid, instanceId })).resolves.toBe(false);
    expect(pidExists(pid)).toBe(true);
    forgetSpawnedProcess(pid);
  });

  it("treats a timed-out spawnSync query as an identity mismatch", async () => {
    const child = spawnWithoutInstanceId();
    const pid = child.pid!;
    const instanceId = randomUUID();
    await delay(50);
    rememberSpawnedProcess({ pid, instanceId, startedAtMs: Date.now() });
    processLookups.readProcFileSync = () => {
      throw new Error("proc unavailable");
    };
    processLookups.spawnSync = () => timedOutSpawnResult();
    await expect(processMatchesIdentity(pid, { pid, instanceId })).resolves.toBe(false);
    await expect(stopProcessIfMatches(pid, { pid, instanceId })).resolves.toBe(false);
    expect(pidExists(pid)).toBe(true);
    forgetSpawnedProcess(pid);
  });

  it("computes Linux start time from /proc/<pid>/stat field 22 plus btime", () => {
    expect(
      linuxStartMsFromProc(
        "1 (node) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 200 0 0",
        "cpu 1\nbtime 1700000000\n",
        100,
      ),
    ).toBe((1_700_000_000 + 200 / 100) * 1000);
  });

  it("rejects malformed /proc start-time inputs", () => {
    expect(linuxStartMsFromProc("no-paren", "btime 1\n")).toBeUndefined();
    expect(linuxStartMsFromProc("1 (x) S 0", "btime 1700000000\n")).toBeUndefined();
    expect(linuxStartMsFromProc("1 (node) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 0 0", "btime 1700000000\n")).toBeUndefined();
    expect(linuxStartMsFromProc("1 (node) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 200 0 0", "cpu 1\n")).toBeUndefined();
    expect(linuxStartMsFromProc("1 (node) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 200 0 0", "btime 0\n")).toBeUndefined();
    expect(
      linuxStartMsFromProc("1 (node) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 200 0 0", "btime 1700000000\n", 0),
    ).toBeUndefined();
  });

  it("returns undefined for a pid that is already gone", async () => {
    await expect(readProcessIdentity(2_147_000_000)).resolves.toBeUndefined();
  });

  it("ignores rememberSpawnedProcess without a pid or instance id", () => {
    rememberSpawnedProcess({ pid: 0, instanceId: "x" });
    rememberSpawnedProcess({ pid: 99 });
  });

  it("falls back to /proc/uptime when btime is missing", async () => {
    const child = spawnWithoutInstanceId();
    const pid = child.pid!;
    await delay(50);
    processLookups.readProcFileSync = ((path: string) => {
      const file = String(path);
      if (file === `/proc/${pid}/stat`) return "1 (node) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 200 0 0";
      if (file === "/proc/stat") return "cpu 1\n";
      if (file === "/proc/uptime") return "12.5 0\n";
      throw new Error(`unexpected proc path ${file}`);
    }) as unknown as typeof originalLookups.readProcFileSync;
    processLookups.spawnSync = (command) => {
      if (command === "getconf") return emptySpawnResult(1);
      return { stdout: "", stderr: "", status: 1 };
    };
    const start = readProcessStartMs(pid);
    expect(start).toBeDefined();
    expect(Math.abs((start ?? 0) - (Date.now() - 10_500))).toBeLessThan(3_000);
  });

  it("falls back to ps etime when /proc start time is unavailable", async () => {
    const child = spawnWithoutInstanceId();
    const pid = child.pid!;
    await delay(50);
    processLookups.readProcFileSync = () => {
      throw new Error("proc unavailable");
    };
    processLookups.spawnSync = (command, args) => {
      if (command === "ps" && args?.includes("etime=")) return { stdout: "00:08\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 1 };
    };
    const start = readProcessStartMs(pid);
    expect(start).toBeDefined();
    expect(Math.abs((start ?? 0) - (Date.now() - 8_000))).toBeLessThan(2_000);
  });

  it("returns undefined when ps etime is unparsable", async () => {
    const child = spawnWithoutInstanceId();
    const pid = child.pid!;
    await delay(50);
    processLookups.readProcFileSync = () => {
      throw new Error("proc unavailable");
    };
    processLookups.spawnSync = () => ({ stdout: "etimes\n", stderr: "", status: 0 });
    expect(readProcessStartMs(pid)).toBeUndefined();
  });

  it("escalates to SIGKILL when a matching process ignores SIGTERM", async () => {
    const instanceId = randomUUID();
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
      {
        env: { ...process.env, LLMENTARY_INSTANCE_ID: instanceId },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    children.push(child);
    const pid = child.pid!;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child never signaled ready")), 5_000);
      child.stdout!.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`child exited before ready: ${code} ${signal}`));
      });
    });
    const kill = vi.spyOn(process, "kill");
    try {
      await expect(stopProcessIfMatches(pid, { pid, instanceId })).resolves.toBe(true);
      expect(kill).toHaveBeenCalledWith(pid, "SIGKILL");
    } finally {
      kill.mockRestore();
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && pidExists(pid)) await delay(50);
    expect(pidExists(pid)).toBe(false);
  });
});

describe("Windows process lookups", () => {
  it("reads start time from powershell through processLookups", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    processLookups.spawnSync = (command) => {
      if (command === "powershell.exe") return { stdout: "1700000000123\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 1 };
    };
    try {
      expect(readProcessStartMs(4242)).toBe(1_700_000_000_123);
      processLookups.spawnSync = () => ({ stdout: "", stderr: "", status: 1 });
      expect(readProcessStartMs(4242)).toBeUndefined();
      processLookups.spawnSync = () => ({ stdout: "not-a-number\n", stderr: "", status: 0 });
      expect(readProcessStartMs(4242)).toBeUndefined();
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });
});

describe("parsePsEtime", () => {
  it("parses GNU and Darwin [[dd-]hh:]mm:ss values", () => {
    expect(parsePsEtime("01:02")).toBe(62);
    expect(parsePsEtime(" 01:02:03\n")).toBe(3723);
    expect(parsePsEtime("2-01:02:03")).toBe(2 * 86_400 + 3723);
    expect(parsePsEtime("00:00")).toBe(0);
    expect(parsePsEtime("")).toBeUndefined();
    expect(parsePsEtime("etimes")).toBeUndefined();
    expect(parsePsEtime("1")).toBeUndefined();
    expect(parsePsEtime("-2-01:00:00")).toBeUndefined();
    expect(parsePsEtime("01:02:03:04")).toBeUndefined();
    expect(parsePsEtime("01:-2")).toBeUndefined();
  });
});

function spawnUnrelated(extraEnv: NodeJS.ProcessEnv = {}): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, ...extraEnv },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function spawnWithoutInstanceId(): ReturnType<typeof spawn> {
  const env = { ...process.env };
  delete env.LLMENTARY_INSTANCE_ID;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function writeSidecar(pid: number, instanceId: string, startedAtMs: number): void {
  const path = join(tmpdir(), "llmentary", "proc", `${pid}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ instanceId, startedAtMs })}\n`, { encoding: "utf8", mode: 0o600 });
}

function emptySpawnResult(status: number): ProcessQueryResult {
  return { stdout: "", stderr: "", status };
}

function timedOutSpawnResult(): ProcessQueryResult {
  return {
    stdout: "",
    stderr: "",
    status: null,
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
  };
}
