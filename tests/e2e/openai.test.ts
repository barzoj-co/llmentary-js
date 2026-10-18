import { afterAll, beforeAll, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { createLab, startProxy, type ProxyHandle } from "../../src/index.js";

describe("OpenAI E2E through llm-test-lab", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for OpenAI E2E tests on push and non-fork PRs.");
    }
    if (!process.env.LLMTESTLAB_BIN && !process.env.LLMTESTLAB_PROXY_URL) {
      throw new Error("LLMTESTLAB_BIN is required so E2E traffic goes through the real Go proxy.");
    }
    proxy = await startProxy({
      upstreamBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      healthTimeoutMs: 20_000,
    });
    process.env.LLMTESTLAB_PROXY_URL = proxy.proxyUrl;
    process.env.LLMTESTLAB_CONTROL_URL = proxy.controlUrl;
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    delete process.env.LLMTESTLAB_PROXY_URL;
    delete process.env.LLMTESTLAB_CONTROL_URL;
  });

  it("records Chat Completions tool flow", async () => {
    const lab = createLab({ defaultWait: { timeoutMs: 30_000, idleMs: 250 } });
    const client = new OpenAI(lab.openAI());
    const first = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 32,
      messages: [{ role: "user", content: "Use the tool to get weather for Amsterdam." }],
      tools: [weatherToolChat()],
      tool_choice: { type: "function", function: { name: "lookup_weather" } },
    });
    const toolCall = first.choices[0]?.message.tool_calls?.[0];
    expect(toolCall && "function" in toolCall ? toolCall.function.name : undefined).toBe("lookup_weather");
    await client.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 32,
      messages: [
        { role: "user", content: "Use the tool to get weather for Amsterdam." },
        first.choices[0]?.message ?? { role: "assistant", content: "" },
        { role: "tool", tool_call_id: toolCall?.id ?? "missing", content: "sunny" },
      ],
    });

    await lab.expect().toolCalled("lookup_weather");
    await lab.expect().toolResultFedBack("lookup_weather");
    await lab.expect().model("gpt-4.1-mini");
    await lab.cleanup();
  }, 60_000);

  it("records Responses tool flow", async () => {
    const lab = createLab({ defaultWait: { timeoutMs: 30_000, idleMs: 250 } });
    const client = new OpenAI(lab.openAI());
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 32,
      input: "Use the tool to get weather for Rotterdam.",
      tools: [weatherToolResponses()],
      tool_choice: { type: "function", name: "lookup_weather" },
    });
    const functionCall = response.output.find((item) => item.type === "function_call");
    expect(functionCall?.type).toBe("function_call");

    await client.responses.create({
      previous_response_id: response.id,
      input: [
        {
          type: "function_call_output",
          call_id: functionCall && "call_id" in functionCall ? functionCall.call_id : "missing",
          output: "rainy",
        },
      ],
    });

    await lab.query({ apiType: "responses" }).expect().toolCalled("lookup_weather");
    await lab.query({ apiType: "responses" }).expect().toolResultFedBack("lookup_weather");
    await lab.cleanup();
  }, 60_000);
});

function weatherToolChat(): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "lookup_weather",
      description: "Look up deterministic test weather.",
      strict: true,
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  };
}

function weatherToolResponses(): OpenAI.Responses.Tool {
  return {
    type: "function",
    name: "lookup_weather",
    description: "Look up deterministic test weather.",
    strict: true,
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  };
}
