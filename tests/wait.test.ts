import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatGoDurationMs,
  formatWaitTimeoutError,
  mergeWaitOptions,
  parseWaitDuration,
  parseWaitDurationMs,
  resetWaitEnvDeprecationWarnings,
  resolveWait,
  resolvedWaitToOptions,
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

  it("passes excludeCancelled through resolveWait", () => {
    expect(resolveWait({ excludeCancelled: true })).toMatchObject({
      excludeCancelled: true,
      timeout: "30s",
      quiet: "500ms",
    });
    expect(resolveWait({ excludeCancelled: false })).toMatchObject({ excludeCancelled: false });
    expect(resolveWait()).not.toHaveProperty("excludeCancelled");
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
      "wait timed out after 30s on session sess-1 (3 calls so far, still active: 1). Raise LLMENTARY_WAIT_TIMEOUT if the app needs more time.",
    );
  });

  it("lists in-flight calls when the proxy sent them", () => {
    expect(
      formatWaitTimeoutError("stall-example", "30s", 0, 1, [
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers" },
      ]),
    ).toBe(
      "wait timed out after 30s on session stall-example (0 calls so far, still active: 1 [POST /v1/responses awaiting_headers]). The upstream has not sent headers yet; set LLMENTARY_UPSTREAM_HEADER_TIMEOUT to fail such calls fast.",
    );
    expect(
      formatWaitTimeoutError("stall-stream-example", "2s", 0, 1, [
        { method: "POST", path: "/v1/chat/completions", phase: "streaming", httpStatus: 200 },
      ]),
    ).toContain("still active: 1 [POST /v1/chat/completions streaming 200]");
    expect(formatWaitTimeoutError("quiet", "1s", 0, 0, [])).toContain("still active: 0)");
  });
});

describe("wait timeout hint", () => {
  it("raises LLMENTARY_WAIT_TIMEOUT when nothing is active", () => {
    expect(formatWaitTimeoutError("idle", "30s", 2, 0, [])).toBe(
      "wait timed out after 30s on session idle (2 calls so far, still active: 0). Raise LLMENTARY_WAIT_TIMEOUT if the app needs more time.",
    );
    expect(formatWaitTimeoutError("idle", "30s", 2, 1)).toBe(
      "wait timed out after 30s on session idle (2 calls so far, still active: 1). Raise LLMENTARY_WAIT_TIMEOUT if the app needs more time.",
    );
  });

  it("names LLMENTARY_UPSTREAM_HEADER_TIMEOUT for awaiting_headers calls", () => {
    expect(
      formatWaitTimeoutError("hdr", "30s", 0, 1, [
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers", elapsedMs: 1395 },
      ]),
    ).toBe(
      "wait timed out after 30s on session hdr (0 calls so far, still active: 1 [POST /v1/responses awaiting_headers]). The upstream has not sent headers for 1.4s; set LLMENTARY_UPSTREAM_HEADER_TIMEOUT to fail such calls fast.",
    );
  });

  it("drops the elapsed suffix when no awaiting_headers call has a finite elapsedMs", () => {
    expect(
      formatWaitTimeoutError("hdr-missing", "30s", 0, 1, [
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers" },
      ]),
    ).toBe(
      "wait timed out after 30s on session hdr-missing (0 calls so far, still active: 1 [POST /v1/responses awaiting_headers]). The upstream has not sent headers yet; set LLMENTARY_UPSTREAM_HEADER_TIMEOUT to fail such calls fast.",
    );
    expect(
      formatWaitTimeoutError("hdr-nonfinite", "30s", 0, 2, [
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers", elapsedMs: Number.NaN },
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers", elapsedMs: Number.POSITIVE_INFINITY },
      ]),
    ).toContain("The upstream has not sent headers yet; set LLMENTARY_UPSTREAM_HEADER_TIMEOUT");
    expect(
      formatWaitTimeoutError("hdr-partial", "30s", 0, 2, [
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers" },
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers", elapsedMs: 420 },
      ]),
    ).toContain("The upstream has not sent headers for 0.4s; set LLMENTARY_UPSTREAM_HEADER_TIMEOUT");
  });

  it("names LLMENTARY_UPSTREAM_IDLE_TIMEOUT for streaming calls", () => {
    expect(
      formatWaitTimeoutError("stream", "5s", 1, 1, [
        { method: "POST", path: "/v1/chat/completions", phase: "streaming", httpStatus: 200, elapsedMs: 2500 },
      ]),
    ).toBe(
      "wait timed out after 5s on session stream (1 calls so far, still active: 1 [POST /v1/chat/completions streaming 200]). A call is still streaming; set LLMENTARY_UPSTREAM_IDLE_TIMEOUT to fail stalled streams, or raise LLMENTARY_WAIT_TIMEOUT if the app needs more time.",
    );
  });

  it("prefers the header hint when both phases are in flight", () => {
    expect(
      formatWaitTimeoutError("mixed", "30s", 0, 3, [
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers", elapsedMs: 420 },
        { method: "POST", path: "/v1/chat/completions", phase: "streaming", httpStatus: 200, elapsedMs: 41_000 },
        { method: "POST", path: "/v1/responses", phase: "awaiting_headers", elapsedMs: 1395 },
      ]),
    ).toBe(
      "wait timed out after 30s on session mixed (0 calls so far, still active: 3 [POST /v1/responses awaiting_headers; POST /v1/chat/completions streaming 200; POST /v1/responses awaiting_headers]). The upstream has not sent headers for 1.4s; set LLMENTARY_UPSTREAM_HEADER_TIMEOUT to fail such calls fast.",
    );
  });
});

