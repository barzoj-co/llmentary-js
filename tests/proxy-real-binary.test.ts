import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import OpenAI from "openai";
import {
  ControlClient,
  SessionNotFound,
  llmentary,
  openapiSha256,
  packagedMatchesServed,
  stampOpenAPI,
  startProxy,
  type ProxyHandle,
  type Session,
} from "../src/index.js";

const proxyPin = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "PROXY_VERSION"), "utf8").trim();

describe("real Go proxy with fake upstream", () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    if (!process.env.LLMENTARY_BIN) {
      throw new Error(
        "LLMENTARY_BIN is required. CI must install the released PROXY_VERSION binary from barzoj-co/llmentary and point LLMENTARY_BIN at it.",
      );
    }
    upstream = await startFakeUpstream();
    proxy = await startProxy({ upstreamBaseUrl: upstream.url });
    process.env.LLMENTARY_PROXY_URL = proxy.proxyUrl;
    process.env.LLMENTARY_CONTROL_URL = proxy.controlUrl;
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.stop();
    delete process.env.LLMENTARY_PROXY_URL;
    delete process.env.LLMENTARY_CONTROL_URL;
  });

  it("reports bundled proxy --version 0.5.0", () => {
    expect(proxyPin).toBe("v0.5.0");
    const version = proxyPin.replace(/^v/, "");
    const out = execFileSync(process.env.LLMENTARY_BIN!, ["--version"], { encoding: "utf8" });
    expect(out).toMatch(new RegExp(`^llmentary ${version.replaceAll(".", "\\.")} \\([0-9a-f]+`));
  });

  it("matches GET /openapi.yaml to the packaged contract after stamp-then-sha256", async () => {
    const bin = process.env.LLMENTARY_BIN!;
    const packagedPath = [join(dirname(bin), "openapi.yaml"), join(dirname(bin), "..", "openapi.yaml")].find((path) =>
      existsSync(path),
    );
    expect(packagedPath).toBeDefined();
    const packaged = readFileSync(packagedPath!, "utf8");
    const client = new ControlClient({
      controlUrl: proxy.controlUrl,
      ...(proxy.bearerToken ? { bearerToken: proxy.bearerToken } : {}),
    });
    const served = await client.openapi();
    expect(served).toMatch(/openapi:\s*['"]?3\./);
    expect(Buffer.byteLength(packaged)).toBeGreaterThanOrEqual(Buffer.byteLength(served));
    expect(stampOpenAPI(packaged)).toBe(served);
    expect(packagedMatchesServed(packaged, served)).toBe(true);
    expect(openapiSha256(stampOpenAPI(packaged))).toBe(openapiSha256(served));
  });

  it("honours wait quiet=100ms after one finished call", async () => {
    const lm = llmentary();
    const response = await lm.fetch(`${lm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "weather in Amsterdam" }],
        tools: [
          {
            type: "function",
            function: { name: "lookup_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
          },
        ],
      }),
    });
    expect(response.ok).toBe(true);
    const shortStarted = Date.now();
    const trace = await lm.wait({ quiet: "100ms" });
    const shortElapsed = Date.now() - shortStarted;
    expect(shortElapsed).toBeGreaterThanOrEqual(100);
    const longStarted = Date.now();
    await lm.wait({ quiet: "1s" });
    const longElapsed = Date.now() - longStarted;
    expect(shortElapsed).toBeLessThan(longElapsed / 2);
    expect(trace.calls.length).toBeGreaterThanOrEqual(1);
    await lm.cleanup();
  });

  it("records Chat Completions tool calls", async () => {
    const lm = llmentary();
    const response = await lm.fetch(`${lm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "weather in Amsterdam" }],
        tools: [
          {
            type: "function",
            function: { name: "lookup_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
          },
        ],
      }),
    });
    expect(response.ok).toBe(true);

    await expect(lm.expect().toolCalled("lookup_weather", { argsSubset: { city: "Amsterdam" } })).resolves.toMatchObject({
      pass: true,
    });
    await lm.cleanup();
  });

  it("records streaming Chat Completions", async () => {
    const lm = llmentary();
    const response = await lm.fetch(`${lm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        stream: true,
        messages: [{ role: "user", content: "stream hello" }],
      }),
    });
    expect(response.ok).toBe(true);
    await response.text();
    await expect(lm.expect().responseContains("hello-stream")).resolves.toMatchObject({ pass: true });
    await lm.cleanup();
  });

  it("records a mid-stream error", async () => {
    const lm = llmentary();
    const response = await lm.fetch(`${lm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fake-mode": "mid-stream-error" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        stream: true,
        messages: [{ role: "user", content: "explode" }],
      }),
    });
    await response.text().catch(() => undefined);
    await expect(lm.expect().midStreamError(/boom|error/i)).resolves.toMatchObject({ pass: true });
    await lm.cleanup();
  });

  it("records Responses function calls", async () => {
    const lm = llmentary();
    const response = await lm.fetch(`${lm.baseURL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-mini", input: "weather in Rotterdam" }),
    });
    expect(response.ok).toBe(true);

    await expect(lm.query({ apiType: "responses" }).expect().toolCalled("lookup_weather")).resolves.toMatchObject({
      pass: true,
    });
    await lm.cleanup();
  });

  it("lists sessions, returns SessionNotFound, and exposes proxy version", async () => {
    const lm = llmentary();
    await postChat(lm);
    const sessions = await lm.listSessions();
    expect(sessions.some((session) => session.id === lm.sessionId)).toBe(true);
    const control = new ControlClient({ controlUrl: proxy.controlUrl });
    await expect(control.getSession("nope-never-created")).rejects.toBeInstanceOf(SessionNotFound);
    await expect(control.getSession("nope-never-created")).rejects.toThrow(/no calls recorded for session "nope-never-created"/);
    const listed = await control.listSessions();
    expect(listed.some((session) => session.id === "nope-never-created")).toBe(false);
    const config = await control.getConfig();
    expect(config.version).toMatch(/^0\.5\.0/);
    expect(config.upstreamHeaderTimeout).toBe("0s");
    expect(config.upstreamIdleTimeout).toBe("0s");
    expect(config.specTargets).toEqual(expect.objectContaining({ openai: "openai-compatible" }));
    expect(await lm.proxyVersion()).toBe(config.version);
    const settled = await control.getSession(lm.sessionId);
    expect(settled.inFlight).toBeUndefined();
    const withFlight = await control.getSession(lm.sessionId, { include: "in_flight" });
    expect(Array.isArray(withFlight.inFlight)).toBe(true);
    expect(withFlight.calls.length).toBeGreaterThanOrEqual(1);
    expect(withFlight.calls[0]?.validation?.target).toBe("openai-compatible");
    expect(withFlight.calls[0]?.upstreamCalled).toBe(true);
    expect(withFlight.calls[0]?.errorSource).toBeUndefined();
    await lm.cleanup();
  });

  it("waits until minCalls finished calls arrive", async () => {
    const lm = llmentary();
    const pending = lm.wait({ minCalls: 2, timeout: 8, quiet: "50ms" });
    await delay(150);
    await postChat(lm);
    await delay(150);
    await postChat(lm, { stream: true });
    const trace = await pending;
    expect(trace.calls.length).toBeGreaterThanOrEqual(2);
    await lm.cleanup();
  });

  it("fails expect helpers on zero calls with the session id and known ids", async () => {
    const known = llmentary();
    await postChat(known);
    const empty = llmentary({ defaultWait: { timeout: "2s", quiet: "50ms" } });
    await expect(empty.expect().toolCalled("nope")).rejects.toThrow(
      new RegExp(`no calls recorded for session ${empty.sessionId}`),
    );
    try {
      await empty.expect().toolCalled("nope");
    } catch (error) {
      expect(String(error)).toContain(known.sessionId);
    }
    await known.cleanup();
    await empty.cleanup();
  });

  it("treats unknown fields as vendor extras on the default compatible target", async () => {
    const lm = llmentary();
    const response = await lm.fetch(`${lm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        foo: 1,
        messages: [{ role: "user", content: "weather in Amsterdam" }],
      }),
    });
    expect(response.ok).toBe(true);
    await expect(lm.expect().noSpecViolations({ side: "request" })).resolves.toMatchObject({ pass: true });
    const ignored = await lm.expect().soft().noIgnoredFields();
    expect(ignored.pass).toBe(false);
    expect(ignored.message).toMatch(/foo|vendor_field/);
    const trace = await lm.session();
    expect(trace.calls[0]?.validation?.target).toBe("openai-compatible");
    expect(trace.calls[0]?.ignoredFields?.some((field) => field.kind === "vendor_field" && field.path === "foo")).toBe(
      true,
    );
    expect(trace.calls[0]?.specViolations?.some((violation) => violation.pointer === "/foo")).toBeFalsy();
    await lm.cleanup();
  });

  it("still records spec violations when the upstream target is openai", async () => {
    const previousProxy = process.env.LLMENTARY_PROXY_URL;
    const previousControl = process.env.LLMENTARY_CONTROL_URL;
    delete process.env.LLMENTARY_PROXY_URL;
    delete process.env.LLMENTARY_CONTROL_URL;
    const openaiProxy = await startProxy({
      upstreamBaseUrl: upstream.url,
      specTargets: "openai=openai",
    });
    try {
      process.env.LLMENTARY_PROXY_URL = openaiProxy.proxyUrl;
      process.env.LLMENTARY_CONTROL_URL = openaiProxy.controlUrl;
      const lm = llmentary();
      const response = await lm.fetch(`${lm.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          foo: 1,
          messages: [{ role: "user", content: "weather in Amsterdam" }],
        }),
      });
      expect(response.ok).toBe(true);
      const failed = await lm.expect().soft().noSpecViolations();
      expect(failed.pass).toBe(false);
      expect(failed.message).toMatch(/foo/);
      expect(failed.message).toMatch(/unevaluatedProperties|request/);
      const config = await new ControlClient({ controlUrl: openaiProxy.controlUrl }).getConfig();
      expect(config.specTargets).toEqual(expect.objectContaining({ openai: "openai" }));
      await lm.expect().noSpecViolations({ side: "request", ignorePaths: ["/foo"] });
      await lm.cleanup();
    } finally {
      await openaiProxy.stop();
      if (previousProxy === undefined) delete process.env.LLMENTARY_PROXY_URL;
      else process.env.LLMENTARY_PROXY_URL = previousProxy;
      if (previousControl === undefined) delete process.env.LLMENTARY_CONTROL_URL;
      else process.env.LLMENTARY_CONTROL_URL = previousControl;
    }
  });

  it("records streaming Responses", async () => {
    const lm = llmentary();
    const response = await lm.fetch(`${lm.baseURL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-mini", stream: true, input: "stream responses" }),
    });
    expect(response.ok).toBe(true);
    await response.text();
    await expect(lm.query({ apiType: "responses" }).expect().responseContains("hello-stream")).resolves.toMatchObject({
      pass: true,
    });
    await lm.cleanup();
  });

  it("attributes an unmodified OpenAI client constructed before the session via pathBaseURL", async () => {
    const sessionId = randomUUID();
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = `${proxy.proxyUrl}/s/${encodeURIComponent(sessionId)}/v1`;
    const openai = new OpenAI({ apiKey: "llmentary" });
    const lm = llmentary({
      sessionId,
      proxyUrl: proxy.proxyUrl,
      controlUrl: proxy.controlUrl,
    });
    expect(lm.pathBaseURL()).toBe(process.env.OPENAI_BASE_URL);
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "path-session ping" }],
      });
      expect(response.model).toBe("gpt-4.1-mini");
      await lm.expect().callCount(1);
      await lm.expect().promptContains("path-session ping");
      const sessions = await lm.listSessions();
      expect(sessions.some((session) => session.id === sessionId && session.calls >= 1)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
      await lm.cleanup();
    }
  });

  it("scopes mark/since to the second turn of two calls", async () => {
    const lm = llmentary();
    await postChat(lm, { messages: [{ role: "user", content: "turn-1-a" }] });
    await postChat(lm, { messages: [{ role: "user", content: "turn-1-b" }] });
    const mark = await lm.mark();
    expect(mark).toBe(2);
    await postChat(lm, {
      messages: [{ role: "user", content: "turn-2-a" }],
      tools: [{ type: "function", function: { name: "lookup_time", parameters: { type: "object", properties: {} } } }],
    });
    await postChat(lm, {
      messages: [{ role: "user", content: "turn-2-b" }],
      tools: [{ type: "function", function: { name: "lookup_time", parameters: { type: "object", properties: {} } } }],
    });
    await lm.expect({ since: mark }).callCount(2);
    await lm.expect({ since: mark }).promptContains("turn-2-a");
    await expect(lm.expect({ since: mark }).soft().promptContains("turn-1-a")).resolves.toMatchObject({ pass: false });
    await lm.query({ since: mark, offersTool: "lookup_time" }).expect().callCount(2);
    await lm.expect({ since: mark }).notCalled("lookup_weather");
    const summary = (await lm.wait()).calls.length;
    expect(summary).toBe(4);
    await lm.cleanup();
  });
});

