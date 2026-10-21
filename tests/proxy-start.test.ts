import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { looksLikeLlmentaryProxy, startProxy, waitForHealth } from "../src/proxy.js";

const envKeys = ["LLMENTARY_PROXY_URL", "LLMENTARY_CONTROL_URL", "LLMENTARY_BEARER_TOKEN", "LLMENTARY_CONTROL_TOKEN"] as const;
const previous: Record<string, string | undefined> = {};
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const key of envKeys) {
    if (!(key in previous)) continue;
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
    delete previous[key];
  }
  while (servers.length) {
    await servers.pop()?.close();
  }
});

function stash(key: (typeof envKeys)[number], value: string | undefined): void {
  if (!(key in previous)) previous[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function serveHealth(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}`;
  const handle = {
    url,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(handle);
  return handle;
}

describe("looksLikeLlmentaryProxy", () => {
  it("returns false for invalid URLs", () => {
    expect(looksLikeLlmentaryProxy("not a url")).toBe(false);
  });
});

describe("startProxy attach and launch failures", () => {
  it("attaches to an already-running control URL without spawning", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    const health = await serveHealth();
    const handle = await startProxy({
      proxyUrl: `${health.url}/`,
      controlUrl: `${health.url}/`,
      bearerToken: "attach-token",
      healthTimeoutMs: 2_000,
    });
    expect(handle.proxyUrl).toBe(health.url);
    expect(handle.controlUrl).toBe(health.url);
    expect(handle.bearerToken).toBe("attach-token");
    expect(handle.pid).toBeUndefined();
    await handle.stop();
  });

  it("refuses the same listen and control port", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    await expect(
      startProxy({
        binaryPath: process.execPath,
        port: 4010,
        controlPort: 4010,
        healthTimeoutMs: 200,
      }),
    ).rejects.toThrow(/listen port and control port must be different/);
  });

  it("fails when the launched binary exits before /healthz", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    await expect(
      startProxy({
        binaryPath: process.execPath,
        args: ["-e", "process.exit(2)"],
        healthTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/Failed to start llmentary proxy/);
  });
});

describe("waitForHealth", () => {
  it("times out when /healthz never answers", async () => {
    await expect(waitForHealth("http://127.0.0.1:1", undefined, 250)).rejects.toThrow(
      /Timed out waiting for llmentary \/healthz/,
    );
  });

  it("throws when the child exits before becoming healthy", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await expect(waitForHealth("http://127.0.0.1:1", "secret", 1_000, child, ["boom"])).rejects.toThrow(
      /exited before becoming healthy/,
    );
  });
});
