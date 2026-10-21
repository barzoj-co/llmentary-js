import { describe, expect, it } from "vitest";
import {
  AssertionScope,
  SessionAssertionError,
  formatEmptyFilterMessage,
  formatTraceSummary,
  offeredToolNames,
  recordsForTrace,
} from "../src/assertions.js";
import { SessionQuery, llmentary, mentionsAny, mentionsAnyResult } from "../src/index.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { QueryOptions, SessionTrace } from "../src/types.js";

const PROXY = "http://127.0.0.1:7777";

const ROUTER = {
  api_family: "openai.chat",
  request: {
    model: "gpt-4.1-mini",
    response_format: { type: "json_schema", json_schema: { name: "route", schema: { type: "object" } } },
    messages: [{ role: "user", content: "route this" }],
  },
  response: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] },
};

const SPECIALIST = {
  api_family: "openai.chat",
  request: {
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "need tools" }],
    tools: [
      { type: "function", function: { name: "get_risks" } },
      { type: "function", function: { name: "get_user_health_tips" } },
      { type: "function", function: { name: "lookup_weather" } },
      { type: "function", function: { name: "lookup_time" } },
      { type: "function", function: { name: "get_labs" } },
      { type: "function", function: { name: "get_notes" } },
    ],
  },
  response: {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup_weather", arguments: '{"city":"Amsterdam"}' } },
          ],
        },
      },
    ],
  },
};

const FOLLOW_UP = {
  api_family: "openai.chat",
  request: {
    model: "gpt-4.1-mini",
    messages: [
      { role: "user", content: "need tools" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "lookup_weather", arguments: '{"city":"Amsterdam"}' } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"temperature":20,"condition":"sunny","token":"SEED_X"}',
      },
    ],
  },
  response: { choices: [{ message: { content: "It is 20 C and sunny." }, finish_reason: "stop" }] },
};

describe("pathBaseURL", () => {
  it.each([
    ["t1", undefined, `${PROXY}/s/t1/v1`],
    ["t 1", "openrouter", `${PROXY}/s/t%201/u/openrouter`],
    ["abc", "openai", `${PROXY}/s/abc/u/openai`],
    ["id/with/slash", undefined, `${PROXY}/s/id%2Fwith%2Fslash/v1`],
  ] as const)("maps (%s, %s) to %s", (sessionId, upstream, expected) => {
    const lm = llmentary({ proxyUrl: PROXY, controlUrl: PROXY, sessionId });
    expect(lm.pathBaseURL(upstream)).toBe(expected);
  });
});

describe("offersTool / withoutTools / since", () => {
  const trace = normalizeSessionTrace("s1", { id: "s1", calls: [ROUTER, SPECIALIST, FOLLOW_UP] });

  it("filters the router / specialist / follow-up table", () => {
    expect(offeredToolNames(trace.calls[0]!)).toEqual([]);
    expect(offeredToolNames(trace.calls[1]!)).toEqual([
      "get_risks",
      "get_user_health_tips",
      "lookup_weather",
      "lookup_time",
      "get_labs",
      "get_notes",
    ]);
    expect(recordsForTrace(trace, { withoutTools: true })).toHaveLength(2);
    expect(recordsForTrace(trace, { offersTool: "lookup_weather" })).toHaveLength(1);
    expect(recordsForTrace(trace, { offersTool: "get_risks" })[0]?.promptText).toMatch(/need tools/);
  });

  it("scopes assertions with mark/since and shows seq in the summary", async () => {
    expect(trace.since(1)).toHaveLength(2);
    expect(formatTraceSummary(trace)).toMatch(/seq=0/);
    expect(formatTraceSummary(trace)).toMatch(/seq=1/);
    expect(formatTraceSummary(trace)).toMatch(/seq=2/);

    await expect(scopeFor(trace, { since: 1 }).callCount(2)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace, { since: 1 }).toolCalled("lookup_weather")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace, { since: 2 }).soft().toolCalled("lookup_weather")).resolves.toMatchObject({
      pass: false,
    });
    await expect(scopeFor(trace, { withoutTools: true }).callCount(2)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace, { offersTool: "lookup_weather" }).callCount(1)).resolves.toMatchObject({ pass: true });
  });

  it("fills promptText and responseText", () => {
    expect(trace.calls[0]?.promptText).toMatch(/route this/);
    expect(trace.calls[2]?.responseText).toMatch(/sunny/);
  });

  it("keeps since() on the filtered SessionQuery.wait() calls", async () => {
    const lm = llmentary({ proxyUrl: PROXY, controlUrl: PROXY, sessionId: "s1" });
    const query = new SessionQuery({ ...lm, wait: async () => trace } as never, { withoutTools: true });
    const filtered = await query.wait();
    expect(filtered.calls).toHaveLength(2);
    expect(filtered.since(1)).toHaveLength(1);
    expect(filtered.since(1)[0]?.promptText).toMatch(/SEED_X|need tools|sunny/);
  });

  it("fails noErrors and notCalled on empty filters unless allowEmpty", async () => {
    const last = trace.calls.length;
    await expect(scopeFor(trace, { withoutTools: true, offersTool: "missing" }).soft().noErrors()).resolves.toMatchObject({
      pass: false,
    });
    await expect(scopeFor(trace, { offersTool: "missing" }).noErrors()).rejects.toThrow(/no calls matched query/);
    await expect(scopeFor(trace, { offersTool: "missing" }).notCalled("x")).rejects.toThrow(
      /no calls matched query \(offersTool=missing\); session has 3 calls/,
    );
    await expect(scopeFor(trace, { since: last }).noErrors()).rejects.toThrow(/no calls matched query \(since=3\)/);
    await expect(scopeFor(trace, { since: last, allowEmpty: true }).noErrors()).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace, { since: last, allowEmpty: true }).notCalled("x")).resolves.toMatchObject({
      pass: true,
    });
    await expect(scopeFor(trace, { since: last }).callCount(0)).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace, { withoutTools: true }).noErrors()).resolves.toMatchObject({ pass: true });
    expect(formatEmptyFilterMessage({ withoutTools: true, since: 3 }, 8)).toBe(
      "no calls matched query (withoutTools, since=3); session has 8 calls",
    );
  });
});

