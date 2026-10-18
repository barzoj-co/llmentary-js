import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { pidExists, processMatchesIdentity, stopProcessIfMatches } from "../src/process.js";

const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
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
});

function spawnUnrelated(extraEnv: NodeJS.ProcessEnv = {}): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, ...extraEnv },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}
