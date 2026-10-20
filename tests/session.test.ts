import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlFetch } from "../src/control.js";
import { llmentary } from "../src/session.js";

describe("llmentary env fallbacks", () => {
  const keys = [
    "LLMENTARY_PROXY_URL",
    "LLMENTARY_CONTROL_URL",
    "LLMENTARY_BEARER_TOKEN",
    "LLMENTARY_CONTROL_TOKEN",
    "LLMENTARY_WAIT_TIMEOUT",
    "LLMENTARY_WAIT_QUIET",
    "LLMENTARY_WAIT_TIMEOUT_MS",
    "LLMENTARY_WAIT_IDLE_MS",
  ] as const;
  const previous: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
      delete previous[key];
    }
  });

  function stash(key: (typeof keys)[number], value: string | undefined): void {
    if (!(key in previous)) previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(() => {
    stash("LLMENTARY_WAIT_TIMEOUT", undefined);
    stash("LLMENTARY_WAIT_QUIET", undefined);
    stash("LLMENTARY_WAIT_TIMEOUT_MS", undefined);
    stash("LLMENTARY_WAIT_IDLE_MS", undefined);
  });

  it("falls through an empty bearer token to LLMENTARY_CONTROL_TOKEN", () => {
    stash("LLMENTARY_BEARER_TOKEN", "  ");
    stash("LLMENTARY_CONTROL_TOKEN", "control-secret");
    const lm = llmentary({ proxyUrl: "http://127.0.0.1:4010" });
    expect(lm.bearerToken).toBe("control-secret");
    expect(lm.constructor.name).toBe("Session");
    expect(lm.query({}).constructor.name).toBe("SessionQuery");
  });

  it("defaults wait to timeout 30s and quiet 500ms", () => {
    const lm = llmentary({ proxyUrl: "http://127.0.0.1:4010" });
    expect(lm.defaultWait.timeout).toBe("30s");
    expect(lm.defaultWait.quiet).toBe("500ms");
    expect(lm.defaultWait.timeoutMs).toBe(30_000);
    expect(lm.defaultWait.idleMs).toBe(500);
  });

  it("resolves wait defaults from LLMENTARY_WAIT_TIMEOUT and LLMENTARY_WAIT_QUIET", () => {
    stash("LLMENTARY_WAIT_TIMEOUT", "90");
    stash("LLMENTARY_WAIT_QUIET", "0.2");
    const lm = llmentary({ proxyUrl: "http://127.0.0.1:4010" });
    expect(lm.defaultWait.timeout).toBe("90s");
    expect(lm.defaultWait.quiet).toBe("200ms");
    expect(lm.defaultWait.timeoutMs).toBe(90_000);
    expect(lm.defaultWait.idleMs).toBe(200);
  });

  it("keeps timeoutMs and idleMs working as defaultWait aliases", () => {
    const lm = llmentary({
      proxyUrl: "http://127.0.0.1:4010",
      defaultWait: { timeoutMs: 25_000, idleMs: 200 },
    });
    expect(lm.defaultWait.timeout).toBe("25s");
    expect(lm.defaultWait.quiet).toBe("200ms");
  });

  it("sends timeout=90s&quiet=200ms from Session.wait when configured to 90 / 0.2", async () => {
    stash("LLMENTARY_WAIT_TIMEOUT", "90");
    stash("LLMENTARY_WAIT_QUIET", "0.2");
    const urls: string[] = [];
    const fetchImpl: ControlFetch = async (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ id: "s1", calls: [] }), { status: 200 });
    };
    const lm = llmentary({
      proxyUrl: "http://127.0.0.1:9",
      controlUrl: "http://127.0.0.1:9",
      fetch: fetchImpl,
    });
    await lm.wait();
    expect(urls[0]?.split("?")[1]).toBe("timeout=90s&quiet=200ms");
    await lm.wait({ minCalls: 2 });
    expect(urls[1]?.split("?")[1]).toBe("timeout=90s&quiet=200ms&min_calls=2");
  });

  it("names LLMENTARY_WAIT_TIMEOUT when the env value is invalid", () => {
    stash("LLMENTARY_WAIT_TIMEOUT", "fast");
    expect(() => llmentary({ proxyUrl: "http://127.0.0.1:4010" })).toThrow(
      /invalid LLMENTARY_WAIT_TIMEOUT value "fast"/,
    );
  });
});
