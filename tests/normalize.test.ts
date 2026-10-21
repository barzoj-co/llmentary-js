import { describe, expect, it } from "vitest";
import { normalizeCallRecord, normalizeIsolationText, normalizeSessionTrace } from "../src/normalize.js";

const CHAT_REQUEST = Buffer.from(
  JSON.stringify({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "weather in Amsterdam" }],
    tools: [
      {
        type: "function",
        function: { name: "lookup_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
      },
    ],
  }),
).toString("base64");

const CHAT_RESPONSE = Buffer.from(
  JSON.stringify({
    id: "chatcmpl_fake",
    object: "chat.completion",
    model: "gpt-4.1-mini",
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
).toString("base64");

describe("normalizeCallRecord Go control schema", () => {
  it("maps api_family, nested model, decoded bodies, and normalized tool calls", () => {
    const record = normalizeCallRecord({
      id: "call_1",
      api_family: "openai.chat",
      latency_ms: 3,
      started_at: "2026-10-18T10:13:53.761Z",
      ended_at: "2026-10-18T10:13:53.765Z",
      upstream: { method: "POST", url: "http://127.0.0.1:9/v1/chat/completions" },
      request: { headers: { Connection: ["keep-alive"] } },
      response: { headers: { "Keep-Alive": ["timeout=5"] } },
      raw_request: CHAT_REQUEST,
      raw_response: CHAT_RESPONSE,
      normalized: {
        model: { requested: "gpt-4.1-mini", returned: "gpt-4.1-mini" },
        tool_calls: [
          {
            index: 0,
            id: "call_fake",
            name: "lookup_weather",
            kind: "function",
            arguments_raw: '{"city":"Amsterdam"}',
            arguments: { city: "Amsterdam" },
          },
        ],
        finish_reason: "tool_calls",
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    });

    expect(record.apiType).toBe("chat_completions");
    expect(record.model).toBe("gpt-4.1-mini");
    expect(record.latencyMs).toBe(3);
    expect(record.finishedAt).toBe("2026-10-18T10:13:53.765Z");
    expect(record.request).toMatchObject({ model: "gpt-4.1-mini" });
    expect(record.promptText).toMatch(/weather in Amsterdam/);
    expect(record.response).toMatchObject({ id: "chatcmpl_fake" });
    expect(record.usage).toMatchObject({ input_tokens: 4, total_tokens: 6 });
  });

  it("maps openai.responses and synthesizes stream output_text from normalized", () => {
    const sse = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello-stream\"}\n\n";
    const record = normalizeCallRecord({
      api_family: "openai.responses",
      request: { headers: { Connection: ["keep-alive"] } },
      response: { headers: { "Keep-Alive": ["timeout=5"] } },
      raw_request: Buffer.from(JSON.stringify({ model: "gpt-4.1-mini", stream: true, input: "stream" })).toString(
        "base64",
      ),
      raw_response: Buffer.from(sse).toString("base64"),
      normalized: {
        model: { requested: "gpt-4.1-mini", returned: "gpt-4.1-mini" },
        output_text: "hello-stream",
        finish_reason: "unknown",
      },
    });

    expect(record.apiType).toBe("responses");
    expect(record.model).toBe("gpt-4.1-mini");
    expect(record.response).toMatchObject({ output_text: "hello-stream", finish_reason: "unknown" });
  });

  it("copies normalized mid-stream errors onto the call record", () => {
    const record = normalizeCallRecord({
      api_family: "openai.chat",
      request: { headers: { Connection: ["keep-alive"] } },
      response: { headers: { "Keep-Alive": ["timeout=5"] } },
      raw_request: Buffer.from(JSON.stringify({ model: "gpt-4.1-mini", stream: true })).toString("base64"),
      raw_response: Buffer.from('data: {"error":{"message":"boom mid-stream"}}\n\n').toString("base64"),
      normalized: {
        model: { requested: "gpt-4.1-mini" },
        output_text: "partial",
        error: { http_status: 200, message: "boom mid-stream", mid_stream: true },
        stream_truncated: true,
      },
    });

    expect(record.error).toMatchObject({ message: "boom mid-stream", mid_stream: true });
  });

  it("marks streamed requests and flattens cached/reasoning token details", () => {
    const record = normalizeCallRecord({
      api_family: "openai.chat",
      status: 400,
      request: { headers: { Connection: ["keep-alive"] } },
      response: { headers: { "Keep-Alive": ["timeout=5"] } },
      raw_request: Buffer.from(JSON.stringify({ model: "gpt-4.1-mini", stream: true })).toString("base64"),
      raw_response: Buffer.from(
        JSON.stringify({
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 6 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }),
      ).toString("base64"),
      normalized: {
        error: { message: "nope", type: "invalid_request_error", code: "model_not_found", http_status: 400 },
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    });

    expect(record.streamed).toBe(true);
    expect(record.httpStatus).toBe(400);
    expect(record.usage).toMatchObject({ cached_tokens: 6, reasoning_tokens: 2, total_tokens: 14 });
  });

  it("prefers nested usage details over a top-level zero", () => {
    const record = normalizeCallRecord({
      api_family: "openai.responses",
      usage: {
        cached_tokens: 0,
        reasoning_tokens: 0,
        input_tokens_details: { cached_tokens: 1100 },
        output_tokens_details: { reasoning_tokens: 40 },
        total_tokens: 1200,
      },
    });
    expect(record.usage).toMatchObject({ cached_tokens: 1100, reasoning_tokens: 40, total_tokens: 1200 });
  });
});

describe("normalizeSessionTrace", () => {
  it("keeps OpenAI-shaped unit-test envelopes working", () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [{ api_type: "chat_completions", request: { model: "gpt-4.1-mini" }, latency_ms: 10 }],
    });
    expect(trace.calls[0]?.apiType).toBe("chat_completions");
    expect(trace.calls[0]?.model).toBe("gpt-4.1-mini");
    expect(trace.calls[0]?.request).toEqual({ model: "gpt-4.1-mini" });
  });

  it("accepts records/requests/traces aliases and a trace_summary", () => {
    for (const key of ["records", "Records", "requests", "Requests", "traces", "Traces"] as const) {
      const trace = normalizeSessionTrace("s1", { [key]: [{ request: { model: "m" } }], trace_summary: "sum" });
      expect(trace.calls).toHaveLength(1);
      expect(trace.summary).toBe("sum");
    }
  });

  it("decodes invalid JSON, empty payloads, and refuses NUL base64", () => {
    const invalid = normalizeCallRecord({
      raw_request: "{not-json",
      raw_response: "   ",
      request: { stream: false },
      streamed: false,
      normalized: { streamed: false },
    });
    expect(invalid.request).toBe("{not-json");
    expect(invalid.streamed).toBe(false);

    const nul = Buffer.from("\u0000secret").toString("base64");
    const binary = normalizeCallRecord({ raw_request: nul });
    expect(binary.request).toBe(nul);

    const noPath = normalizeCallRecord({ path: "/v1/models" });
    expect(noPath.apiType).toBeUndefined();
  });

  it("reads camelCase validation flags and output message parts", () => {
    const record = normalizeCallRecord({
      normalized: {
        validation: { requestChecked: true, responseChecked: false, truncated: true },
        spec_violations: [
          { schema_ref: "ref", event_index: 2, offset: 1, profile: "strict", source: "schema" },
        ],
      },
      response: {
        output: [
          { type: "message", content: [{ text: "hello parts" }, "plain"] },
          { type: "function_call", name: "x" },
        ],
      },
    });
    expect(record.validation).toMatchObject({ requestChecked: true, responseChecked: false, truncated: true });
    expect(record.responseText).toMatch(/hello parts/);
    expect(record.specViolations?.[0]).toMatchObject({ schemaRef: "ref", eventIndex: 2, offset: 1 });
  });

  it("joins string content parts and treats mode=off as not checked", () => {
    const record = normalizeCallRecord({
      request: {
        messages: [{ role: "user", content: ["Hello", { text: " there" }, { input_text: " again" }] }],
      },
      normalized: { validation: { mode: "off" } },
    });
    expect(record.userTexts).toEqual(["Hello there again"]);
    expect(record.validation?.mode).toBe("off");
  });
});

describe("seq, sessionId, and userTexts", () => {
  it("reads seq and sessionId from the wire", () => {
    const record = normalizeCallRecord({
      id: "call_3",
      seq: 1,
      session_id: "weather",
      api_family: "openai.chat",
      request: { model: "gpt-4.1-mini", messages: [{ role: "user", content: "Amsterdam weather" }] },
    });
    expect(record.seq).toBe(1);
    expect(record.sessionId).toBe("weather");
    expect(record.userTexts).toEqual(["Amsterdam weather"]);
  });

  it("fills sessionId from the parent session when the call omitted it", () => {
    const trace = normalizeSessionTrace("weather", {
      id: "weather",
      calls: [{ id: "call_3", seq: 1, api_family: "openai.chat" }],
    });
    expect(trace.calls[0]?.sessionId).toBe("weather");
    expect(trace.calls[0]?.seq).toBe(1);
  });

  it("extracts Chat and Responses user turns and skips system/tool text", () => {
    const chat = normalizeCallRecord({
      request: {
        messages: [
          { role: "system", content: "Never mention Amsterdam weather or get_current_weather." },
          { role: "user", content: "Tell a story" },
          { role: "assistant", content: "Once upon a time" },
          { role: "user", content: [{ type: "text", text: "Continue" }] },
        ],
      },
    });
    expect(chat.userTexts).toEqual(["Tell a story", "Continue"]);

    const responses = normalizeCallRecord({
      request: {
        instructions: "Never mention Amsterdam weather or get_current_weather.",
        tools: [{ name: "get_current_weather" }],
        input: [
          { role: "developer", content: "hidden" },
          { role: "user", content: [{ type: "input_text", text: "Lisbon ferry" }] },
        ],
      },
    });
    expect(responses.userTexts).toEqual(["Lisbon ferry"]);

    const stringInput = normalizeCallRecord({ request: { input: "plain user turn" } });
    expect(stringInput.userTexts).toEqual(["plain user turn"]);
  });
});

describe("normalizeIsolationText", () => {
  it("trims, collapses whitespace, and applies full Unicode casefold", () => {
    expect(normalizeIsolationText("  What   IS my\tage? ")).toBe("what is my age?");
    expect(normalizeIsolationText("Straße")).toBe(normalizeIsolationText("STRASSE"));
    expect(normalizeIsolationText("ß")).toBe("ss");
  });
});

describe("sessionSource and upstreamUrl", () => {
  it.each([
    ["path", "https://api.openai.com/v1/chat/completions"],
    ["header", "https://openrouter.ai/api/v1/chat/completions"],
    ["baggage", "https://api.openai.com/v1/responses"],
    ["default", "http://127.0.0.1:9/v1/chat/completions"],
  ] as const)("maps %s attribution and upstream url", (source, url) => {
    const record = normalizeCallRecord({
      api_family: "openai.chat",
      session_source: source,
      upstream: { method: "POST", url },
      request: { model: "gpt-4.1-mini" },
    });
    expect(record.sessionSource).toBe(source);
    expect(record.upstreamUrl).toBe(url);
    expect(record.upstreamUrl).not.toMatch(/\/s\//);
  });

  it("reads typed clientAborted and abortPhase from the new Call shape and the old nested alias", () => {
    const topLevel = normalizeCallRecord({
      id: "call_1",
      client_aborted: true,
      abort_phase: "before_headers",
      http_status: 0,
      normalized: { finish_reason: "cancelled", client_aborted: true },
    });
    expect(topLevel.clientAborted).toBe(true);
    expect(topLevel.abortPhase).toBe("before_headers");

    const nested = normalizeCallRecord({
      id: "call_2",
      normalized: { client_aborted: true, finish_reason: "cancelled" },
    });
    expect(nested.clientAborted).toBe(true);
    expect(nested.abortPhase).toBeUndefined();

    const afterHeaders = normalizeCallRecord({
      id: "call_3",
      client_aborted: true,
      abort_phase: "after_headers",
      http_status: 200,
    });
    expect(afterHeaders.abortPhase).toBe("after_headers");

    const normal = normalizeCallRecord({
      id: "call_4",
      client_aborted: false,
      request: { model: "gpt-4.1-mini" },
    });
    expect(normal.clientAborted).toBe(false);
    expect(normal.abortPhase).toBeUndefined();

    const done = normalizeCallRecord({
      id: "call_done",
      streamed: true,
      http_status: 200,
      request: { model: "gpt-4.1-mini", stream: true },
      response: { raw_text: "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n" },
      normalized: { finish_reason: "stop" },
    });
    expect(done.clientAborted).toBeUndefined();
    expect(done.abortPhase).toBeUndefined();

    const strayPhase = normalizeCallRecord({
      id: "call_stray",
      client_aborted: false,
      abort_phase: "after_headers",
    });
    expect(strayPhase.clientAborted).toBe(false);
    expect(strayPhase.abortPhase).toBeUndefined();
  });

  it("leaves the accessors undefined when the proxy omitted them", () => {
    const record = normalizeCallRecord({
      api_family: "openai.chat",
      request: { model: "gpt-4.1-mini" },
    });
    expect(record.sessionSource).toBeUndefined();
    expect(record.upstreamUrl).toBeUndefined();
  });
});