describe("mentionsAny", () => {
  it("matches the shared number and case table", () => {
    expect(mentionsAny("The temperature is 20°C today", ["20 °C"])).toBe(true);
    expect(mentionsAny("The temperature is 20 °C today", ["20°C"])).toBe(true);
    expect(mentionsAny("It is about 20 degrees outside", ["20°C"])).toBe(true);
    expect(mentionsAny("Moderate cardiovascular risk", ["moderate"])).toBe(true);
    expect(mentionsAny("MODERATE", ["Moderate"])).toBe(true);
    expect(mentionsAny("20°C today", ["20 °C"], { normalizeNumbers: false })).toBe(false);
    expect(mentionsAny("Moderate", ["moderate"], { casefold: false })).toBe(false);
    expect(mentionsAny("model gpt-4.1-mini-2025-04-14", ["20"])).toBe(false);
    expect(mentionsAny("cost 120 euros", ["20"])).toBe(false);
    expect(mentionsAny("it is 20 C", ["20"])).toBe(true);
  });

  it("lists candidates and a 200-char excerpt on no match", () => {
    const text = `${"x".repeat(180)} unique-tail-should-truncate-${"y".repeat(40)}`;
    const failed = mentionsAnyResult(text, ["20", "sunny"]);
    expect(failed.pass).toBe(false);
    expect(failed.message).toMatch(/"20"/);
    expect(failed.message).toMatch(/"sunny"/);
    expect(failed.message).toMatch(/excerpt:/);
    expect(failed.message.length).toBeLessThan(text.length + 80);
  });
});

