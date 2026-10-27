import { spawn } from "node:child_process";
import { chmod, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { pidExists } from "../src/process.js";
import {
  allocateRun,
  applyState,
  currentRunId,
  deleteState,
  identityFromState,
  jestOwnerPid,
  pointerPath,
  readState,
  resolveRunId,
  stateFilePath,
  stopOwnedProxy,
  writeState,
} from "../src/jest/state.js";
import type { ProxyHandle } from "../src/types.js";

const KEYS = [
  "LLMENTARY_JEST_RUN_ID",
  "LLMENTARY_JEST_OWNER_PID",
  "LLMENTARY_JEST_STATE_FILE",
  "LLMENTARY_PROXY_URL",
  "LLMENTARY_CONTROL_URL",
] as const;

const previous: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
const allocatedOwnerPids: number[] = [];

afterEach(async () => {
  await deleteState().catch(() => undefined);
  for (const pid of allocatedOwnerPids.splice(0)) {
    const { rm } = await import("node:fs/promises");
    await rm(pointerPath(pid), { force: true });
  }
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
    delete previous[key];
  }
});

describe("Jest state hardening", () => {
  it("writes owner-only state in a unique per-run location without a control token", async () => {
    stashEnv();
    const ownerPid = 91_001;
    const { runId, statePath } = await allocateRun(ownerPid);
    allocatedOwnerPids.push(ownerPid);
    expect(statePath).toBe(join(tmpdir(), "llmentary", "jest", runId, "state.json"));
    expect(statePath).not.toContain(".llmentary/jest-state.json");

    const handle = fakeHandle({
      proxyUrl: "http://127.0.0.1:4010",
      controlUrl: "http://127.0.0.1:4011",
      bearerToken: "super-secret-control-token",
      pid: 4242,
      instanceId: "instance-a",
      exePath: "/tmp/llmentary",
    });
    const written = await writeState(handle, runId);
    const fileStat = await stat(written);
    const dirStat = await stat(dirname(written));
    expect(fileStat.isFile()).toBe(true);
    expect(dirStat.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(dirStat.mode & 0o777).toBe(0o700);
    }

    const raw = await readFile(written, "utf8");
    expect(raw).not.toContain("super-secret-control-token");
    expect(raw).not.toContain("bearerToken");
    const state = await readState();
    expect(state.runId).toBe(runId);
    expect(state.proxyUrl).toBe("http://127.0.0.1:4010");
    expect(state.instanceId).toBe("instance-a");
    expect(state).not.toHaveProperty("bearerToken");

    applyState(state);
    expect(process.env.LLMENTARY_PROXY_URL).toBe(state.proxyUrl);
    expect(process.env.LLMENTARY_BEARER_TOKEN).toBeUndefined();
  });

  it("keeps concurrent Jest runs in the same directory isolated", async () => {
    stashEnv();
    const first = await allocateRun(91_011);
    allocatedOwnerPids.push(91_011);
    await writeState(fakeHandle({ proxyUrl: "http://127.0.0.1:5010", controlUrl: "http://127.0.0.1:5011", pid: 11 }), first.runId);

    delete process.env.LLMENTARY_JEST_RUN_ID;
    delete process.env.LLMENTARY_JEST_STATE_FILE;
    delete process.env.LLMENTARY_JEST_OWNER_PID;
    const second = await allocateRun(91_012);
    allocatedOwnerPids.push(91_012);
    await writeState(fakeHandle({ proxyUrl: "http://127.0.0.1:6010", controlUrl: "http://127.0.0.1:6011", pid: 12 }), second.runId);

    expect(first.runId).not.toBe(second.runId);
    expect(first.statePath).not.toBe(second.statePath);

    const pointerA = (await readFile(pointerPath(91_011), "utf8")).trim();
    const pointerB = (await readFile(pointerPath(91_012), "utf8")).trim();
    expect(pointerA).toBe(first.runId);
    expect(pointerB).toBe(second.runId);

    const stateA = JSON.parse(await readFile(stateFilePath(pointerA), "utf8")) as { proxyUrl: string; pid?: number };
    const stateB = JSON.parse(await readFile(stateFilePath(pointerB), "utf8")) as { proxyUrl: string; pid?: number };
    expect(stateA.proxyUrl).toBe("http://127.0.0.1:5010");
    expect(stateB.proxyUrl).toBe("http://127.0.0.1:6010");
    expect(stateA.pid).not.toBe(stateB.pid);
  });

  it("does not kill a process that fails the stale-pid identity check", async () => {
    stashEnv();
    const killed = await stopOwnedProxy({
      runId: "run",
      proxyUrl: "http://127.0.0.1:1",
      controlUrl: "http://127.0.0.1:2",
      pid: process.pid,
      instanceId: "not-the-current-process",
      exePath: "/usr/bin/llmentary",
    });
    expect(killed).toBe(false);
  });

  it("cleans up state without killing a live process that has a different identity", async () => {
    stashEnv();
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      env: { ...process.env },
    });
    try {
      expect(live.pid).toBeDefined();
      const pid = live.pid!;
      await delay(50);
      const ownerPid = 91_031;
      const { runId, statePath } = await allocateRun(ownerPid);
      allocatedOwnerPids.push(ownerPid);
      await writeState(
        fakeHandle({
          proxyUrl: "http://127.0.0.1:7010",
          controlUrl: "http://127.0.0.1:7011",
          pid,
          instanceId: "not-the-live-process",
          exePath: process.execPath,
        }),
        runId,
      );
      if (process.platform !== "win32") {
        expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      }
      const killed = await stopOwnedProxy(await readState());
      expect(killed).toBe(false);
      expect(pidExists(pid)).toBe(true);
      await deleteState();
      await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(pidExists(pid)).toBe(true);
    } finally {
      if (live.pid && pidExists(live.pid)) {
        try {
          live.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  it("does not recursively delete a custom state file parent directory", async () => {
    stashEnv();
    const { mkdtemp, writeFile: write, readFile: read } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "llmentary-jest-custom-"));
    const custom = join(dir, "state.json");
    const sibling = join(dir, "keep-me.txt");
    await write(sibling, "keep\n");
    process.env.LLMENTARY_JEST_STATE_FILE = custom;
    process.env.LLMENTARY_JEST_RUN_ID = "custom-run";
    await writeState(fakeHandle({ proxyUrl: "http://127.0.0.1:1", controlUrl: "http://127.0.0.1:2" }), "custom-run");
    await deleteState();
    expect(await read(sibling, "utf8")).toBe("keep\n");
  });

  it("does not chmod the parent of a custom state file", async () => {
    stashEnv();
    const { mkdtemp } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "llmentary-jest-custom-mode-"));
    const custom = join(dir, "state.json");
    await chmod(dir, 0o755);
    process.env.LLMENTARY_JEST_STATE_FILE = custom;
    process.env.LLMENTARY_JEST_RUN_ID = "custom-mode-run";
    await writeState(fakeHandle({ proxyUrl: "http://127.0.0.1:1", controlUrl: "http://127.0.0.1:2" }), "custom-mode-run");
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
      expect((await stat(custom)).mode & 0o777).toBe(0o600);
    }
  });

  it("resolves the run id from the owner pointer when env is empty", async () => {
    stashEnv();
    const { runId } = await allocateRun(process.pid);
    allocatedOwnerPids.push(process.pid);
    delete process.env.LLMENTARY_JEST_RUN_ID;
    delete process.env.LLMENTARY_JEST_STATE_FILE;
    await expect(resolveRunId()).resolves.toBe(runId);
  });

  it("throws when no env run id or pointer exists", async () => {
    stashEnv();
    await expect(resolveRunId()).rejects.toThrow(/Jest run id is missing/);
  });

  it("does not invent an identity without pid and instance id", async () => {
    expect(identityFromState({ runId: "r", proxyUrl: "http://127.0.0.1:1", controlUrl: "http://127.0.0.1:2" })).toBeUndefined();
    expect(
      identityFromState({
        runId: "r",
        proxyUrl: "http://127.0.0.1:1",
        controlUrl: "http://127.0.0.1:2",
        pid: 9,
        instanceId: "only-id",
      }),
    ).toEqual({ pid: 9, instanceId: "only-id" });
    await expect(
      stopOwnedProxy({ runId: "r", proxyUrl: "http://127.0.0.1:1", controlUrl: "http://127.0.0.1:2" }),
    ).resolves.toBe(false);
  });

  it("resolves the owner pid from env, worker id, and argv", () => {
    stashEnv();
    process.env.LLMENTARY_JEST_OWNER_PID = "91";
    expect(jestOwnerPid()).toBe(91);
    delete process.env.LLMENTARY_JEST_OWNER_PID;
    const previousWorker = process.env.JEST_WORKER_ID;
    process.env.JEST_WORKER_ID = "1";
    expect(jestOwnerPid()).toBe(process.ppid);
    delete process.env.JEST_WORKER_ID;
    const argv = process.argv.slice();
    process.argv.push("jest");
    try {
      expect(jestOwnerPid()).toBe(process.pid);
    } finally {
      process.argv.length = 0;
      process.argv.push(...argv);
      if (previousWorker === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previousWorker;
    }
  });

  it("reads currentRunId from the owner pointer and throws when missing", async () => {
    stashEnv();
    const { runId } = await allocateRun(process.pid);
    allocatedOwnerPids.push(process.pid);
    delete process.env.LLMENTARY_JEST_RUN_ID;
    expect(currentRunId()).toBe(runId);
    await deleteState();
    delete process.env.LLMENTARY_JEST_RUN_ID;
    expect(() => currentRunId()).toThrow(/Jest run id is missing/);
  });

  it("chmod 0600 wins even if the file previously existed world-readable", async () => {
    stashEnv();
    const ownerPid = 91_021;
    const { runId, statePath } = await allocateRun(ownerPid);
    allocatedOwnerPids.push(ownerPid);
    await writeState(fakeHandle({ proxyUrl: "http://127.0.0.1:1", controlUrl: "http://127.0.0.1:2" }), runId);
    await chmod(statePath, 0o644);
    await writeState(fakeHandle({ proxyUrl: "http://127.0.0.1:1", controlUrl: "http://127.0.0.1:2" }), runId);
    if (process.platform !== "win32") {
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    }
  });
});

function stashEnv(): void {
  for (const key of KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
}

function fakeHandle(overrides: Partial<ProxyHandle> & { proxyUrl: string; controlUrl: string }): ProxyHandle {
  return {
    stop: async () => undefined,
    ...overrides,
  };
}
