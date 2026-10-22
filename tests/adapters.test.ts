import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssertionScope } from "../src/assertions.js";
import { cleanupSession, llmentary as jestLlmentary } from "../src/jest.js";
import {
  toHaveNoIgnoredFields,
  toHaveNoSpecViolations,
  toHaveRequestParam,
  toHaveToolCalled,
  toHaveToolCalledTimes,
} from "../src/matchers.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { QueryOptions, SessionTrace } from "../src/types.js";
import { llmentary as vitestLlmentary, setupVitest } from "../src/vitest.js";

const CLEAN = {
  api_family: "openai.chat",
  request: { model: "gpt-4.1-mini", tools: [{ type: "function", function: { name: "lookup_weather" } }] },
  normalized: {
    validation: { request_checked: true, response_checked: true },
    spec_violations: [],
    tool_calls: [{ name: "lookup_weather", arguments: { city: "AMS" } }],
  },
};

describe("jest and vitest session adapters", () => {
  afterEach(async () => {
    await cleanupSession();
  });

  it("reuses the jest no-arg singleton until cleanupSession", async () => {
    const first = jestLlmentary();
    const again = jestLlmentary();
    expect(again).toBe(first);
    const other = jestLlmentary({
      proxyUrl: "http://127.0.0.1:9",
      controlUrl: "http://127.0.0.1:9",
      sessionId: "jest-two",
    });
    expect(other.sessionId).toBe("jest-two");
    expect(other).not.toBe(first);
    await cleanupSession();
    const after = jestLlmentary();
    expect(after).not.toBe(first);
  });

  it("creates a vitest session from an explicit config", () => {
    const configured = vitestLlmentary({
      proxyUrl: "http://127.0.0.1:9",
      controlUrl: "http://127.0.0.1:9",
      sessionId: "vitest-one",
    });
    expect(configured.sessionId).toBe("vitest-one");
  });

  it("creates a vitest singleton when no current session exists", async () => {
    vi.resetModules();
    const { llmentary } = await import("../src/vitest.js");
    const first = llmentary();
    const again = llmentary();
    expect(again).toBe(first);
  });
});

describe("setupVitest", () => {
  const prevProxy = process.env.LLMENTARY_PROXY_URL;
  process.env.LLMENTARY_PROXY_URL = "http://127.0.0.1:9";
  setupVitest({
    session: { proxyUrl: "http://127.0.0.1:9", controlUrl: "http://127.0.0.1:9", sessionId: "setup" },
  });

  afterEach(() => {
    if (prevProxy === undefined) delete process.env.LLMENTARY_PROXY_URL;
    else process.env.LLMENTARY_PROXY_URL = prevProxy;
  });

  it("reuses the beforeEach session on the no-arg vitest factory", () => {
    const lm = vitestLlmentary();
    expect(lm.sessionId).toBe("setup");
  });
});

describe("assertion matchers", () => {
  it("wraps soft assertion results for tools, params, and spec lists", async () => {
    const clean = scopeFor(normalizeSessionTrace("s1", { id: "s1", calls: [CLEAN] }));
    await expect(toHaveToolCalled(clean, "lookup_weather")).resolves.toMatchObject({ pass: true });
    await expect(toHaveToolCalledTimes(clean, "lookup_weather", 1)).resolves.toMatchObject({ pass: true });
    await expect(toHaveRequestParam(clean, "model", "gpt-4.1-mini")).resolves.toMatchObject({ pass: true });
    await expect(toHaveNoSpecViolations(clean)).resolves.toMatchObject({ pass: true });
    await expect(toHaveNoIgnoredFields(clean)).resolves.toMatchObject({ pass: true });

    const empty = scopeFor(normalizeSessionTrace("s2", { id: "s2", calls: [] }));
    const missed = await toHaveToolCalled(empty, "lookup_weather");
    expect(missed.pass).toBe(false);
    expect(missed.message()).toMatch(/lookup_weather|no calls|not called/i);
  });
});

const LIFECYCLE_ENV_KEYS = [
  "LLMENTARY_JEST_RUN_ID",
  "LLMENTARY_JEST_STATE_FILE",
  "LLMENTARY_JEST_OWNER_PID",
  "LLMENTARY_PROXY_URL",
  "LLMENTARY_CONTROL_URL",
  "LLMENTARY_BEARER_TOKEN",
  "LLMENTARY_CONTROL_TOKEN",
] as const;

