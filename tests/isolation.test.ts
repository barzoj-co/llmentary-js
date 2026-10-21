import { describe, expect, it } from "vitest";
import { AssertionScope, SessionAssertionError, isolationCheck } from "../src/assertions.js";
import { SessionNotFound } from "../src/control.js";
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

  it("fails when the same user text appears in both sessions", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER }),
    ]);
    const barge = sessionTrace("barge", [
      chatCall({ id: "call_1", seq: 1, sessionId: "barge", user: WEATHER_USER }),
    ]);
    const result = isolationCheck(weather, "weather", barge, "barge");
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/user text .*ZURICH_QUAYZE/);
    expect(result.message).toMatch(/#1 \(call_3\)/);
    expect(result.message).toMatch(/session barge #1 \(call_1\)/);
    await expect(scopeFor(weather, barge).isolatedFrom("barge")).rejects.toThrow(/user text/);
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
    expect(result.message).toMatch(/sessionId=barge, expected weather/);
    expect(result.message).toMatch(/#1 \(call_3\)/);
  });

  it("fails an empty session unless allowEmpty", async () => {
    const weather = sessionTrace("weather", [
      chatCall({ id: "call_3", seq: 1, sessionId: "weather", user: WEATHER_USER }),
    ]);
    const empty = sessionTrace("barge", []);
    expect(isolationCheck(weather, "weather", empty, "barge").pass).toBe(false);
    expect(isolationCheck(weather, "weather", empty, "barge").message).toBe("no calls recorded for session barge");
    expect(isolationCheck(empty, "barge", weather, "weather").message).toBe("no calls recorded for session barge");
    expect(isolationCheck(weather, "weather", empty, "barge", { allowEmpty: true }).pass).toBe(true);
    await expect(scopeFor(weather, empty).isolatedFrom("barge")).rejects.toThrow(
      /no calls recorded for session barge/,
    );
    await expect(scopeFor(weather, empty).allowEmpty().isolatedFrom("barge")).resolves.toMatchObject({
      pass: true,
    });
  });

  it("maps a never-created other session to an assertion error, not SessionNotFound", async () => {
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
    await expect(scope.isolatedFrom("never-created")).rejects.toBeInstanceOf(SessionAssertionError);
    await expect(scope.isolatedFrom("never-created")).rejects.not.toBeInstanceOf(SessionNotFound);
    await expect(scope.isolatedFrom("never-created")).rejects.toThrow(
      /no calls recorded for session never-created/,
    );
    await expect(scope.allowEmpty().isolatedFrom("never-created")).resolves.toMatchObject({ pass: true });
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
