import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatUpstreamSpec,
  looksLikeLlmentaryProxy,
  originForGoUpstream,
  redactArgs,
  resolveUpstreamSpec,
  startProxy,
  waitForHealth,
} from "../src/proxy.js";

const FAKE_PROXY = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "fake-proxy.mjs");

const envKeys = [
  "LLMENTARY_PROXY_URL",
  "LLMENTARY_CONTROL_URL",
  "LLMENTARY_BEARER_TOKEN",
  "LLMENTARY_CONTROL_TOKEN",
  "LLMENTARY_PROXY_START_ARGS",
  "LLMENTARY_UPSTREAMS",
  "LLMENTARY_UPSTREAM_NAME",
  "LLMENTARY_UPSTREAM_BASE_URL",
  "LLMENTARY_HOST",
] as const;
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

  it("matches a proxy origin even without a /s/ session path", () => {
    expect(
      looksLikeLlmentaryProxy("http://127.0.0.1:4010/v1", { LLMENTARY_PROXY_URL: "http://127.0.0.1:4010" }),
    ).toBe(true);
    expect(
      looksLikeLlmentaryProxy("http://127.0.0.1:9/v1", { LLMENTARY_PROXY_URL: "http://127.0.0.1:4010" }),
    ).toBe(false);
  });
});

describe("upstream helpers", () => {
  it("keeps a name=url spec only when the name and URL look valid", () => {
    expect(formatUpstreamSpec("openai", "custom=https://example.test/v1")).toBe("custom=https://example.test/v1");
    expect(formatUpstreamSpec("openai", "bad name=https://example.test/v1")).toBe(
      "openai=bad name=https://example.test/v1",
    );
    expect(formatUpstreamSpec("openai", "custom=not-a-url")).toBe("openai=custom=not-a-url");
  });

  it("redacts only when a secret flag has a following value", () => {
    expect(redactArgs(["-control-token"])).toEqual(["-control-token"]);
    expect(redactArgs(["--bearer-token"])).toEqual(["--bearer-token"]);
    expect(redactArgs(["--control-token=secret"])).toEqual(["--control-token=***"]);
  });

  it("falls back to string stripping when originForGoUpstream cannot parse a URL", () => {
    expect(originForGoUpstream("not a url/v1/")).toBe("not a url");
    expect(originForGoUpstream("http://[bad")).toBe("http://[bad");
  });

  it("prefers explicit upstreams over a base URL and keeps env overrides", () => {
    expect(
      resolveUpstreamSpec({
        upstreams: "  custom=https://example.test/v1  ",
        upstreamBaseUrl: "https://ignored.test/v1",
        upstreamName: "ignored",
      }),
    ).toBe("custom=https://example.test/v1");
    expect(
      resolveUpstreamSpec({
        env: { LLMENTARY_UPSTREAM_NAME: "openrouter", LLMENTARY_UPSTREAM_BASE_URL: "https://openrouter.ai/api/v1" },
      }),
    ).toBe("openrouter=https://openrouter.ai/api/v1");
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
    ).rejects.toThrow(/Failed to start llmentary proxy[\s\S]*exited before becoming healthy/);
  });

  it("attaches without a bearer token when the caller omitted one", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    stash("LLMENTARY_BEARER_TOKEN", undefined);
    stash("LLMENTARY_CONTROL_TOKEN", undefined);
    const health = await serveHealth();
    const handle = await startProxy({
      proxyUrl: health.url,
      healthTimeoutMs: 2_000,
    });
    expect(handle.bearerToken).toBeUndefined();
    expect(handle.proxyUrl).toBe(health.url);
    expect(handle.controlUrl).toBe(health.url);
    await handle.stop();
  });
});

describe("startProxy launch with a fake binary", () => {
  const previousStartArgs = process.env.LLMENTARY_PROXY_START_ARGS;

  afterEach(() => {
    if (previousStartArgs === undefined) delete process.env.LLMENTARY_PROXY_START_ARGS;
    else process.env.LLMENTARY_PROXY_START_ARGS = previousStartArgs;
  });

  it("detects CLI flags from -h and starts until /healthz answers", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    stash("LLMENTARY_BEARER_TOKEN", undefined);
    stash("LLMENTARY_CONTROL_TOKEN", undefined);
    const logs: string[] = [];
    const handle = await startProxy({
      binaryPath: FAKE_PROXY,
      host: "127.0.0.1",
      upstreams: "openai=https://example.test/v1",
      bearerToken: "proxy-secret",
      healthTimeoutMs: 4_000,
      log: (line) => logs.push(line),
    });
    try {
      expect(handle.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.controlUrl).not.toBe(handle.proxyUrl);
      expect(handle.bearerToken).toBe("proxy-secret");
      expect(handle.pid).toBeTypeOf("number");
      expect(handle.instanceId).toBeTruthy();
      expect(logs.some((line) => line.includes("fake-proxy"))).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it("uses quoted LLMENTARY_PROXY_START_ARGS without help detection", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    const reserved = await reservePorts(2);
    const listenPort = reserved[0]!;
    const controlPort = reserved[1]!;
    process.env.LLMENTARY_PROXY_START_ARGS = `-listen 127.0.0.1:${listenPort} -control '127.0.0.1:${controlPort}'`;
    const handle = await startProxy({
      binaryPath: FAKE_PROXY,
      port: listenPort,
      controlPort,
      healthTimeoutMs: 4_000,
    });
    try {
      expect(handle.controlUrl).toBe(`http://127.0.0.1:${controlPort}`);
    } finally {
      await handle.stop();
    }
  });

  it("falls back to canonical flags when help output is empty", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    const handle = await startProxy({
      binaryPath: FAKE_PROXY,
      healthTimeoutMs: 4_000,
      env: { FAKE_PROXY_NO_HELP: "1" },
    });
    try {
      expect(handle.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await handle.stop();
    }
  });

  it("kills a hung -h probe and still starts from canonical flags", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    const handle = await startProxy({
      binaryPath: FAKE_PROXY,
      healthTimeoutMs: 6_000,
      env: { FAKE_PROXY_HANG_HELP: "1" },
    });
    try {
      expect(handle.pid).toBeTypeOf("number");
    } finally {
      await handle.stop();
    }
  });

  it("starts from extraArgs that ignore SIGTERM and still stop via SIGKILL", async () => {
    stash("LLMENTARY_PROXY_URL", undefined);
    stash("LLMENTARY_CONTROL_URL", undefined);
    const handle = await startProxy({
      binaryPath: process.execPath,
      args: [FAKE_PROXY],
      healthTimeoutMs: 4_000,
      env: { FAKE_PROXY_IGNORE_TERM: "1" },
    });
    expect(handle.pid).toBeTypeOf("number");
    await handle.stop();
  });
});

async function reservePorts(count: number): Promise<number[]> {
  const { createServer } = await import("node:net");
  const servers: ReturnType<typeof createServer>[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("no port"));
            return;
          }
          servers.push(server);
          resolve(address.port);
        });
      });
      ports.push(port);
    }
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
  return ports;
}

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