describe("jest setup and lifecycle modules", () => {
  let previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    previousEnv = new Map(LIFECYCLE_ENV_KEYS.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../src/proxy.js");
    vi.doUnmock("../src/index.js");
    vi.doUnmock("../src/process.js");
    vi.resetModules();
    vi.restoreAllMocks();
    for (const key of LIFECYCLE_ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("extends expect and cleans the session from jest/setup", async () => {
    const beforeAll = vi.fn(async (fn: () => unknown) => fn());
    const afterEachHook = vi.fn();
    const extend = vi.fn();
    vi.stubGlobal("beforeAll", beforeAll);
    vi.stubGlobal("afterEach", afterEachHook);
    vi.stubGlobal("expect", { extend });
    await import("../src/jest/setup.js");
    expect(beforeAll).toHaveBeenCalled();
    expect(afterEachHook).toHaveBeenCalled();
    expect(extend).toHaveBeenCalled();
    const extendArg = extend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(extendArg).toHaveProperty("toHaveToolCalled");
    expect(extendArg).toHaveProperty("toHaveNoSpecViolations");
    const cleanup = afterEachHook.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
    await cleanup?.();
  });

  it("jest globalSetup writes state and globalTeardown stops an owned proxy", async () => {
    vi.resetModules();
    const processMatchesIdentity = vi.fn(async () => true);
    const stopProcessIfMatches = vi.fn(async () => true);
    vi.doMock("../src/process.js", async () => {
      const actual = await vi.importActual<typeof import("../src/process.js")>("../src/process.js");
      return { ...actual, processMatchesIdentity, stopProcessIfMatches };
    });
    vi.doMock("../src/proxy.js", () => ({
      startProxy: vi.fn(async () => ({
        proxyUrl: "http://127.0.0.1:4010",
        controlUrl: "http://127.0.0.1:4011",
        pid: 64_321,
        instanceId: "adapter-instance",
        exePath: process.execPath,
        stop: vi.fn(async () => undefined),
      })),
    }));
    const { default: globalSetup } = await import("../src/jest/globalSetup.js");
    const { default: globalTeardown } = await import("../src/jest/globalTeardown.js");
    let teardownCompleted = false;
    try {
      await globalSetup();
      expect(process.env.LLMENTARY_PROXY_URL).toBe("http://127.0.0.1:4010");
      const runId = process.env.LLMENTARY_JEST_RUN_ID;
      expect(runId).toBeTruthy();
      await globalTeardown();
      teardownCompleted = true;
      expect(stopProcessIfMatches).toHaveBeenCalledWith(
        64_321,
        expect.objectContaining({ instanceId: "adapter-instance" }),
      );
      const { access } = await import("node:fs/promises");
      const { stateFilePath } = await import("../src/jest/state.js");
      await expect(access(stateFilePath(runId!))).rejects.toThrow();
    } finally {
      if (!teardownCompleted) await globalTeardown().catch(() => undefined);
    }
  });

  it("vitest globalSetup applies proxy env and teardown clears it", async () => {
    const stop = vi.fn(async () => undefined);
    vi.resetModules();
    vi.doMock("../src/index.js", async () => {
      const actual = await vi.importActual<typeof import("../src/index.js")>("../src/index.js");
      return {
        ...actual,
        startProxy: vi.fn(async () => ({
          proxyUrl: "http://127.0.0.1:4010",
          controlUrl: "http://127.0.0.1:4011",
          bearerToken: "adapter-token",
          stop,
        })),
      };
    });
    const { globalSetup } = await import("../src/vitest.js");
    let teardown: (() => Promise<void>) | undefined;
    try {
      teardown = await globalSetup();
      expect(process.env.LLMENTARY_PROXY_URL).toBe("http://127.0.0.1:4010");
      expect(process.env.LLMENTARY_BEARER_TOKEN).toBe("adapter-token");
      await teardown();
      teardown = undefined;
      expect(stop).toHaveBeenCalled();
      expect(process.env.LLMENTARY_PROXY_URL).toBeUndefined();
      expect(process.env.LLMENTARY_BEARER_TOKEN).toBeUndefined();
    } finally {
      if (teardown) await teardown().catch(() => undefined);
    }
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
