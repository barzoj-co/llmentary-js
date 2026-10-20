import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ControlClient, startProxy, type ProxyHandle } from "../src/index.js";

interface EchoHit {
  url: string;
}

const JOIN_TABLE: Array<{
  name: string;
  upstreamPath: string;
  clientPath: string;
  expectedPath: string;
}> = [
  { name: "base /v1 + client /v1", upstreamPath: "/v1", clientPath: "/v1/chat/completions", expectedPath: "/v1/chat/completions" },
  { name: "base / + client /v1", upstreamPath: "", clientPath: "/v1/chat/completions", expectedPath: "/v1/chat/completions" },
  {
    name: "base /api/v1 + client /v1",
    upstreamPath: "/api/v1",
    clientPath: "/v1/chat/completions",
    expectedPath: "/api/v1/chat/completions",
  },
  {
    name: "base /api/v1 + /u/openai without extra /v1",
    upstreamPath: "/api/v1",
    clientPath: "/u/openai/chat/completions",
    expectedPath: "/api/v1/chat/completions",
  },
  {
    name: "base /openai/v1 + client /v1/responses",
    upstreamPath: "/openai/v1",
    clientPath: "/v1/responses",
    expectedPath: "/openai/v1/responses",
  },
  {
    name: "base /v1 + /u/openai/v1",
    upstreamPath: "/v1",
    clientPath: "/u/openai/v1/chat/completions",
    expectedPath: "/v1/chat/completions",
  },
];

describe("proxy owns upstream join (no client /v1 strip)", () => {
  const handles: Array<{ stop(): Promise<void> }> = [];
  const previousProxyUrl = process.env.LLMENTARY_PROXY_URL;
  const previousControlUrl = process.env.LLMENTARY_CONTROL_URL;

  afterEach(async () => {
    while (handles.length) {
      await handles.pop()?.stop();
    }
    if (previousProxyUrl === undefined) delete process.env.LLMENTARY_PROXY_URL;
    else process.env.LLMENTARY_PROXY_URL = previousProxyUrl;
    if (previousControlUrl === undefined) delete process.env.LLMENTARY_CONTROL_URL;
    else process.env.LLMENTARY_CONTROL_URL = previousControlUrl;
  });

  it.each(JOIN_TABLE)("$name", async (row) => {
    requireProxyBin();
    delete process.env.LLMENTARY_PROXY_URL;
    delete process.env.LLMENTARY_CONTROL_URL;
    const echo = await startEchoUpstream();
    handles.push(echo);
    const proxy = await startProxy({
      upstreams: `openai=${echo.url}${row.upstreamPath}`,
      healthTimeoutMs: 15_000,
    });
    handles.push(proxy);
    echo.hits.length = 0;
    const response = await fetch(`${proxy.proxyUrl}${row.clientPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "ping" }] }),
    });
    expect(response.status).toBeLessThan(500);
    expect(echo.hits[0]?.url.split("?")[0]).toBe(row.expectedPath);
  });

  it("starts with no upstream setting and /config shows the default openai /v1", async () => {
    requireProxyBin();
    delete process.env.LLMENTARY_PROXY_URL;
    delete process.env.LLMENTARY_CONTROL_URL;
    delete process.env.LLMENTARY_UPSTREAMS;
    delete process.env.LLMENTARY_UPSTREAM_BASE_URL;
    const proxy = await startProxy({ healthTimeoutMs: 15_000 });
    handles.push(proxy);
    const config = await new ControlClient({ controlUrl: proxy.controlUrl }).getConfig();
    const serialized = JSON.stringify(config.raw);
    expect(serialized).toMatch(/api\.openai\.com/);
    expect(serialized).toMatch(/\/v1/);
    expect(config.version).toEqual(expect.any(String));
  });

  it("does not use OPENAI_BASE_URL as the upstream when starting the proxy", async () => {
    requireProxyBin();
    delete process.env.LLMENTARY_PROXY_URL;
    delete process.env.LLMENTARY_CONTROL_URL;
    delete process.env.LLMENTARY_UPSTREAMS;
    delete process.env.LLMENTARY_UPSTREAM_BASE_URL;
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
    let proxy: ProxyHandle | undefined;
    try {
      proxy = await startProxy({ healthTimeoutMs: 15_000 });
      handles.push(proxy);
      const config = await new ControlClient({ controlUrl: proxy.controlUrl }).getConfig();
      const serialized = JSON.stringify(config.raw);
      expect(serialized).toMatch(/api\.openai\.com/);
      expect(serialized).not.toMatch(/127\.0\.0\.1:9/);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
    }
  });
});

function requireProxyBin(): void {
  if (!process.env.LLMENTARY_BIN) {
    throw new Error(
      "LLMENTARY_BIN is required. CI must build the Go proxy from barzoj-co/llmentary and point LLMENTARY_BIN at it.",
    );
  }
}

async function startEchoUpstream(): Promise<{ url: string; hits: EchoHit[]; stop(): Promise<void> }> {
  const hits: EchoHit[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    hits.push({ url: request.url ?? "" });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "echo", object: "chat.completion", choices: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("echo upstream did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
