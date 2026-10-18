import { describe, expect, it } from "vitest";
import { AssertionScope, LabAssertionError } from "../src/assertions.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { SessionTrace } from "../src/types.js";

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
});

function scopeFor(trace: SessionTrace): AssertionScope {
  return new AssertionScope({
    control: {
      wait: async () => trace,
    } as never,
    sessionId: trace.id,
  });
}
