import { describe, expect, it } from "vitest";
import { AssertionScope, isolationCheck } from "../src/assertions.js";
import { ControlClient, SessionNotFound, type ControlFetch } from "../src/control.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { JsonValue, SessionTrace } from "../src/types.js";

const WEATHER_USER = "Ask only for the ZURICH_QUAYZE weather token.";
const BARGE_USER = "Ask only for the LISBON_FERRY story token.";
const SHARED_SYSTEM = "Never mention Amsterdam weather or get_current_weather.";

function sessionTrace(
  id: string,
  calls: Array<Record<string, unknown>>,
): SessionTrace {
  return normalizeSessionTrace(id, { id, calls: calls as JsonValue[] });
}

function chatCall(options: {
  id: string;
  seq: number;
  sessionId: string;
  user: string;
  system?: string;
  tools?: string[];
  sessionSource?: string;
}): Record<string, unknown> {
  return {
    id: options.id,
    seq: options.seq,
    session_id: options.sessionId,
    session_source: options.sessionSource ?? "path",
    api_family: "openai.chat",
    request: {
      model: "gpt-4.1-mini",
      messages: [
        ...(options.system ? [{ role: "system", content: options.system }] : []),
        { role: "user", content: options.user },
      ],
      ...(options.tools
        ? { tools: options.tools.map((name) => ({ type: "function", function: { name } })) }
        : {}),
    },
    response: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] },
  };
}

function scopeFor(self: SessionTrace, other: SessionTrace): AssertionScope {
  return new AssertionScope({
    control: {
      wait: async (sessionId: string) => {
        if (sessionId === self.id) return self;
        if (sessionId === other.id) return other;
        throw new SessionNotFound(sessionId, { status: 404, path: `/sessions/${sessionId}/wait`, body: "" });
      },
    } as never,
    sessionId: self.id,
  });
}

