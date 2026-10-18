const { createServer } = require("node:http");
const { createLab, startProxy } = require("../../dist/cjs/index.js");

const maybeTest = process.env.LLMTESTLAB_BIN ? test : test.skip;

describe("real Go proxy with Jest", () => {
  let upstream;
  let proxy;

  beforeAll(async () => {
    if (!process.env.LLMTESTLAB_BIN) return;
    upstream = await startFakeUpstream();
    proxy = await startProxy({ upstreamBaseUrl: upstream.url });
    process.env.LLMTESTLAB_PROXY_URL = proxy.proxyUrl;
    process.env.LLMTESTLAB_CONTROL_URL = proxy.controlUrl;
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.stop();
  });

  maybeTest("records a Chat Completions tool call", async () => {
    const lab = createLab();
    const response = await lab.fetch(`${lab.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "weather" }] }),
    });
    expect(response.ok).toBe(true);
    await expect(lab.expect()).toHaveToolCalled("lookup_weather");
    await lab.cleanup();
  }, 30_000);
});

async function startFakeUpstream() {
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
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
