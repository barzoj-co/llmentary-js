import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetSpawnedProcess,
  parsePsEtime,
  pidExists,
  processLookups,
  type ProcessQueryResult,
  processMatchesIdentity,
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
      processMatchesIdentity(pid, { pid, instanceId: "not-this-instance", exePath: "/usr/bin/llmtestlab" }),
    ).resolves.toBe(false);
    await expect(stopProcessIfMatches(pid, { pid, instanceId: "not-this-instance" })).resolves.toBe(false);
    expect(pidExists(pid)).toBe(true);
  });

  it("kills a process only when LLMTESTLAB_INSTANCE_ID still matches", async () => {
    const instanceId = randomUUID();
    const child = spawnUnrelated({ LLMTESTLAB_INSTANCE_ID: instanceId });
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
    const first = spawnUnrelated({ LLMTESTLAB_INSTANCE_ID: instanceId });
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
  delete env.LLMTESTLAB_INSTANCE_ID;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function writeSidecar(pid: number, instanceId: string, startedAtMs: number): void {
  const path = join(tmpdir(), "llm-test-lab", "proc", `${pid}.json`);
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
