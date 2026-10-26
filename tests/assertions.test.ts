import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AssertionScope, SessionAssertionError, formatTraceSummary, recordsForTrace } from "../src/assertions.js";
import { SessionNotFound } from "../src/control.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { CallOutcome, JsonValue, QueryOptions, SessionTrace } from "../src/types.js";
import { WaitTimeoutError } from "../src/wait.js";

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

  it("does not treat another tool's result as feedback for a named tool", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          apiType: "responses",
          request: { model: "gpt-4.1-mini", input: "weather?" },
          response: {
            output: [{ type: "function_call", call_id: "call_other", name: "lookup_time", arguments: "{}" }],
          },
        },
        {
          apiType: "responses",
          request: {
            model: "gpt-4.1-mini",
            input: [{ type: "function_call_output", call_id: "call_other", output: "noon" }],
          },
          response: { output_text: "It is noon." },
        },
      ],
    });
    const result = await scopeFor(trace).soft().toolResultFedBack("lookup_weather");
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/no call with an id was recorded/);
  });

  it("returns soft failures and throws hard failures with trace summaries", async () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [] });
    const soft = await scopeFor(trace).soft().toolCalled("missing");

    expect(soft.pass).toBe(false);
    expect(soft.error?.message).toContain("llmentary trace summary");
    await expect(scopeFor(trace).toolCalled("missing")).rejects.toBeInstanceOf(SessionAssertionError);
    await expect(scopeFor(trace).noErrors()).rejects.toThrow(/no calls recorded/);
    await expect(scopeFor(trace).allowEmpty().noErrors()).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).allowEmpty().notCalled("x")).resolves.toMatchObject({ pass: true });
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

  it("matches OpenAI alias models against dated snapshots", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          request: { model: "gpt-4.1-mini" },
          model: "gpt-4.1-mini-2025-04-14",
        },
      ],
    });
    await expect(scopeFor(trace).model("gpt-4.1-mini")).resolves.toMatchObject({ pass: true });
    expect(recordsForTrace(trace, { model: "gpt-4.1-mini" })).toHaveLength(1);
    expect(recordsForTrace(trace, { model: "gpt-4.1" })).toHaveLength(0);
  });

  it("counts calls, marks streams, and compares concatenated deltas", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          request: { model: "gpt-4.1-nano", stream: true },
          raw_response: Buffer.from(
            [
              'data: {"choices":[{"delta":{"content":"hel"}}]}',
              'data: {"choices":[{"delta":{"content":"lo"}}]}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
          ).toString("base64"),
          normalized: { output_text: "hello", finish_reason: "stop", usage: { total_tokens: 4 } },
        },
      ],
    });
    const scope = scopeFor(trace);
    await expect(scope.callCount(1)).resolves.toMatchObject({ pass: true });
    await expect(scope.streamed(true)).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().aborted()).resolves.toMatchObject({ pass: false });
    await expect(
      scopeFor(
        normalizeSessionTrace("abort", {
          id: "abort",
          calls: [
            {
              id: "call_a",
              client_aborted: true,
              abort_phase: "before_headers",
              normalized: { finish_reason: "cancelled" },
            },
          ],
        }),
      ).aborted(),
    ).resolves.toMatchObject({ pass: true });
    await expect(
      scopeFor(
        normalizeSessionTrace("abort", {
          id: "abort",
          calls: [
            {
              id: "call_a",
              client_aborted: true,
              abort_phase: "before_headers",
              normalized: { finish_reason: "cancelled" },
            },
          ],
        }),
      ).finishReason(/cancelled/i),
    ).resolves.toMatchObject({ pass: true });
    const abortOnly = normalizeSessionTrace("abort-only", {
      id: "abort-only",
      calls: [{ id: "call_a", client_aborted: true, abort_phase: "before_headers" }],
    });
    const abortSummary = formatTraceSummary(abortOnly);
    expect(abortSummary).toMatch(/client_aborted/);
    expect(abortSummary).toMatch(/phase=before_headers/);
    expect(abortSummary).not.toMatch(/unparsed call/);
    await expect(scope.outputText("hello")).resolves.toMatchObject({ pass: true });
    await expect(scope.outputMatchesDeltas()).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().callCount(2)).resolves.toMatchObject({ pass: false });
    expect((await scope.soft().callCount(2)).message).toMatch(/got 1/);
  });

  it("counts committed calls and can exclude client-aborted leftovers (DOG-50)", async () => {
    const trace = normalizeSessionTrace("mix", {
      id: "mix",
      calls: [
        { id: "call_1", request: { model: "m" }, normalized: { output_text: "ok" } },
        { id: "call_2", client_aborted: true, abort_phase: "before_headers" },
        { id: "call_3", request: { model: "m" }, normalized: { output_text: "ok" } },
      ],
    });
    await expect(scopeFor(trace).callCount(3)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).callCount(2, { excludeAborted: true })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).soft().callCount(3, { excludeAborted: true })).resolves.toMatchObject({
      pass: false,
      message: "expected 3 committed call(s), got 2",
    });
    await expect(scopeFor(trace, { committed: true }).callCount(2)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace, { aborted: true }).callCount(1)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace, { committed: true }).soft().noErrors()).resolves.toMatchObject({ pass: true });
    const both = await scopeFor(trace, { aborted: true, committed: true }).soft().noErrors();
    expect(both.pass).toBe(false);
    expect(both.message).toMatch(/no calls matched query \(committed, aborted\)/);
    const afterHeaders = normalizeSessionTrace("http200", {
      id: "http200",
      calls: [
        { id: "call_ok", http_status: 200, normalized: { output_text: "ok" } },
        { id: "call_barge", http_status: 200, client_aborted: true, abort_phase: "after_headers" },
      ],
    });
    await expect(scopeFor(afterHeaders).callCount(1, { excludeAborted: true })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(afterHeaders, { aborted: true }).aborted()).resolves.toMatchObject({ pass: true });
  });

  it("parses usage details, error fields, incomplete traces, and raw recording", async () => {
    const ok = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.chat",
          raw_request: Buffer.from(JSON.stringify({ model: "gpt-4.1-mini" })).toString("base64"),
          raw_response: Buffer.from(
            JSON.stringify({
              usage: {
                prompt_tokens: 20,
                completion_tokens: 5,
                total_tokens: 25,
                prompt_tokens_details: { cached_tokens: 8 },
                completion_tokens_details: { reasoning_tokens: 3 },
              },
            }),
          ).toString("base64"),
          normalized: {
            usage: {
              input_tokens: 20,
              output_tokens: 5,
              total_tokens: 25,
              prompt_tokens_details: { cached_tokens: 8 },
              completion_tokens_details: { reasoning_tokens: 3 },
            },
          },
        },
      ],
    });
    await expect(scopeFor(ok).usageDetails({ cachedTokens: { min: 1 }, reasoningTokens: { min: 1 } })).resolves.toMatchObject({
      pass: true,
    });
    await expect(scopeFor(ok).rawRecorded()).resolves.toMatchObject({ pass: true });

    const errored = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.chat",
          status: 400,
          error: { message: "nope", type: "invalid_request_error", code: "model_not_found", http_status: 400 },
        },
      ],
    });
    await expect(scopeFor(errored).errorStatus(400)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(errored).errorType("invalid_request_error")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(errored).errorCode("model_not_found")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(errored).incomplete()).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(errored).soft().errorStatus(500)).resolves.toMatchObject({ pass: false });
  });

  it("assembles streamed tool-call argument deltas as JSON", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          request: { stream: true },
          raw_response: Buffer.from(
            [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup_weather","arguments":"{\\"ci"}}]}}]}',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Oslo\\"}"}}]}}]}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
          ).toString("base64"),
        },
      ],
    });
    await expect(scopeFor(trace).streamedToolArgsJson("lookup_weather")).resolves.toMatchObject({ pass: true });
  });

  it("correlates Responses argument deltas by output index, not tool name", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "responses",
          request: { stream: true },
          raw_response: Buffer.from(
            [
              'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"lookup_weather","call_id":"call_1"}}',
              'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\"city\\":\\""}',
              'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"Oslo\\"}"}',
              'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_2","type":"function_call","name":"lookup_weather","call_id":"call_2"}}',
              'data: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_2","delta":"{\\"city\\":\\"Bergen\\"}"}',
              "",
            ].join("\n\n"),
          ).toString("base64"),
        },
      ],
    });
    await expect(scopeFor(trace).streamedToolArgsJson("lookup_weather")).resolves.toMatchObject({ pass: true });
  });

  it("scopes usage details to a single call by index", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          usage: { prompt_tokens: 1200, total_tokens: 1210, prompt_tokens_details: { cached_tokens: 0 } },
        },
        {
          api_type: "chat_completions",
          usage: { prompt_tokens: 1200, total_tokens: 1210, prompt_tokens_details: { cached_tokens: 1100 } },
        },
      ],
    });
    await expect(scopeFor(trace).soft().usageDetails({ cachedTokens: { min: 1 } })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace, { index: 0 }).soft().usageDetails({ cachedTokens: { min: 1 } })).resolves.toMatchObject({
      pass: false,
    });
    await expect(scopeFor(trace, { index: 1 }).usageDetails({ cachedTokens: { min: 1 } })).resolves.toMatchObject({ pass: true });
    expect(recordsForTrace(trace, { index: 1 })).toHaveLength(1);
  });

  it("reads nested usage details even when the top-level count is zero", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "responses",
          usage: {
            cached_tokens: 0,
            reasoning_tokens: 0,
            input_tokens_details: { cached_tokens: 2048 },
            output_tokens_details: { reasoning_tokens: 12 },
          },
        },
      ],
    });
    await expect(scopeFor(trace).usageDetails({ cachedTokens: { min: 1 }, reasoningTokens: { min: 1 } })).resolves.toMatchObject({
      pass: true,
    });
  });

  it("keeps whole-session expect() strict on a never-created session (DOG-2)", async () => {
    const scope = neverCreatedScope("ghost");
    await expect(scope.callCount(0)).rejects.toThrow(/no calls recorded for session ghost/);
    await expect(scope.noErrors()).rejects.toThrow(/no calls recorded for session ghost/);
  });

  it("lets expect({ allowEmpty: true }).callCount(0) pass on a never-created session", async () => {
    const scope = neverCreatedScope("ghost", { allowEmpty: true });
    await expect(scope.callCount(0)).resolves.toMatchObject({ pass: true });
    await expect(neverCreatedScope("ghost").allowEmpty().callCount(0)).resolves.toMatchObject({ pass: true });
  });

  it("expectNoCalls passes on 404 and fails on a session with calls plus the summary", async () => {
    const empty = neverCreatedScope("ghost");
    await expect(empty.expectNoCalls()).resolves.toMatchObject({ pass: true, message: "expected 0 LLM calls, got 0" });

    const busy = scopeFor(
      normalizeSessionTrace("busy", {
        id: "busy",
        calls: [{ id: "call_1", seq: 1, api_family: "openai.chat", request: { model: "gpt-4.1-mini" } }],
      }),
    );
    await expect(busy.expectNoCalls()).rejects.toBeInstanceOf(SessionAssertionError);
    await expect(busy.expectNoCalls()).rejects.toThrow(/expected 0 LLM calls, got 1/);
    await expect(busy.soft().expectNoCalls()).resolves.toMatchObject({
      pass: false,
      message: "expected 0 LLM calls, got 1",
    });
    try {
      await busy.expectNoCalls();
      throw new Error("expected expectNoCalls to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionAssertionError);
      expect((error as Error).message).toContain("llmentary trace summary");
      expect((error as Error).message).toContain("#1 (call_1)");
    }
  });

  it("expectNoCalls counts only the scoped records", async () => {
    const trace = normalizeSessionTrace("busy", {
      id: "busy",
      calls: [
        { id: "call_1", seq: 1, api_family: "openai.chat", request: { model: "gpt-4.1-mini" } },
        { id: "call_2", seq: 2, api_family: "openai.chat", request: { model: "gpt-4.1-mini" } },
      ],
    });
    const scoped = scopeFor(trace, { since: 2 });
    await expect(scoped.expectNoCalls()).resolves.toMatchObject({ pass: true, message: "expected 0 LLM calls, got 0" });
    await expect(scopeFor(trace, { since: 1 }).expectNoCalls()).rejects.toThrow(/expected 0 LLM calls, got 1/);
  });

  it("expectNoCalls does not treat a wait timeout as zero calls", async () => {
    const scope = new AssertionScope({
      control: {
        wait: async () => {
          throw new WaitTimeoutError("pending", "2s", 0, 1);
        },
      } as never,
      sessionId: "pending",
    });
    await expect(scope.expectNoCalls()).rejects.toBeInstanceOf(WaitTimeoutError);
  });
});