describe("wait duration edge cases", () => {
  it("rejects negative and non-finite explicit values", () => {
    expect(() => resolveWait({ timeout: -1 })).toThrow(/invalid LLMENTARY_WAIT_TIMEOUT/);
    expect(() => resolveWait({ timeoutMs: -5 })).toThrow(/invalid LLMENTARY_WAIT_TIMEOUT/);
    expect(() => resolveWait({ timeoutMs: Number.POSITIVE_INFINITY })).toThrow(/invalid LLMENTARY_WAIT_TIMEOUT/);
    expect(() => resolveWait({ quiet: -0.1 })).toThrow(/invalid LLMENTARY_WAIT_QUIET/);
    expect(() => formatGoDurationMs(-1)).toThrow(/cannot format wait duration/);
    expect(() => formatGoDurationMs(Number.NaN)).toThrow(/cannot format wait duration/);
    expect(() => parseWaitDurationMs("-1", "LLMENTARY_WAIT_TIMEOUT_MS")).toThrow(/LLMENTARY_WAIT_TIMEOUT_MS/);
  });

  it("parses stacked Go units including ns/us/h and rejects gaps", () => {
    expect(parseWaitDuration("1h2m3s", "LLMENTARY_WAIT_TIMEOUT")).toBe(3_723_000);
    expect(parseWaitDuration("500us", "LLMENTARY_WAIT_QUIET")).toBe(1);
    expect(parseWaitDuration("1000ns", "LLMENTARY_WAIT_QUIET")).toBe(0);
    expect(() => parseWaitDuration("1s 2s", "LLMENTARY_WAIT_TIMEOUT")).toThrow(/LLMENTARY_WAIT_TIMEOUT/);
    expect(() => parseWaitDuration("1x", "LLMENTARY_WAIT_TIMEOUT")).toThrow(/LLMENTARY_WAIT_TIMEOUT/);
  });

  it("omits minCalls from resolvedWaitToOptions unless set", () => {
    expect(resolvedWaitToOptions(resolveWait())).not.toHaveProperty("minCalls");
    expect(resolvedWaitToOptions(resolveWait({ minCalls: 3 }))).toMatchObject({ minCalls: 3 });
  });

  it("omits excludeCancelled from resolvedWaitToOptions unless set", () => {
    expect(resolvedWaitToOptions(resolveWait())).not.toHaveProperty("excludeCancelled");
    expect(resolvedWaitToOptions(resolveWait({ excludeCancelled: true }))).toMatchObject({ excludeCancelled: true });
    expect(resolvedWaitToOptions(resolveWait({ excludeCancelled: false }))).toMatchObject({ excludeCancelled: false });
  });

  it("overrides excludeCancelled in mergeWaitOptions", () => {
    expect(mergeWaitOptions({ timeout: "30s" }, { excludeCancelled: true })).toMatchObject({
      timeout: "30s",
      excludeCancelled: true,
    });
    expect(mergeWaitOptions({ excludeCancelled: true }, {})).toMatchObject({ excludeCancelled: true });
    expect(mergeWaitOptions({ excludeCancelled: true }, { excludeCancelled: false })).toMatchObject({
      excludeCancelled: false,
    });
    expect(mergeWaitOptions({ timeout: "30s", minCalls: 1 })).not.toHaveProperty("excludeCancelled");
  });

  it("replaces timeout/quiet pairs independently and keeps an override signal", () => {
    const signal = new AbortController().signal;
    const merged = mergeWaitOptions(
      { timeout: "30s", timeoutMs: 30_000, quiet: "500ms", idleMs: 500, minCalls: 1 },
      { timeoutMs: 5_000, idleMs: 100, signal, minCalls: 4 },
    );
    expect(merged).toMatchObject({ timeoutMs: 5_000, idleMs: 100, minCalls: 4 });
    expect(merged).not.toHaveProperty("timeout");
    expect(merged).not.toHaveProperty("quiet");
    expect(merged.signal).toBe(signal);

    const timeoutOnly = mergeWaitOptions({ timeout: "30s", quiet: "500ms" }, { timeout: "10s" });
    expect(timeoutOnly).toMatchObject({ timeout: "10s", quiet: "500ms" });
    const quietOnly = mergeWaitOptions({ timeout: "30s", idleMs: 500 }, { quiet: "200ms" });
    expect(quietOnly).toMatchObject({ timeout: "30s", quiet: "200ms" });
    expect(quietOnly).not.toHaveProperty("idleMs");
    expect(mergeWaitOptions({ timeout: "30s" })).toMatchObject({ timeout: "30s" });
  });
});