describe("finalResponseMentionsAny and toolResultInPrompt", () => {
  const clean = normalizeSessionTrace("s1", { id: "s1", calls: [SPECIALIST, FOLLOW_UP] });
  const mutated = normalizeSessionTrace("s1", {
    id: "s1",
    calls: [
      SPECIALIST,
      {
        ...FOLLOW_UP,
        request: { model: "gpt-4.1-mini", messages: [{ role: "user", content: "no tool result" }] },
        response: { choices: [{ message: { content: "I do not know." } }] },
      },
    ],
  });

  it("passes on a golden tool round-trip and fails on a mutated trace", async () => {
    await expect(scopeFor(clean).toolResultInPrompt("lookup_weather")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(clean, { offersTool: "lookup_weather" }).toolResultInPrompt("lookup_weather")).resolves.toMatchObject({
      pass: true,
    });
    await expect(scopeFor(clean).toolResultInPrompt("lookup_weather", "SEED_X")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(clean).soft().toolResultInPrompt("lookup_weather", "SEED_Y")).resolves.toMatchObject({
      pass: false,
    });
    await expect(scopeFor(clean).promptContains("SEED_X")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(clean).finalResponseMentionsAny(["20", "sunny"])).resolves.toMatchObject({ pass: true });

    await expect(scopeFor(mutated).soft().toolResultInPrompt("lookup_weather")).resolves.toMatchObject({ pass: false });
    await expect(scopeFor(mutated).soft().finalResponseMentionsAny(["20", "sunny"])).resolves.toMatchObject({
      pass: false,
    });
  });

  it("does not treat response metadata as the final answer", async () => {
    const toolOnly = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.chat",
          response: {
            id: "chatcmpl_meta",
            model: "gpt-4.1-mini-2025-04-14",
            choices: [{ finish_reason: "tool_calls", message: { tool_calls: [] } }],
            usage: { total_tokens: 20 },
          },
        },
      ],
    });
    expect(toolOnly.calls[0]?.responseText).toBeUndefined();
    await expect(scopeFor(toolOnly).soft().finalResponseMentionsAny(["20"])).resolves.toMatchObject({ pass: false });
  });

  it("does not treat prior request tool_calls as the current response call", async () => {
    const replay = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          api_family: "openai.chat",
          request: {
            messages: [
              {
                role: "assistant",
                tool_calls: [
                  { id: "call_old", type: "function", function: { name: "lookup_weather", arguments: "{}" } },
                ],
              },
            ],
          },
          response: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
        },
        {
          api_family: "openai.chat",
          request: { messages: [{ role: "tool", tool_call_id: "call_old", content: "SEED_X" }] },
          response: { choices: [{ message: { content: "done" } }] },
        },
      ],
    });
    await expect(scopeFor(replay).soft().toolResultInPrompt("lookup_weather")).resolves.toMatchObject({ pass: false });
  });
});

describe("soft collect-then-fail", () => {
  it("reports three failing checks in one failure", async () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [ROUTER] });
    const soft = scopeFor(trace).soft();
    await soft.toolCalled("missing_one");
    await soft.toolCalled("missing_two");
    await soft.callCount(99);
    await expect(soft.check()).rejects.toThrow(/missing_one[\s\S]*missing_two[\s\S]*99/);
  });

  it("appends the trace summary once for a soft failure set", async () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [ROUTER] });
    const soft = scopeFor(trace).soft();
    await soft.toolCalled("missing_one");
    await soft.toolCalled("missing_two");
    await soft.callCount(99);
    const error = await soft.check().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionAssertionError);
    const message = (error as SessionAssertionError).message;
    expect(message.match(/llmentary trace summary/g)).toHaveLength(1);
    expect(message).toMatch(/missing_one/);
    expect(message).toMatch(/missing_two/);
    expect(message).toMatch(/99/);
  });
});

describe("trace summary attribution", () => {
  it("omits empty finish, skips call-keys noise, and shows src/tokens", () => {
    const trace = normalizeSessionTrace("s1", {
      id: "s1",
      calls: [
        {
          ...ROUTER,
          session_source: "path",
          upstream: { url: "https://api.openai.com/v1/chat/completions" },
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        },
        {
          ...SPECIALIST,
          session_source: "header",
          upstream: { url: "https://api.openai.com/v1/chat/completions" },
        },
        {
          ...FOLLOW_UP,
          session_source: "baggage",
        },
        {
          api_family: "openai.chat",
          session_source: "default",
          status: 401,
          error: { message: "invalid_api_key", type: "invalid_request_error", code: "invalid_api_key" },
          request: { model: "gpt-4.1-mini", messages: [{ role: "user", content: "ping" }] },
          response: { error: { message: "invalid_api_key" } },
        },
        {
          api_family: "openai.chat",
          session_source: "path",
          request: { model: "gpt-4.1-mini", messages: [{ role: "user", content: "stream" }] },
          response: { finish_reason: "unknown", output_text: "partial" },
        },
        { leftover: true, debug: ["noise"] },
      ],
    });
    const summary = formatTraceSummary(trace);
    expect(summary).not.toMatch(/call keys=/);
    expect(summary).not.toMatch(/finish=unknown/);
    expect(summary).not.toMatch(/finish=-/);
    expect(summary).toMatch(/src=path/);
    expect(summary).toMatch(/src=header/);
    expect(summary).toMatch(/src=baggage/);
    expect(summary).toMatch(/src=default/);
    expect(summary).toMatch(/tokens=8\/3/);
    expect(summary).toMatch(/unparsed call, keys=\[leftover,debug\]/);
    expect(summary).toMatch(/finish=stop/);
    expect(summary).toMatch(/finish=tool_calls/);
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
