import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control.js";
import { pidExists } from "../src/process.js";

interface Handshake {
  runId: string;
  statePath: string;
  proxyUrl: string;
  controlUrl: string;
  pid?: number;
  instanceId?: string;
  stateMode: number;
  dirMode: number;
}

const children: ChildProcess[] = [];
const logs = new Map<ChildProcess, { stdout: string; stderr: string }>();

afterAll(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

describe("concurrent Jest processes with the real proxy", () => {
  it("isolates two simultaneous Jest runs in the same cwd", async () => {
    if (!process.env.LLMENTARY_BIN) {
      throw new Error(
        "LLMENTARY_BIN is required. CI must install the released PROXY_VERSION binary from barzoj-co/llmentary and point LLMENTARY_BIN at it.",
      );
    }
    const dir = await mkdtemp(join(tmpdir(), "llmentary-jest-concurrent-"));
    const handshakeA = join(dir, "a.json");
    const handshakeB = join(dir, "b.json");
    const stopA = join(dir, "stop-a");
    const stopB = join(dir, "stop-b");
    mkdirSync(dir, { recursive: true });

    const childA = spawnJest(handshakeA, stopA);
    const childB = spawnJest(handshakeB, stopB);
    try {
      const [a, b] = await Promise.all([waitForHandshake(handshakeA, childA), waitForHandshake(handshakeB, childB)]);
      expect(a.runId).not.toBe(b.runId);
      expect(a.statePath).not.toBe(b.statePath);
      expect(a.proxyUrl).not.toBe(b.proxyUrl);
      expect(a.controlUrl).not.toBe(b.controlUrl);
      expect(a.pid).toBeDefined();
      expect(b.pid).toBeDefined();
      expect(a.pid).not.toBe(b.pid);
      expect(a.instanceId).toBeDefined();
      expect(b.instanceId).toBeDefined();
      expect(a.instanceId).not.toBe(b.instanceId);
      if (process.platform !== "win32") {
        expect(a.stateMode).toBe(0o600);
        expect(b.stateMode).toBe(0o600);
        expect(a.dirMode).toBe(0o700);
        expect(b.dirMode).toBe(0o700);
      }

      expect(await new ControlClient({ controlUrl: a.controlUrl }).health()).toBe("ok");
      expect(await new ControlClient({ controlUrl: b.controlUrl }).health()).toBe("ok");

      writeFileSync(stopA, "stop\n");
      const codeA = await waitForExit(childA);
      expect(codeA).toBe(0);
      if (a.pid) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && pidExists(a.pid)) await delay(50);
        expect(pidExists(a.pid)).toBe(false);
      }

      expect(await new ControlClient({ controlUrl: b.controlUrl }).health()).toBe("ok");
      expect(b.pid === undefined ? false : pidExists(b.pid)).toBe(true);

      writeFileSync(stopB, "stop\n");
      const codeB = await waitForExit(childB);
      expect(codeB).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

function spawnJest(handshake: string, stop: string): ChildProcess {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, ["--yes", "jest@30.5.2", "--config", "tests/jest/concurrent.config.cjs", "--runInBand"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LLMENTARY_CONCURRENT_HANDSHAKE: handshake,
      LLMENTARY_CONCURRENT_STOP: stop,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  logs.set(child, { stdout: "", stderr: "" });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const current = logs.get(child);
    if (current) current.stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    const current = logs.get(child);
    if (current) current.stderr += chunk;
  });
  return child;
}

function childLog(child: ChildProcess): string {
  const current = logs.get(child);
  return `${current?.stdout ?? ""}\n${current?.stderr ?? ""}`;
}

async function waitForHandshake(path: string, child: ChildProcess): Promise<Handshake> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Jest concurrent helper exited ${child.exitCode} before handshake.\n${childLog(child)}`);
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Handshake;
      if (parsed.runId && parsed.controlUrl) return parsed;
    } catch {
      // File not written yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for Jest handshake at ${path}.\n${childLog(child)}`);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Jest concurrent helper did not exit.\n${childLog(child)}`));
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
