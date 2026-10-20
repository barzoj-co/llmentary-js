import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlClient, SessionNotFound, llmentary, startProxy, type ProxyHandle, type Session } from "../src/index.js";

describe("real Go proxy with fake upstream", () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    if (!process.env.LLMENTARY_BIN) {
      throw new Error(
        "LLMENTARY_BIN is required. CI must build the Go proxy from barzoj-co/llmentary and point LLMENTARY_BIN at it.",
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
    expect(config.version).toEqual(expect.any(String));
    expect(config.version?.length).toBeGreaterThan(0);
    expect(await lm.proxyVersion()).toBe(config.version);
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

  it("reads spec violations from a request with an unknown field", async () => {
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
    await lm.expect().noSpecViolations({ ignorePaths: ["/foo"] });
    await lm.cleanup();
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
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      id: "chatcmpl_fake",
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_fake",
                type: "function",
                function: { name: "lookup_weather", arguments: '{"city":"Amsterdam"}' },
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