async function postChat(lm: Session, extra: Record<string, unknown> = {}): Promise<Response> {
  const response = await lm.fetch(`${lm.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "weather in Amsterdam" }],
      tools: [
        {
          type: "function",
          function: { name: "lookup_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
        },
      ],
      ...extra,
    }),
  });
  if (extra.stream === true) await response.text();
  return response;
}

async function startFakeUpstream(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (url.includes("chat/completions")) {
      await handleChat(request, response);
      return;
    }
    if (url.includes("responses")) {
      await handleResponses(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake upstream did not bind to TCP");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  if (request.headers["x-fake-mode"] === "mid-stream-error") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl_stream","choices":[{"delta":{"content":"partial"}}]}\n\n');
    response.write('data: {"error":{"message":"boom mid-stream"}}\n\n');
    response.end();
    return;
  }
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl_stream", model: body.model, choices: [{ delta: { content: "hello-stream" } }] })}\n\n`,
    );
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  const offered =
    Array.isArray(body.tools) && body.tools[0] && typeof body.tools[0] === "object"
      ? ((body.tools[0] as { function?: { name?: string }; name?: string }).function?.name ??
        (body.tools[0] as { name?: string }).name)
      : undefined;
  const toolName = offered || "lookup_weather";
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      id: "chatcmpl_fake",
      object: "chat.completion",
      created: 1_700_000_000,
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_fake",
                type: "function",
                function: { name: toolName, arguments: '{"city":"Amsterdam"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }),
  );
}

async function handleResponses(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello-stream" })}\n\n`,
    );
    response.write(`data: ${JSON.stringify({ type: "response.completed", response: { model: body.model, output_text: "hello-stream" } })}\n\n`);
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      id: "resp_fake",
      object: "response",
      model: body.model,
      output: [
        {
          type: "function_call",
          id: "fc_fake",
          call_id: "call_fake",
          name: "lookup_weather",
          arguments: '{"city":"Rotterdam"}',
        },
      ],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }),
  );
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