describe("outcome-based noErrors / noCancelled (DOG-58)", () => {
  const cases = loadOutcomeCases();

  it.each(cases)("$name: noErrors fails only on failed", async (testCase) => {
    const scope = scopeFor(traceForOutcomeCase(testCase));
    await expect(scope.soft().noErrors()).resolves.toMatchObject({ pass: testCase.outcome !== "failed" });
  });

  it.each(cases)("$name: noCancelled fails only on cancelled", async (testCase) => {
    const scope = scopeFor(traceForOutcomeCase(testCase));
    await expect(scope.soft().noCancelled()).resolves.toMatchObject({ pass: testCase.outcome !== "cancelled" });
  });

  it("lists failed calls as #seq plus the normalized error or the status", async () => {
    for (const [name, expected] of [
      ["upstream_500", "expected no errors, saw 1 failed call(s): #9 server_error"],
      ["http_4xx_without_error_object", "expected no errors, saw 1 failed call(s): #11 404"],
      ["status_zero_no_abort_no_error", "expected no errors, saw 1 failed call(s): #13 0"],
      ["malformed_client_aborted_error_without_flag", "expected no errors, saw 1 failed call(s): #6 client_aborted"],
    ] as const) {
      const result = await scopeFor(traceForOutcomeCase(outcomeCase(name))).soft().noErrors();
      expect(result.pass).toBe(false);
      expect(result.message).toBe(expected);
    }
  });

  it("lists cancelled calls with their abort phase", async () => {
    for (const [name, expected] of [
      ["before_headers_abort_source_client", "expected no cancelled calls, saw 1 cancelled call(s): #3 before_headers"],
      ["after_headers_abort_mid_stream", "expected no cancelled calls, saw 1 cancelled call(s): #5 after_headers"],
    ] as const) {
      const result = await scopeFor(traceForOutcomeCase(outcomeCase(name))).soft().noCancelled();
      expect(result.pass).toBe(false);
      expect(result.message).toBe(expected);
    }
  });

  it("keeps a client cancel out of noErrors and inside hasError / aborted", async () => {
    const scope = scopeFor(traceForOutcomeCase(outcomeCase("before_headers_abort_source_client")));
    await expect(scope.noErrors()).resolves.toMatchObject({ pass: true });
    await expect(scope.hasError("client_aborted")).resolves.toMatchObject({ pass: true });
    await expect(scope.aborted()).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().noCancelled()).resolves.toMatchObject({ pass: false });
  });
});

