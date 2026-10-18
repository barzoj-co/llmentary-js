import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLab, startProxy, type ProxyHandle } from "../src/index.js";

describe.skipIf(!process.env.LLMTESTLAB_BIN)("real Go proxy with fake upstream", () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = await startFakeUpstream();
    proxy = await startProxy({ upstreamBaseUrl: upstream.url });
    process.env.LLMTESTLAB_PROXY_URL = proxy.proxyUrl;
    process.env.LLMTESTLAB_CONTROL_URL = proxy.controlUrl;
  });

  afterAll(async () => {
    await proxy.stop();
    await upstream.stop();
  });

  it("records Chat Completions tool calls", async () => {
    const lab = createLab();
    const response = await lab.fetch(`${lab.baseURL}/chat/completions`, {
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

    await expect(lab.expect().toolCalled("lookup_weather", { argsSubset: { city: "Amsterdam" } })).resolves.toMatchObject({
      pass: true,
    });
    await lab.cleanup();
  });

  it("records Responses function calls", async () => {
    const lab = createLab();
    const response = await lab.fetch(`${lab.baseURL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-mini", input: "weather in Rotterdam" }),
    });
    expect(response.ok).toBe(true);

    await expect(lab.query({ apiType: "responses" }).expect().toolCalled("lookup_weather")).resolves.toMatchObject({
      pass: true,
    });
    await lab.cleanup();
  });
});

async function startFakeUpstream(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/chat/completions") {
      await handleChat(request, response);
      return;
    }
    if (request.url === "/v1/responses") {
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
