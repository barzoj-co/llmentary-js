const { createServer } = require("node:http");
const { llmentary, startProxy } = require("../../dist/cjs/index.js");

describe("real Go proxy with Jest", () => {
  let upstream;
  let proxy;

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

  test("records a Chat Completions tool call", async () => {
    const lm = llmentary();
    const response = await lm.fetch(`${lm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "weather" }] }),
    });
    expect(response.ok).toBe(true);
    await expect(lm.expect()).toHaveToolCalled("lookup_weather");
    await lm.cleanup();
  }, 30_000);

  test("records streaming Chat Completions", async () => {
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
    await lm.expect().responseContains("hello-stream");
    await lm.cleanup();
  }, 30_000);
});

async function startFakeUpstream() {
  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (!url.includes("chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const body = await readJson(request);
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
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
