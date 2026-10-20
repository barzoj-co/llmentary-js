import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatGoDurationMs,
  formatWaitTimeoutError,
  parseWaitDuration,
  parseWaitDurationMs,
  resetWaitEnvDeprecationWarnings,
  resolveWait,
} from "../src/wait.js";

const WAIT_ENV = [
  "LLMENTARY_WAIT_TIMEOUT",
  "LLMENTARY_WAIT_QUIET",
  "LLMENTARY_WAIT_TIMEOUT_MS",
  "LLMENTARY_WAIT_IDLE_MS",
] as const;

const previous: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of WAIT_ENV) {
    if (!(key in previous)) continue;
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
    delete previous[key];
  }
  resetWaitEnvDeprecationWarnings();
});

function stash(key: (typeof WAIT_ENV)[number], value: string | undefined): void {
  if (!(key in previous)) previous[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("parseWaitDuration", () => {
  it.each([
    ["45", 45_000],
    ["45s", 45_000],
    ["0.2", 200],
    ["200ms", 200],
    ["1m30s", 90_000],
  ] as const)("parses %s as %d ms", (raw, ms) => {
    expect(parseWaitDuration(raw, "LLMENTARY_WAIT_TIMEOUT")).toBe(ms);
    expect(formatGoDurationMs(parseWaitDuration(raw, "LLMENTARY_WAIT_QUIET"))).toBe(
      ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`,
    );
  });

  it("names the variable when the value is invalid", () => {
    expect(() => parseWaitDuration("not-a-duration", "LLMENTARY_WAIT_TIMEOUT")).toThrow(
      /invalid LLMENTARY_WAIT_TIMEOUT value "not-a-duration"/,
    );
    expect(() => parseWaitDuration("", "LLMENTARY_WAIT_QUIET")).toThrow(/invalid LLMENTARY_WAIT_QUIET value/);
    expect(() => parseWaitDuration("1e3", "LLMENTARY_WAIT_TIMEOUT")).toThrow(/LLMENTARY_WAIT_TIMEOUT/);
  });
});

describe("parseWaitDurationMs", () => {
  it("treats a bare number as milliseconds for the deprecated JS env names", () => {
    expect(parseWaitDurationMs("45", "LLMENTARY_WAIT_TIMEOUT_MS")).toBe(45);
    expect(parseWaitDurationMs("200", "LLMENTARY_WAIT_IDLE_MS")).toBe(200);
    expect(parseWaitDurationMs("45s", "LLMENTARY_WAIT_TIMEOUT_MS")).toBe(45_000);
    expect(parseWaitDurationMs("200ms", "LLMENTARY_WAIT_IDLE_MS")).toBe(200);
  });

  it("names the deprecated variable when the value is invalid", () => {
    expect(() => parseWaitDurationMs("nope", "LLMENTARY_WAIT_TIMEOUT_MS")).toThrow(
      /invalid LLMENTARY_WAIT_TIMEOUT_MS value "nope"/,
    );
    expect(() => parseWaitDurationMs("nope", "LLMENTARY_WAIT_IDLE_MS")).toThrow(
      /invalid LLMENTARY_WAIT_IDLE_MS value "nope"/,
    );
  });
});

describe("resolveWait env", () => {
  it("reads LLMENTARY_WAIT_TIMEOUT and LLMENTARY_WAIT_QUIET", () => {
    stash("LLMENTARY_WAIT_TIMEOUT", "90");
    stash("LLMENTARY_WAIT_QUIET", "0.2");
    expect(resolveWait()).toEqual({
      timeout: "90s",
      quiet: "200ms",
      timeoutMs: 90_000,
      quietMs: 200,
    });
  });

  it("accepts Go durations on the shared env names", () => {
    stash("LLMENTARY_WAIT_TIMEOUT", "45s");
    stash("LLMENTARY_WAIT_QUIET", "200ms");
    expect(resolveWait()).toMatchObject({ timeout: "45s", quiet: "200ms" });
  });

  it("uses deprecated JS millisecond env names with a one-time warning", () => {
    stash("LLMENTARY_WAIT_TIMEOUT_MS", "45000");
    stash("LLMENTARY_WAIT_IDLE_MS", "200");
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      expect(resolveWait()).toEqual({
        timeout: "45s",
        quiet: "200ms",
        timeoutMs: 45_000,
        quietMs: 200,
      });
      expect(resolveWait()).toMatchObject({ timeout: "45s", quiet: "200ms" });
      const messages = emitWarning.mock.calls.map((call) => String(call[0]));
      const timeoutWarnings = messages.filter((message) => message.includes("LLMENTARY_WAIT_TIMEOUT_MS"));
      const idleWarnings = messages.filter((message) => message.includes("LLMENTARY_WAIT_IDLE_MS"));
      expect(timeoutWarnings).toHaveLength(1);
      expect(idleWarnings).toHaveLength(1);
      expect(timeoutWarnings[0]).toMatch(/deprecated.*LLMENTARY_WAIT_TIMEOUT/);
      expect(idleWarnings[0]).toMatch(/deprecated.*LLMENTARY_WAIT_QUIET/);
    } finally {
      emitWarning.mockRestore();
    }
  });

  it("prefers the new env names over the deprecated millisecond aliases", () => {
    stash("LLMENTARY_WAIT_TIMEOUT", "90");
    stash("LLMENTARY_WAIT_QUIET", "0.2");
    stash("LLMENTARY_WAIT_TIMEOUT_MS", "1000");
    stash("LLMENTARY_WAIT_IDLE_MS", "50");
    expect(resolveWait()).toMatchObject({ timeout: "90s", quiet: "200ms" });
  });

  it("passes minCalls through resolveWait", () => {
    expect(resolveWait({ minCalls: 2 })).toMatchObject({ minCalls: 2, timeout: "30s", quiet: "500ms" });
  });

  it("throws an error naming the invalid env variable", () => {
    stash("LLMENTARY_WAIT_TIMEOUT", "fast");
    expect(() => resolveWait()).toThrow(/invalid LLMENTARY_WAIT_TIMEOUT value "fast"/);
    delete process.env.LLMENTARY_WAIT_TIMEOUT;
    stash("LLMENTARY_WAIT_QUIET", "zzz");
    expect(() => resolveWait()).toThrow(/invalid LLMENTARY_WAIT_QUIET value "zzz"/);
    delete process.env.LLMENTARY_WAIT_QUIET;
    stash("LLMENTARY_WAIT_TIMEOUT_MS", "bad");
    expect(() => resolveWait()).toThrow(/invalid LLMENTARY_WAIT_TIMEOUT_MS value "bad"/);
  });
});

describe("formatWaitTimeoutError", () => {
  it("matches the shared timeout error text", () => {
    expect(formatWaitTimeoutError("sess-1", "30s", 3, 1)).toBe(
      "wait timed out after 30s on session sess-1 (3 calls so far, still active: 1). Raise LLMENTARY_WAIT_TIMEOUT if the graph needs more time.",
    );
  });
});
