import { describe, expect, it } from "vitest";
import { AssertionScope, LabAssertionError } from "../src/assertions.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { QueryOptions, SessionTrace } from "../src/types.js";

describe("AssertionScope", () => {
  it("matches chat-completions tool calls and argument subsets", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          request: { model: "gpt-4.1-mini", parallel_tool_calls: true },
          response: {
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "lookup_weather", arguments: '{"city":"Amsterdam","unit":"c"}' },
                    },
                  ],
                },
              },
            ],
          },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          latency_ms: 120,
          ttft_ms: 20,
          retries: 0,
        },
      ],
    });
    const scope = scopeFor(trace);

    await expect(scope.toolCalled("lookup_weather", { argsSubset: { city: "Amsterdam" } })).resolves.toMatchObject({
      pass: true,
    });
    await expect(scope.parallelToolCalls()).resolves.toMatchObject({ pass: true });
    await expect(scope.finishReason("tool_calls")).resolves.toMatchObject({ pass: true });
    await expect(scope.tokenBounds({ total: { min: 1, max: 20 } })).resolves.toMatchObject({ pass: true });
    await expect(scope.noRetries()).resolves.toMatchObject({ pass: true });
  });

  it("matches Responses API function calls and tool result feedback", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          apiType: "responses",
          request: { model: "gpt-4.1-mini", input: "weather?" },
          response: {
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "lookup_weather",
                arguments: '{"city":"Rotterdam"}',
              },
            ],
          },
        },
        {
          apiType: "responses",
          request: {
            model: "gpt-4.1-mini",
            input: [{ type: "function_call_output", call_id: "call_1", output: "rain" }],
          },
          response: { output_text: "It is raining." },
        },
      ],
    });
    const scope = scopeFor(trace);

    await expect(scope.toolCalled("lookup_weather", { argsSubset: { city: "Rotterdam" } })).resolves.toMatchObject({
      pass: true,
    });
    await expect(scope.toolResultFedBack("lookup_weather")).resolves.toMatchObject({ pass: true });
    await expect(scope.responseContains("raining")).resolves.toMatchObject({ pass: true });
  });

  it("returns soft failures and throws hard failures with trace summaries", async () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [] });
    const soft = await scopeFor(trace).soft().toolCalled("missing");

    expect(soft.pass).toBe(false);
    expect(soft.error?.message).toContain("llm-test-lab trace summary");
    await expect(scopeFor(trace).toolCalled("missing")).rejects.toBeInstanceOf(LabAssertionError);
  });

  it("requires every matching record to satisfy bounds", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        { api_type: "chat_completions", latency_ms: 50, usage: { total_tokens: 10 } },
        { api_type: "chat_completions", latency_ms: 500, retries: 1, usage: { total_tokens: 1000 } },
      ],
    });

    await expect(scopeFor(trace).soft().latency({ max: 100 })).resolves.toMatchObject({ pass: false });
    await expect(scopeFor(trace).soft().tokenBounds({ total: { max: 100 } })).resolves.toMatchObject({ pass: false });
    await expect(scopeFor(trace).soft().noRetries()).resolves.toMatchObject({ pass: false });
  });

  it("treats omitted retries as zero for noRetries", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [{ api_type: "chat_completions", latency_ms: 50 }],
    });

    await expect(scopeFor(trace).noRetries()).resolves.toMatchObject({ pass: true });
  });

  it("asserts against Go control traces with headers-only request/response", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.chat",
          request: { headers: { Connection: ["keep-alive"], "Keep-Alive": ["timeout=5"] } },
          response: { headers: { Connection: ["keep-alive"] } },
          raw_request: Buffer.from(
            JSON.stringify({
              model: "gpt-4.1-mini",
              messages: [{ role: "user", content: "weather in Amsterdam" }],
            }),
          ).toString("base64"),
          raw_response: Buffer.from(
            JSON.stringify({
              model: "gpt-4.1-mini",
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
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
          ).toString("base64"),
          normalized: {
            model: { requested: "gpt-4.1-mini", returned: "gpt-4.1-mini" },
            tool_calls: [{ id: "call_fake", name: "lookup_weather", arguments: { city: "Amsterdam" } }],
            finish_reason: "tool_calls",
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      ],
    });
    const scope = scopeFor(trace);

    await expect(scope.toolCalled("lookup_weather", { argsSubset: { city: "Amsterdam" } })).resolves.toMatchObject({
      pass: true,
    });
    await expect(scope.model("gpt-4.1-mini")).resolves.toMatchObject({ pass: true });
    await expect(scope.promptContains("Amsterdam")).resolves.toMatchObject({ pass: true });
    await expect(scope.finishReason("tool_calls")).resolves.toMatchObject({ pass: true });
  });

  it("reads stream output_text and mid-stream errors from Go normalized payloads", async () => {
    const stream = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.responses",
          request: { headers: { Connection: ["keep-alive"] } },
          response: { headers: { "Keep-Alive": ["timeout=5"] } },
          raw_request: Buffer.from(JSON.stringify({ model: "gpt-4.1-mini", stream: true, input: "hi" })).toString(
            "base64",
          ),
          raw_response: Buffer.from("data: {\"delta\":\"hello-stream\"}\n\n").toString("base64"),
          normalized: {
            model: { requested: "gpt-4.1-mini", returned: "gpt-4.1-mini" },
            output_text: "hello-stream",
          },
        },
      ],
    });
    await expect(scopeFor(stream, { apiType: "responses" }).responseContains("hello-stream")).resolves.toMatchObject({
      pass: true,
    });

    const errored = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.chat",
          request: { headers: { Connection: ["keep-alive"] } },
          response: { headers: { "Keep-Alive": ["timeout=5"] } },
          normalized: {
            output_text: "partial",
            error: { message: "boom mid-stream", mid_stream: true },
          },
        },
      ],
    });
    await expect(scopeFor(errored).midStreamError(/boom|error/i)).resolves.toMatchObject({ pass: true });
  });
});

function scopeFor(trace: SessionTrace, query?: QueryOptions): AssertionScope {
  return new AssertionScope({
    control: {
      wait: async () => trace,
    } as never,
    sessionId: trace.id,
    ...(query ? { query } : {}),
  });
}