describe("callCount excludes cancelled by default (DOG-58)", () => {
  const cases = loadOutcomeCases();
  const committed = outcomeCase("complete_stream");
  const cancelled = outcomeCase("before_headers_abort_source_client");
  const failed = outcomeCase("upstream_500");
  const mixedTrace = (): SessionTrace =>
    normalizeSessionTrace("dog58-count", { id: "dog58-count", calls: [committed.call, cancelled.call, failed.call] });

  it.each(cases)("$name: callCount(1) counts every outcome except cancelled", async (testCase) => {
    const scope = scopeFor(traceForOutcomeCase(testCase));
    await expect(scope.soft().callCount(1)).resolves.toMatchObject({ pass: testCase.outcome !== "cancelled" });
    await expect(scope.soft().callCount(1, { includeCancelled: true })).resolves.toMatchObject({ pass: true });
  });

  it("counts committed and failed calls but not cancelled ones", async () => {
    await expect(scopeFor(mixedTrace()).callCount(2)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(mixedTrace()).callCount(3, { includeCancelled: true })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(mixedTrace()).callCount(2, { excludeAborted: true })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(mixedTrace(), { outcome: ["committed"] }).callCount(1)).resolves.toMatchObject({ pass: true });
  });

  it("names the excluded cancelled calls in the failure message", async () => {
    const result = await scopeFor(mixedTrace()).soft().callCount(3);
    expect(result.pass).toBe(false);
    expect(result.message).toBe(
      "expected 3 recorded call(s), got 2 (1 cancelled not counted; pass { includeCancelled: true })",
    );
    await expect(scopeFor(mixedTrace()).soft().callCount(2, { includeCancelled: true })).resolves.toMatchObject({
      pass: false,
      message: "expected 2 recorded call(s), got 3",
    });
    await expect(scopeFor(mixedTrace()).soft().callCount(3, { excludeAborted: true })).resolves.toMatchObject({
      pass: false,
      message: "expected 3 committed call(s), got 2",
    });
  });

  it("keeps excludeAborted counting uncommitted leftovers, including aborted failures", async () => {
    const abortedFailure = outcomeCase("aborted_with_upstream_error");
    const trace = normalizeSessionTrace("dog58-barge", {
      id: "dog58-barge",
      calls: [committed.call, cancelled.call, abortedFailure.call],
    });
    await expect(scopeFor(trace).callCount(2)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).callCount(1, { excludeAborted: true })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).callCount(3, { includeCancelled: true })).resolves.toMatchObject({ pass: true });
  });

  it("throws TypeError when includeCancelled and excludeAborted are both set", async () => {
    const scope = scopeFor(mixedTrace());
    await expect(scope.callCount(2, { includeCancelled: true, excludeAborted: true })).rejects.toBeInstanceOf(TypeError);
    await expect(scope.callCount(2, { includeCancelled: true, excludeAborted: true })).rejects.toThrow(
      /includeCancelled.*excludeAborted|excludeAborted.*includeCancelled/,
    );
  });
});

