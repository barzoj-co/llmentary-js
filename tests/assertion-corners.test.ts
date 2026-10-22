import { describe, expect, it } from "vitest";
import {
  AssertionScope,
  formatTraceSummary,
  matchesModel,
  recordsForTrace,
} from "../src/assertions.js";
import { SessionNotFound } from "../src/control.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { QueryOptions, SessionTrace } from "../src/types.js";
import { WaitTimeoutError } from "../src/wait.js";

describe("assertion option combinations and fallbacks", () => {
  it("orders tools as a subsequence and describes argsMatcher misses", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          request: { functions: [{ name: "lookup_weather" }, { name: "lookup_time" }] },
          response: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "c1", function: { name: "lookup_weather", arguments: '{"city":"Oslo"}' } },
                    { id: "c2", function: { name: "lookup_time", arguments: '{"tz":"CET"}' } },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    const scope = scopeFor(trace);
    await expect(scope.order(["lookup_weather", "lookup_time"])).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().order(["lookup_time", "lookup_weather"])).resolves.toMatchObject({ pass: false });
    await expect(scope.calledTimes("lookup_weather", 1)).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().calledTimes("lookup_weather", 2)).resolves.toMatchObject({ pass: false });
    await expect(
      scope.argsMatcher("lookup_weather", (args) => Boolean(args && typeof args === "object" && "city" in args)),
    ).resolves.toMatchObject({ pass: true });
    const missed = await scope.soft().toolCalled("lookup_weather", {
      argsMatcher: () => false,
    });
    expect(missed.pass).toBe(false);
    expect(missed.message).toMatch(/args matching predicate/);
  });

  it("matches requestParam predicates, model regexes, and finish-reason misses", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          model: "gpt-4.1-mini-2025-04-14",
          request: { model: "gpt-4.1-mini", temperature: 0.2 },
          response: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] },
        },
      ],
    });
    const scope = scopeFor(trace);
    await expect(scope.requestParam("temperature", (value) => value === 0.2)).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().requestParam("temperature", 0.9)).resolves.toMatchObject({ pass: false });
    await expect(scope.model(/gpt-4\.1-mini/)).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().model("gpt-5")).resolves.toMatchObject({ pass: false });
    await expect(scope.soft().finishReason("length")).resolves.toMatchObject({ pass: false });
    expect(matchesModel("gpt-4.1-mini-2025-04-14", /mini/)).toBe(true);
    expect(matchesModel(undefined, "gpt-4.1-mini")).toBe(false);
    expect(recordsForTrace(trace, { model: /gpt-4\.1-mini/ })).toHaveLength(1);
    expect(recordsForTrace(trace, { apiType: "responses" })).toHaveLength(0);
    expect(recordsForTrace(trace, { index: 9 })).toHaveLength(0);
  });

  it("covers streamed/aborted negatives, output text presence, and JSON schemas", async () => {
    const streamed = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          request: { stream: false, model: "gpt-4.1-mini" },
          response: { output_text: '{"ok":true}', choices: [{ message: { content: '{"ok":true}' } }] },
        },
      ],
    });
    const scope = scopeFor(streamed);
    await expect(scope.streamed(false)).resolves.toMatchObject({ pass: true });
    await expect(scope.aborted(false)).resolves.toMatchObject({ pass: true });
    await expect(scope.outputText()).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().outputText("missing")).resolves.toMatchObject({ pass: false });
    await expect(scope.outputJsonValid({ type: "object", required: ["ok"] })).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().outputJsonValid({ type: "object", required: ["nope"] })).resolves.toMatchObject({
      pass: false,
    });
    await expect(scope.responseJsonSchema({ type: "object" })).resolves.toMatchObject({ pass: true });
    await expect(scope.responseJsonValid({ schema: { type: "object" }, data: "request" })).resolves.toMatchObject({
      pass: true,
    });
  });

  it("validates tool-argument JSON schemas and unnamed tool-result feedback", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "responses",
          request: { model: "gpt-4.1-mini", input: "weather?" },
          response: {
            output: [{ type: "function_call", call_id: "call_1", name: "lookup_weather", arguments: '{"city":"Oslo"}' }],
          },
        },
        {
          api_type: "responses",
          request: {
            model: "gpt-4.1-mini",
            input: [{ type: "function_call_output", call_id: "call_1", output: "snow" }],
          },
          response: { output_text: "Snow in Oslo." },
        },
      ],
    });
    await expect(
      scopeFor(trace).responseJsonValid({
        schema: { type: "object", required: ["city"] },
        data: "toolArguments",
        toolName: "lookup_weather",
      }),
    ).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).toolResultFedBack()).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).toolResultInPrompt()).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).soft().toolResultInPrompt("lookup_time")).resolves.toMatchObject({ pass: false });
  });

  it("matches hasError/midStreamError without a pattern and error-status bounds", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.chat",
          error: { message: "boom mid-stream", midStream: true, type: "server_error", code: "overloaded" },
          response: { error: { status: 503, http_status: 503 } },
        },
      ],
    });
    const scope = scopeFor(trace);
    await expect(scope.hasError()).resolves.toMatchObject({ pass: true });
    await expect(scope.hasError(/boom/)).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().hasError(/quiet/)).resolves.toMatchObject({ pass: false });
    await expect(scope.midStreamError()).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().midStreamError(/quiet/)).resolves.toMatchObject({ pass: false });
    await expect(scope.errorStatus({ min: 500, max: 599 })).resolves.toMatchObject({ pass: true });
    await expect(scope.soft().errorType(/rate/)).resolves.toMatchObject({ pass: false });
    await expect(scope.soft().errorCode(/missing/)).resolves.toMatchObject({ pass: false });
    await expect(scope.soft().ttft({ max: 10 })).resolves.toMatchObject({
      pass: false,
    });
  });

  it("treats truncated streams and missing finish reasons as incomplete", async () => {
    const truncated = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.chat",
          streamed: true,
          raw: { normalized: { stream_truncated: true } },
          response: { choices: [{ message: { content: "partial" } }] },
        },
      ],
    });
    await expect(scopeFor(truncated).incomplete()).resolves.toMatchObject({ pass: true });

    const openStream = normalizeSessionTrace("s2", {
      id: "s2",
      calls: [{ api_family: "openai.chat", streamed: true, response: { output_text: "still going" } }],
    });
    await expect(scopeFor(openStream).incomplete()).resolves.toMatchObject({ pass: true });

    const cancelled = normalizeSessionTrace("s3", {
      id: "s3",
      calls: [{ api_family: "openai.chat", response: { choices: [{ finish_reason: "cancelled" }] } }],
    });
    await expect(scopeFor(cancelled).incomplete()).resolves.toMatchObject({ pass: true });

    const complete = normalizeSessionTrace("s4", {
      id: "s4",
      calls: [{ api_family: "openai.chat", response: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } }],
    });
    await expect(scopeFor(complete).soft().incomplete()).resolves.toMatchObject({ pass: false });
    await expect(scopeFor(complete).soft().rawRecorded()).resolves.toMatchObject({ pass: false });
    await expect(scopeFor(complete).soft().hasError()).resolves.toMatchObject({ pass: false });
  });

  it("assembles streamed tool args from chat deltas and reports invalid JSON", async () => {
    const invalid = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          request: { stream: true },
          raw_response: Buffer.from(
            [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup_weather","arguments":"{not-json"}}]}}]}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
          ).toString("base64"),
        },
      ],
    });
    const failed = await scopeFor(invalid).soft().streamedToolArgsJson("lookup_weather");
    expect(failed.pass).toBe(false);
    expect(failed.message).toMatch(/errors=/);

    const fallback = normalizeSessionTrace("s2", {
      id: "s2",
      calls: [
        {
          api_type: "chat_completions",
          response: {
            choices: [
              {
                message: {
                  tool_calls: [{ id: "c1", function: { name: "lookup_weather", arguments: '{"city":"Bergen"}' } }],
                },
              },
            ],
          },
        },
      ],
    });
    await expect(scopeFor(fallback).streamedToolArgsJson("lookup_weather")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(fallback).streamedToolArgsJson()).resolves.toMatchObject({ pass: true });
  });

  it("reads Responses output text parts and string responses", async () => {
    const responses = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "responses",
          response: {
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Hello from parts" }, " and a string part"],
              },
            ],
          },
        },
        {
          api_type: "responses",
          response: "plain string response",
        },
      ],
    });
    await expect(scopeFor(responses).outputText(/Hello from parts/)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(responses).responseContains("plain string")).resolves.toMatchObject({ pass: true });
  });

  it("decodes SSE payloads from raw_text, sse_events, and base64 JSON", async () => {
    const rawText = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "responses",
          request: { stream: true },
          response: {
            raw_text: [
              'data: {"type":"response.output_text.delta","delta":"hel"}',
              'data: {"type":"response.output_text.delta","delta":"lo"}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            output_text: "hello",
          },
        },
      ],
    });
    await expect(scopeFor(rawText).outputMatchesDeltas()).resolves.toMatchObject({ pass: true });

    const events = normalizeSessionTrace("s2", {
      id: "s2",
      calls: [
        {
          api_type: "chat_completions",
          request: { stream: true },
          sse_events: [
            { data: Buffer.from(JSON.stringify({ choices: [{ delta: { content: "ab" } }] })).toString("base64") },
            { data: "[DONE]" },
            { data: "not-json" },
          ],
          normalized: { output_text: "ab" },
        },
      ],
    });
    await expect(scopeFor(events).outputMatchesDeltas()).resolves.toMatchObject({ pass: true });
  });

  it("treats SessionNotFound and zero-call wait timeouts as empty traces", async () => {
    const missing = new AssertionScope({
      control: {
        wait: async () => {
          throw new SessionNotFound("ghost", { status: 404, path: "/sessions/ghost/wait", body: "" });
        },
        listSessions: async () => {
          throw new Error("control list down");
        },
      } as never,
      sessionId: "ghost",
    });
    await expect(missing.soft().callCount(1)).resolves.toMatchObject({ pass: false });
    await expect(missing.soft().notCalled("x")).resolves.toMatchObject({ pass: false });

    const timedOutEmpty = new AssertionScope({
      control: {
        wait: async () => {
          throw new WaitTimeoutError("pending", "2s", 0, 0);
        },
        listSessions: async () => [{ id: "other" }],
      } as never,
      sessionId: "pending",
    });
    await expect(timedOutEmpty.callCount(0)).rejects.toThrow(/no calls recorded for session pending/);

    const timedOutBusy = new AssertionScope({
      control: {
        wait: async () => {
          throw new WaitTimeoutError("busy", "2s", 2, 1);
        },
      } as never,
      sessionId: "busy",
    });
    await expect(timedOutBusy.callCount(0)).rejects.toBeInstanceOf(WaitTimeoutError);

    const noList = new AssertionScope({
      control: {
        wait: async () => {
          throw new SessionNotFound("ghost", { status: 404, path: "/sessions/ghost/wait", body: "" });
        },
      } as never,
      sessionId: "ghost",
    });
    await expect(noList.soft().callCount(1)).resolves.toMatchObject({ pass: false });
  });

  it("rethrows unexpected wait errors from evaluate and isolatedFrom", async () => {
    const boom = new AssertionScope({
      control: {
        wait: async () => {
          throw new Error("control exploded");
        },
      } as never,
      sessionId: "s1",
    });
    await expect(boom.callCount(0)).rejects.toThrow(/control exploded/);
    await expect(boom.isolatedFrom("other")).rejects.toThrow(/control exploded/);
  });

  it("uses another session's control and maps empty-other wait timeouts", async () => {
    const self = normalizeSessionTrace("self", {
      id: "self",
      calls: [
        {
          id: "call_self",
          seq: 1,
          session_id: "self",
          session_source: "header",
          request: { messages: [{ role: "user", content: "unique self question text" }] },
        },
      ],
    });
    const otherControl = {
      wait: async () => {
        throw new WaitTimeoutError("other", "1s", 0, 0);
      },
    };
    const scope = new AssertionScope({
      control: { wait: async () => self } as never,
      sessionId: "self",
    });
    await expect(scope.isolatedFrom({ sessionId: "other", control: otherControl as never }, { allowEmpty: true })).resolves.toMatchObject({
      pass: true,
    });
    await expect(scope.soft().isolatedFrom({ sessionId: "other", control: otherControl as never })).resolves.toMatchObject({
      pass: false,
    });
    await expect(scope.soft().isolatedFrom("other", { requirePathSource: true })).resolves.toMatchObject({
      pass: false,
    });
  });

  it("skips unnamed tool calls and invalid argument JSON", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_type: "chat_completions",
          response: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "blank", function: { arguments: "{}" } },
                    { id: "bad", function: { name: "lookup_weather", arguments: "{not-json" } },
                  ],
                },
              },
            ],
            output: [{ type: "function_call", arguments: "{}" }],
          },
        },
      ],
    });
    await expect(scopeFor(trace).soft().toolCalled("lookup_weather", { argsSubset: { city: "Oslo" } })).resolves.toMatchObject({
      pass: false,
    });
    await expect(scopeFor(trace).toolCalled("lookup_weather")).resolves.toMatchObject({ pass: true });
  });

  it("formats empty-filter messages and unparsed summary fallbacks", () => {
    const empty = normalizeSessionTrace("s1", { id: "s1", calls: [{ leftover: true }] });
    expect(formatTraceSummary(empty)).toMatch(/unparsed call/);
    expect(recordsForTrace(empty, { model: "gpt-4.1-mini" })).toHaveLength(0);
  });

  it("ignores empty ignorePaths and formats findings with missing metadata", async () => {
    const dirty = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          normalized: {
            validation: { request_checked: true, response_checked: true },
            spec_violations: [{ message: "no path" }],
          },
        },
      ],
    });
    const failed = await scopeFor(dirty).soft().noSpecViolations({ ignorePaths: [""] });
    expect(failed.pass).toBe(false);
    expect(failed.message).toMatch(/unknown/);
    await expect(scopeFor(dirty).soft().noSpecViolations({ calls: ["missing-id"] })).resolves.toMatchObject({
      pass: false,
      message: "validation was not run",
    });
    await expect(scopeFor(dirty).noSpecViolations({ calls: ["missing-id"], allowUnvalidated: true })).resolves.toMatchObject({
      pass: true,
    });
  });

  it("collects soft check() success and token-bound misses without usage", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [{ api_type: "chat_completions", request: { model: "gpt-4.1-mini" } }],
    });
    const soft = scopeFor(trace).soft();
    await expect(soft.model("gpt-4.1-mini")).resolves.toMatchObject({ pass: true });
    await expect(soft.check()).resolves.toMatchObject({ pass: true, message: "all soft assertions passed" });
    await expect(scopeFor(trace).soft().tokenBounds({ total: { min: 1 } })).resolves.toMatchObject({ pass: false });
  });

  it("walks nested tool-result payloads and numeric/boolean extractText", async () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          request: {
            nested: {
              messages: [{ role: "tool", tool_call_id: "call_1", content: true }],
            },
            count: 2,
          },
          response: {
            choices: [
              {
                message: {
                  tool_calls: [{ id: "call_1", function: { name: "lookup_weather", arguments: '{"city":1}' } }],
                },
              },
            ],
          },
        },
      ],
    });
    await expect(scopeFor(trace).toolResultFedBack("lookup_weather")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).promptContains("2")).resolves.toMatchObject({ pass: true });
  });
});

function scopeFor(trace: SessionTrace, query?: QueryOptions): AssertionScope {
  return new AssertionScope({
    control: {
      wait: async () => trace,
      listSessions: async () => [{ id: trace.id }],
    } as never,
    sessionId: trace.id,
    ...(query ? { query } : {}),
  });
}