describe("isolatedFrom", () => {
  it("passes for two sessions with distinct user turns", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER, system: SHARED_SYSTEM, tools: ["get_current_weather"] }),
    ]);
    const barge = sessionTrace("barge", [
      chatCall({ id: "call_1", seq: 1, sessionId: "barge", user: BARGE_USER, system: SHARED_SYSTEM }),
    ]);
    await expect(scopeFor(weather, barge).isolatedFrom("barge")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(weather, barge).isolatedFrom({ sessionId: "barge" })).resolves.toMatchObject({
      pass: true,
    });
  });

  it("ignores a system prompt that names the other session's tool", async () => {
    const barge = sessionTrace("barge", [
      chatCall({
        id: "call_1",
        seq: 1,
        sessionId: "barge",
        user: BARGE_USER,
        system: SHARED_SYSTEM,
      }),
    ]);
    const weather = sessionTrace("weather", [
      chatCall({
        id: "call_3",
        seq: 1,
        sessionId: "weather",
        user: WEATHER_USER,
        tools: ["get_current_weather"],
      }),
    ]);
    const result = isolationCheck(barge, "barge", weather, "weather");
    expect(result.pass).toBe(true);
    await expect(scopeFor(barge, weather).isolatedFrom(weather.id)).resolves.toMatchObject({ pass: true });
  });

  it("passes when both sessions send the same canned user text", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER }),
    ]);
    const barge = sessionTrace("barge", [
      chatCall({ id: "call_1", seq: 1, sessionId: "barge", user: WEATHER_USER }),
    ]);
    const result = isolationCheck(weather, "weather", barge, "barge");
    expect(result.pass).toBe(true);
    await expect(scopeFor(weather, barge).isolatedFrom("barge")).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(barge, weather).isolatedFrom("weather")).resolves.toMatchObject({ pass: true });
  });

  it("passes when a short greeting is a substring of the other session's turn", () => {
    const hello = sessionTrace("hello", [
      chatCall({ id: "call_a", seq: 1, sessionId: "hello", user: "Hi" }),
    ]);
    const long = sessionTrace("long", [
      chatCall({
        id: "call_b",
        seq: 1,
        sessionId: "long",
        user: "Hi, what is my biological age? This text is long.",
      }),
    ]);
    expect(isolationCheck(hello, "hello", long, "long").pass).toBe(true);
    expect(isolationCheck(long, "long", hello, "hello").pass).toBe(true);
  });

  it("fails when a session's prompt replays a user turn only the other introduced", () => {
    const original = sessionTrace("iso-a", [
      chatCall({ id: "call_h", seq: 1, sessionId: "iso-a", user: "What is my biological age?" }),
    ]);
    const replay = sessionTrace("iso-c", [
      {
        id: "call_m",
        seq: 1,
        session_id: "iso-c",
        session_source: "path",
        api_family: "openai.chat",
        request: {
          model: "gpt-4.1-mini",
          messages: [
            { role: "user", content: "What is my biological age?" },
            { role: "assistant", content: "42" },
            { role: "user", content: "And my BMI?" },
          ],
        },
        response: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] },
      },
    ]);
    const result = isolationCheck(replay, "iso-c", original, "iso-a");
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/user text .*What is my biological age\?/);
    expect(result.message).toMatch(/session iso-c #1 \(call_m\)/);
    expect(result.message).toMatch(/session iso-a #1 \(call_h\)/);
    expect(isolationCheck(original, "iso-a", replay, "iso-c").pass).toBe(true);
  });

  it("does not treat first-call inbound history as introduced, even if a later call repeats it", () => {
    const origin = sessionTrace("iso-a", [
      chatCall({ id: "call_y1", seq: 1, sessionId: "iso-a", user: "What is my biological age?" }),
    ]);
    const replay = sessionTrace("iso-x", [
      {
        id: "call_x1",
        seq: 1,
        session_id: "iso-x",
        request: {
          messages: [
            { role: "user", content: "What is my biological age?" },
            { role: "assistant", content: "I need more data." },
            { role: "user", content: "Continue from the saved thread." },
          ],
        },
      },
      chatCall({ id: "call_x2", seq: 2, sessionId: "iso-x", user: "What is my biological age?" }),
    ]);
    const shuffled = sessionTrace("iso-x", [
      chatCall({ id: "call_x2", seq: 2, sessionId: "iso-x", user: "A later turn from X only." }),
      {
        id: "call_x1",
        seq: 1,
        session_id: "iso-x",
        request: {
          messages: [
            { role: "user", content: "What is my biological age?" },
            { role: "assistant", content: "I need more data." },
            { role: "user", content: "Continue from the saved thread." },
          ],
        },
      },
    ]);
    for (const self of [replay, shuffled]) {
      const result = isolationCheck(self, "iso-x", origin, "iso-a");
      expect(result.pass, result.message).toBe(false);
      expect(result.message).toContain("user text 'What is my biological age?'");
      expect(result.message).toContain("also introduced by session iso-a #1 (call_y1)");
      expect(result.message).toContain("appears in session iso-x #1 (call_x1)");
    }
  });

  it("fails when a call has a foreign sessionId", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "barge", user: WEATHER_USER }),
    ]);
    const barge = sessionTrace("barge", [
      chatCall({ id: "call_1", seq: 1, sessionId: "barge", user: BARGE_USER }),
    ]);
    const result = isolationCheck(weather, "weather", barge, "barge");
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/session_id=barge, expected weather/);
    expect(result.message).toMatch(/#1 \(call_3\)/);
  });

  it("fails an empty self or empty other session unless allowEmpty", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER }),
    ]);
    const empty = sessionTrace("barge", []);
    expect(isolationCheck(weather, "weather", empty, "barge").pass).toBe(false);
    expect(isolationCheck(weather, "weather", empty, "barge").message).toBe(
      "no calls recorded for session barge (isolated_from needs calls on both sides)",
    );
    expect(isolationCheck(weather, "weather", empty, "barge", { allowEmpty: true }).pass).toBe(true);
    expect(isolationCheck(empty, "barge", weather, "weather").message).toBe("no calls recorded for session barge");
    expect(isolationCheck(empty, "barge", weather, "weather", { allowEmpty: true }).pass).toBe(true);
    expect(isolationCheck(empty, "barge", empty, "barge", { allowEmpty: true }).pass).toBe(true);
    await expect(scopeFor(weather, empty).isolatedFrom("barge")).rejects.toThrow(
      /no calls recorded for session barge \(isolated_from needs calls on both sides\)/,
    );
    await expect(scopeFor(weather, empty).allowEmpty().isolatedFrom("barge")).resolves.toMatchObject({
      pass: true,
    });
    await expect(scopeFor(empty, weather).isolatedFrom("weather")).rejects.toThrow(
      /no calls recorded for session barge/,
    );
    await expect(scopeFor(empty, weather).allowEmpty().isolatedFrom("weather")).resolves.toMatchObject({
      pass: true,
    });
  });

  it("fails isolatedFrom on a never-created or mistyped other unless allowEmpty (DOG-32)", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER }),
    ]);
    const scope = new AssertionScope({
      control: {
        wait: async (sessionId: string) => {
          if (sessionId === weather.id) return weather;
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
        listSessions: async () => [{ id: weather.id }],
      } as never,
      sessionId: weather.id,
    });
    await expect(scope.isolatedFrom("never-created")).rejects.toThrow(
      /no calls recorded for session never-created \(isolated_from needs calls on both sides\)/,
    );
    await expect(scope.isolatedFrom("never-created")).rejects.not.toBeInstanceOf(SessionNotFound);
    await expect(scope.isolatedFrom("weather-typo")).rejects.toThrow(
      /no calls recorded for session weather-typo \(isolated_from needs calls on both sides\)/,
    );
    await expect(scope.allowEmpty().isolatedFrom("never-created")).resolves.toMatchObject({ pass: true });
    await expect(scope.isolatedFrom("never-created", { allowEmpty: true })).resolves.toMatchObject({
      pass: true,
    });
  });

  it("introduces every new user-role message on a later call (DOG-33)", () => {
    const self = sessionTrace("sess-p", [
      chatCall({ id: "call_p1", seq: 1, sessionId: "sess-p", user: "Opening question number one" }),
      {
        id: "call_p2",
        seq: 2,
        session_id: "sess-p",
        request: {
          messages: [
            { role: "user", content: "Opening question number one" },
            { role: "user", content: "Second message sent by P itself" },
            { role: "user", content: "Third message sent by P itself" },
          ],
        },
      },
    ]);
    const other = sessionTrace("sess-q", [
      chatCall({ id: "call_q1", seq: 1, sessionId: "sess-q", user: "Second message sent by P itself" }),
    ]);
    const result = isolationCheck(self, "sess-p", other, "sess-q");
    expect(result.pass, result.message).toBe(true);
    expect(isolationCheck(other, "sess-q", self, "sess-p").pass).toBe(true);
  });

  it("treats a later call as later even when the first call has no user messages", () => {
    const self = sessionTrace("sess-p", [
      {
        id: "call_p1",
        seq: 1,
        session_id: "sess-p",
        request: { messages: [{ role: "system", content: "No user text on the first call." }] },
      },
      {
        id: "call_p2",
        seq: 2,
        session_id: "sess-p",
        request: {
          messages: [
            { role: "user", content: "Second message sent by P itself" },
            { role: "user", content: "Third message sent by P itself" },
          ],
        },
      },
    ]);
    const other = sessionTrace("sess-q", [
      chatCall({ id: "call_q1", seq: 1, sessionId: "sess-q", user: "Second message sent by P itself" }),
    ]);
    const result = isolationCheck(self, "sess-p", other, "sess-q");
    expect(result.pass, result.message).toBe(true);
  });

  it("introduces the first call's last user message even when it repeats inbound history", () => {
    const self = sessionTrace("sess-p", [
      {
        id: "call_p1",
        seq: 1,
        session_id: "sess-p",
        request: {
          messages: [
            { role: "user", content: "Please summarize the visit notes" },
            { role: "user", content: "Please summarize the visit notes" },
          ],
        },
      },
    ]);
    const other = sessionTrace("sess-q", [
      chatCall({ id: "call_q1", seq: 1, sessionId: "sess-q", user: "Please summarize the visit notes" }),
    ]);
    const result = isolationCheck(self, "sess-p", other, "sess-q");
    expect(result.pass, result.message).toBe(true);
  });

  it("honours isolatedFrom({ allowEmpty: true }) on an empty self without mutating the scope", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER }),
    ]);
    const empty = sessionTrace("barge", []);
    const scope = scopeFor(empty, weather);
    const [isolated, errors] = await Promise.allSettled([
      scope.isolatedFrom("weather", { allowEmpty: true }),
      scope.noErrors(),
    ]);
    expect(isolated.status).toBe("fulfilled");
    if (isolated.status === "fulfilled") expect(isolated.value).toMatchObject({ pass: true });
    expect(errors.status).toBe("rejected");
    await expect(scope.isolatedFrom("weather")).rejects.toThrow(/no calls recorded for session barge/);
  });

  it("still treats first-call inbound history as seen, not introduced", () => {
    const self = sessionTrace("sess-p", [
      {
        id: "call_p1",
        seq: 1,
        session_id: "sess-p",
        request: {
          messages: [
            { role: "user", content: "Second message sent by P itself" },
            { role: "user", content: "Third message sent by P itself" },
          ],
        },
      },
    ]);
    const other = sessionTrace("sess-q", [
      chatCall({ id: "call_q1", seq: 1, sessionId: "sess-q", user: "Second message sent by P itself" }),
    ]);
    const result = isolationCheck(self, "sess-p", other, "sess-q");
    expect(result.pass).toBe(false);
    expect(result.message).toContain("user text 'Second message sent by P itself'");
  });

  it("does not treat a failed comparison-session lookup as an empty other", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER }),
    ]);
    const fetchImpl: ControlFetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/sessions/weather")) {
        return new Response(JSON.stringify({ id: "weather", calls: weather.calls }), { status: 200 });
      }
      if (url.includes("/wait")) {
        return new Response("upstream timeout", { status: 504, statusText: "Gateway Timeout" });
      }
      return new Response("control unavailable", { status: 503, statusText: "Service Unavailable" });
    };
    const control = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    const scope = new AssertionScope({ control, sessionId: weather.id });
    await expect(scope.isolatedFrom("barge")).rejects.toThrow(/503 Service Unavailable/);
  });

  it("honours minChars and ignoreTexts", () => {
    const leaked = sessionTrace("replay", [
      {
        id: "call_r",
        seq: 1,
        session_id: "replay",
        api_family: "openai.chat",
        request: {
          model: "gpt-4.1-mini",
          messages: [
            { role: "user", content: "Secret token ALPHA_TOKEN" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "Follow up please" },
          ],
        },
        response: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] },
      },
    ]);
    const origin = sessionTrace("origin", [
      chatCall({ id: "call_o", seq: 1, sessionId: "origin", user: "Secret token ALPHA_TOKEN" }),
    ]);
    expect(isolationCheck(leaked, "replay", origin, "origin").pass).toBe(false);
    expect(
      isolationCheck(leaked, "replay", origin, "origin", { ignoreTexts: ["Secret token ALPHA_TOKEN"] }).pass,
    ).toBe(true);
    expect(isolationCheck(leaked, "replay", origin, "origin", { minChars: 80 }).pass).toBe(true);
  });

  it("fails overlapping call ids and optional path-source mismatches", () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER, sessionSource: "header" }),
    ]);
    const barge = sessionTrace("barge", [
      chatCall({ id: "call_3", seq: 1, sessionId: "barge", user: BARGE_USER }),
    ]);
    expect(isolationCheck(weather, "weather", barge, "barge").message).toMatch(
      /call id call_3 appears in sessions weather and barge/,
    );
    expect(isolationCheck(weather, "weather", barge, "barge", { requirePathSource: true }).message).toMatch(
      /sessionSource=header, expected path/,
    );
  });
});