function neverCreatedScope(sessionId: string, query?: QueryOptions): AssertionScope {
  return new AssertionScope({
    control: {
      wait: async () => {
        throw new SessionNotFound(sessionId, {
          status: 404,
          path: `/sessions/${sessionId}/wait`,
          body: JSON.stringify({
            error: {
              type: "session_not_found",
              message: `no calls recorded for session "${sessionId}"; known sessions: GET /sessions`,
            },
          }),
        });
      },
      listSessions: async () => [],
    } as never,
    sessionId,
    ...(query ? { query } : {}),
  });
}

function scopeFor(trace: SessionTrace, query?: QueryOptions): AssertionScope {
  return new AssertionScope({
    control: {
      wait: async () => trace,
    } as never,
    sessionId: trace.id,
    ...(query ? { query } : {}),
  });
}

const VECTOR = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "call_outcomes.json");

interface OutcomeCase {
  name: string;
  outcome: CallOutcome;
  call: JsonValue;
}

function loadOutcomeCases(): OutcomeCase[] {
  const vector = JSON.parse(readFileSync(VECTOR, "utf8")) as { cases?: OutcomeCase[] };
  if (!Array.isArray(vector.cases)) throw new Error("call_outcomes.json is missing its cases array");
  return vector.cases;
}

function outcomeCase(name: string): OutcomeCase {
  const testCase = loadOutcomeCases().find((candidate) => candidate.name === name);
  if (!testCase) throw new Error(`unknown call_outcomes.json case ${name}`);
  return testCase;
}

function traceForOutcomeCase(testCase: OutcomeCase): SessionTrace {
  return normalizeSessionTrace("dog58", { id: "dog58", calls: [testCase.call] });
}
