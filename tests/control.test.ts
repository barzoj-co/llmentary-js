import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlClient,
  SessionNotFound,
  combineAbortSignals,
  formatEmptySessionMessage,
  formatZeroCallsMessage,
  rewriteSessionNotFoundHint,
  parseControlBody,
  parseControlError,
  parseInFlightCalls,
  normalizeProxyConfig,
  normalizeSessionList,
  type ControlFetch,
} from "../src/control.js";
import { WaitTimeoutError, resetWaitEnvDeprecationWarnings } from "../src/wait.js";

const PIN = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "wait_timeout_inflight.json"), "utf8"),
) as {
  awaiting_headers: unknown;
  streaming: unknown;
};

const WAIT_ENV = [
  "LLMENTARY_WAIT_TIMEOUT",
  "LLMENTARY_WAIT_QUIET",
  "LLMENTARY_WAIT_TIMEOUT_MS",
  "LLMENTARY_WAIT_IDLE_MS",
] as const;
const previousWaitEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of WAIT_ENV) {
    if (!(key in previousWaitEnv)) continue;
    if (previousWaitEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousWaitEnv[key];
    delete previousWaitEnv[key];
  }
  resetWaitEnvDeprecationWarnings();
});

function clearWaitEnv(): void {
  for (const key of WAIT_ENV) {
    if (!(key in previousWaitEnv)) previousWaitEnv[key] = process.env[key];
    delete process.env[key];
  }
}

describe("normalizeSessionList", () => {
  it("accepts PascalCase Sessions and spec counters (proxy DOG-38)", () => {
    expect(
      normalizeSessionList({
        Sessions: [
          {
            Id: "sess-a",
            Calls: 2,
            Active: 1,
            Sources: ["path"],
            SpecViolationCount: 3,
            IgnoredFieldCount: 1,
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "sess-a",
        calls: 2,
        active: 1,
        sources: ["path"],
        specViolationCount: 3,
        ignoredFieldCount: 1,
      }),
    ]);
  });

  it("accepts snake_case spec counters on the sessions envelope", () => {
    expect(
      normalizeSessionList({
        sessions: [{ id: "sess-b", calls: 1, active: 0, spec_violation_count: 0, ignored_field_count: 2 }],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "sess-b",
        calls: 1,
        specViolationCount: 0,
        ignoredFieldCount: 2,
      }),
    ]);
  });
});

describe("parseControlBody", () => {
  it("accepts the Go proxy plain-text healthz body", () => {
    expect(parseControlBody("ok\n")).toBe("ok");
  });

  it("parses JSON session payloads", () => {
    expect(parseControlBody('{"id":"s1","calls":[]}')).toEqual({ id: "s1", calls: [] });
  });
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("ControlClient", () => {
  it("sends timeout and quiet as Go duration query params", async () => {
    const urls: string[] = [];
    const fetchImpl: ControlFetch = async (input) => {
      urls.push(requestUrl(input));
      return new Response(JSON.stringify({ id: "s1", calls: [] }), { status: 200 });
    };
    clearWaitEnv();
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      fetch: fetchImpl,
    });
    await client.wait("s1");
    expect(queryString(urls[0])).toBe("timeout=30s&quiet=500ms");
    await client.wait("s1", { timeout: 90, quiet: 0.2 });
    expect(queryString(urls[1])).toBe("timeout=90s&quiet=200ms");
    await client.wait("s1", { timeoutMs: 5_000, idleMs: 100 });
    expect(queryString(urls[2])).toBe("timeout=5s&quiet=100ms");
    await client.wait("s1", { timeout: 5, quiet: "100ms", minCalls: 2 });
    expect(queryString(urls[3])).toBe("timeout=5s&quiet=100ms&min_calls=2");
  });

  it("lists sessions and surfaces SessionNotFound on 404", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/sessions") || url.endsWith("/sessions?source=header")) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "default",
                calls: 3,
                active: 0,
                sources: ["default"],
                first_started_at: "2026-10-20T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/sessions/missing")) {
        return new Response(
          JSON.stringify({
            error: {
              type: "session_not_found",
              message: 'no calls recorded for session "missing"; known sessions: GET /sessions',
            },
          }),
          { status: 404, statusText: "Not Found" },
        );
      }
      if (url.includes("/config")) {
        return new Response(JSON.stringify({ version: "0.2.0-dev", upstreams: { openai: "https://api.openai.com/v1" } }), {
          status: 200,
        });
      }
      return new Response("ok", { status: 200 });
    };
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    await expect(client.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "default", calls: 3, active: 0, sources: ["default"] }),
    ]);
    await expect(client.listSessions({ source: "header" })).resolves.toHaveLength(1);
    await expect(client.getSession("missing")).rejects.toBeInstanceOf(SessionNotFound);
    await expect(client.getSession("missing")).rejects.toThrow(/no calls recorded for session "missing"/);
    await expect(client.getConfig()).resolves.toMatchObject({ version: "0.2.0-dev" });
    expect(formatZeroCallsMessage("abc", ["default", "other"])).toBe(
      "no calls recorded for session abc; known sessions: default, other",
    );
    const missing = await client.getSession("missing").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SessionNotFound);
    expect(String((missing as Error).message).match(/known sessions:/gi)?.length ?? 0).toBeLessThanOrEqual(1);
    expect((missing as Error).message).toMatch(/list sessions with GET \/sessions/);
    expect((missing as Error).message).not.toMatch(/known sessions:\s*GET \/sessions/i);
  });

  it("rewrites the proxy 404 hint and keeps known sessions: at most once", () => {
    expect(rewriteSessionNotFoundHint('no calls recorded for session "empty"; known sessions: GET /sessions')).toBe(
      'no calls recorded for session "empty"; list sessions with GET /sessions',
    );
    const rewrittenWithList = formatEmptySessionMessage(
      "empty",
      ["iso-a", "iso-b"],
      'no calls recorded for session "empty"; known sessions: GET /sessions',
    );
    expect(rewrittenWithList).toBe(
      'no calls recorded for session "empty"; list sessions with GET /sessions; known sessions: iso-a, iso-b',
    );
    expect(rewrittenWithList.match(/known sessions:/g)?.length).toBe(1);
    const combined = formatEmptySessionMessage("empty", ["iso-a", "iso-b"]);
    expect(combined).toBe("no calls recorded for session empty; known sessions: iso-a, iso-b");
    expect(combined.match(/known sessions:/g)?.length).toBe(1);
    expect(formatEmptySessionMessage("empty", []).match(/known sessions:/g)?.length).toBe(1);
  });

  it("maps wait 404 session_not_found to SessionNotFound", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/sessions/ghost/wait")) {
        return new Response(
          JSON.stringify({
            error: {
              type: "session_not_found",
              message: 'no calls recorded for session "ghost"; known sessions: GET /sessions',
              waited_ms: 0,
            },
          }),
          { status: 404, statusText: "Not Found" },
        );
      }
      return new Response("ok", { status: 200 });
    };
    clearWaitEnv();
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    await expect(client.wait("ghost", { minCalls: 0, timeout: 3, quiet: "200ms" })).rejects.toBeInstanceOf(
      SessionNotFound,
    );
    await expect(client.wait("ghost", { minCalls: 0 })).rejects.toMatchObject({
      sessionId: "ghost",
      status: 404,
    });
    await expect(client.wait("ghost")).rejects.toThrow(/no calls recorded for session "ghost"/);
  });

  it("turns a wait 504 into a timeout error with session counts", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/wait")) {
        return new Response(
          JSON.stringify({
            id: "s1",
            calls: [{ id: "c1" }, { id: "c2", ended_at: "2026-10-20T00:00:00Z" }],
          }),
          { status: 504, statusText: "Gateway Timeout" },
        );
      }
      return new Response(JSON.stringify({ id: "s1", calls: [] }), { status: 200 });
    };
    clearWaitEnv();
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      fetch: fetchImpl,
    });
    await expect(client.wait("s1")).rejects.toBeInstanceOf(WaitTimeoutError);
    await expect(client.wait("s1")).rejects.toThrow(
      "wait timed out after 30s on session s1 (2 calls so far, still active: 1). Raise LLMENTARY_WAIT_TIMEOUT if the graph needs more time.",
    );
  });

  it("falls back to getSession when a wait 504 body has no calls array", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/wait")) {
        return new Response(JSON.stringify({ error: "wait timeout" }), {
          status: 504,
          statusText: "Gateway Timeout",
        });
      }
      return new Response(
        JSON.stringify({
          id: "s1",
          calls: [{ id: "c1" }, { id: "c2" }, { id: "c3", ended_at: "2026-10-20T00:00:00Z" }],
        }),
        { status: 200 },
      );
    };
    clearWaitEnv();
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      fetch: fetchImpl,
    });
    await expect(client.wait("s1")).rejects.toThrow(
      "wait timed out after 30s on session s1 (3 calls so far, still active: 2). Raise LLMENTARY_WAIT_TIMEOUT if the graph needs more time.",
    );
  });

  it("propagates getSession failure after a wait 504 with no counts", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/wait")) {
        return new Response("upstream timeout", { status: 504, statusText: "Gateway Timeout" });
      }
      return new Response("control unavailable", { status: 503, statusText: "Service Unavailable" });
    };
    clearWaitEnv();
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    await expect(client.wait("s1")).rejects.toMatchObject({ status: 503 });
    await expect(client.wait("s1")).rejects.not.toBeInstanceOf(WaitTimeoutError);
  });

  it("lists in-flight calls from a 504 pin instead of a fake settled-call count", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      if (requestUrl(input).includes("/wait")) {
        return new Response(JSON.stringify(PIN.awaiting_headers), { status: 504, statusText: "Gateway Timeout" });
      }
      throw new Error("getSession should not run when in_flight is on the 504");
    };
    clearWaitEnv();
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    const error = await client.wait("stall-example", { minCalls: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({
      sessionId: "stall-example",
      calls: 0,
      stillActive: 1,
    });
    expect((error as WaitTimeoutError).inFlight).toEqual([
      expect.objectContaining({
        callId: "call_1",
        method: "POST",
        path: "/v1/responses",
        phase: "awaiting_headers",
        bytesReceived: 0,
      }),
    ]);
    expect((error as Error).message).toBe(
      "wait timed out after 30s on session stall-example (0 calls so far, still active: 1 [POST /v1/responses awaiting_headers]). Raise LLMENTARY_WAIT_TIMEOUT if the graph needs more time.",
    );
  });

  it("lists a streaming in-flight call with http_status from the pin", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      if (requestUrl(input).includes("/wait")) {
        return new Response(JSON.stringify(PIN.streaming), { status: 504, statusText: "Gateway Timeout" });
      }
      throw new Error("getSession should not run when in_flight is on the 504");
    };
    clearWaitEnv();
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    await expect(client.wait("stall-stream-example", { minCalls: 1 })).rejects.toThrow(
      "wait timed out after 30s on session stall-stream-example (0 calls so far, still active: 1 [POST /v1/chat/completions streaming 200]). Raise LLMENTARY_WAIT_TIMEOUT if the graph needs more time.",
    );
  });

  it("treats an empty in_flight array as still active 0", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      if (requestUrl(input).includes("/wait")) {
        return new Response(
          JSON.stringify({
            id: "quiet",
            calls: [],
            error: { type: "wait_timeout", calls_seen: 0, min_calls: 1, active: 0, in_flight: [] },
          }),
          { status: 504, statusText: "Gateway Timeout" },
        );
      }
      throw new Error("getSession should not run");
    };
    clearWaitEnv();
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    const error = await client.wait("quiet", { minCalls: 1 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ calls: 0, stillActive: 0, inFlight: [] });
    expect((error as Error).message).toContain("still active: 0)");
  });

  it("lists many in-flight calls and prefers error.active over the settled calls array", async () => {
    const inFlight = Array.from({ length: 5 }, (_, index) => ({
      call_id: `call_${index + 1}`,
      seq: index + 1,
      method: "POST",
      path: index % 2 === 0 ? "/v1/responses" : "/v1/chat/completions",
      phase: index % 2 === 0 ? "awaiting_headers" : "streaming",
      ...(index % 2 === 1 ? { http_status: 200 } : {}),
      bytes_received: index,
    }));
    const fetchImpl: ControlFetch = async (input) => {
      if (requestUrl(input).includes("/wait")) {
        return new Response(
          JSON.stringify({
            id: "busy",
            calls: [],
            error: { type: "wait_timeout", calls_seen: 0, min_calls: 3, active: 5, in_flight: inFlight },
          }),
          { status: 504, statusText: "Gateway Timeout" },
        );
      }
      throw new Error("getSession should not run");
    };
    clearWaitEnv();
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    const error = await client.wait("busy", { minCalls: 3 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect((error as WaitTimeoutError).stillActive).toBe(5);
    expect((error as WaitTimeoutError).inFlight).toHaveLength(5);
    expect((error as Error).message).toContain("still active: 5 [POST /v1/responses awaiting_headers; POST /v1/chat/completions streaming 200; POST /v1/responses awaiting_headers; POST /v1/chat/completions streaming 200; POST /v1/responses awaiting_headers]");
  });

  it("reads calls_seen from a wait_timeout JSON error when the session body is absent", async () => {
    const fetchImpl: ControlFetch = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/wait")) {
        return new Response(JSON.stringify({ error: { type: "wait_timeout", calls_seen: 0, min_calls: 2 } }), {
          status: 504,
          statusText: "Gateway Timeout",
        });
      }
      return new Response(
        JSON.stringify({ error: { type: "session_not_found", message: 'no calls recorded for session "s1"' } }),
        { status: 404, statusText: "Not Found" },
      );
    };
    clearWaitEnv();
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    await expect(client.wait("s1", { minCalls: 2 })).rejects.toThrow(
      "wait timed out after 30s on session s1 (0 calls so far, still active: 0). Raise LLMENTARY_WAIT_TIMEOUT if the graph needs more time.",
    );
  });

  it("sends the control token on GET /openapi.yaml and returns the document text", async () => {
    const seen: string[] = [];
    const fetchImpl: ControlFetch = async (input, init) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok-1");
      return new Response("openapi: 3.1.0\ninfo:\n  title: llmentary control\n", { status: 200 });
    };
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      bearerToken: "tok-1",
      fetch: fetchImpl,
    });
    await expect(client.openapi()).resolves.toMatch(/^openapi: 3.1.0/);
    expect(seen[0]).toBe("http://127.0.0.1:9/openapi.yaml");
  });

  it("propagates a body read failure on a successful openapi response", async () => {
    const fetchImpl: ControlFetch = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => {
          throw new Error("body closed");
        },
      }) as unknown as Response;
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    await expect(client.openapi()).rejects.toThrow(/body closed/);
  });

  it("aborts hung requests after requestTimeoutMs and lets wait exceed it", async () => {
    const hungFetch: ControlFetch = async (input, init) => {
      void input;
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
      return new Response("ok", { status: 200 });
    };
    const hungHealth = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      requestTimeoutMs: 40,
      fetch: hungFetch,
    });
    await expect(hungHealth.health()).rejects.toMatchObject({ name: "AbortError" });

    const delayedFetch: ControlFetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return new Response(JSON.stringify({ id: "s1", calls: [] }), { status: 200 });
    };
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      requestTimeoutMs: 40,
      fetch: delayedFetch,
    });
    await expect(client.wait("s1", { timeoutMs: 200 })).resolves.toMatchObject({ id: "s1" });
  });

  it("aborts wait when the caller signal fires", async () => {
    const controller = new AbortController();
    const abortedFetch: ControlFetch = async (input, init) => {
      void input;
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
      return new Response(JSON.stringify({ id: "s1", calls: [] }), { status: 200 });
    };
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      requestTimeoutMs: 5_000,
      fetch: abortedFetch,
    });
    const pending = client.wait("s1", { timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts wait at its timeout while the caller signal remains active", async () => {
    const controller = new AbortController();
    const abortedFetch: ControlFetch = async (input, init) => {
      void input;
      await new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
      return new Response(JSON.stringify({ id: "s1", calls: [] }), { status: 200 });
    };
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      requestTimeoutMs: 40,
      fetch: abortedFetch,
    });
    await expect(client.wait("s1", { timeoutMs: 40, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(controller.signal.aborted).toBe(false);
  }, 10_000);

  it("combines caller cancellation with a timeout signal", async () => {
    const idle = new AbortController();
    const timed = combineAbortSignals(idle.signal, AbortSignal.timeout(40));
    await waitForAbort(timed);
    expect(timed.aborted).toBe(true);

    const controller = new AbortController();
    const combined = combineAbortSignals(controller.signal, AbortSignal.timeout(5_000));
    controller.abort();
    expect(combined.aborted).toBe(true);
  });

  it("aborts immediately when either input signal is already aborted", () => {
    const left = new AbortController();
    left.abort();
    const combined = combineAbortSignals(left.signal, new AbortController().signal);
    expect(combined.aborted).toBe(true);
  });

  it("surfaces control errors, empty bodies, and openapi failures", async () => {
    const fetchImpl: ControlFetch = async (input, init) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/healthz")) {
        return {
          ok: true,
          status: 204,
          statusText: "No Content",
          headers: new Headers(),
          text: async () => "",
        } as unknown as Response;
      }
      if (url.endsWith("/config")) return new Response("   ", { status: 200 });
      if (url.includes("/sessions/s1/otlp")) return new Response('"otlp"', { status: 200 });
      if (url.includes("/sessions/s1") && method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/openapi.yaml")) {
        return new Response("missing", { status: 404, statusText: "Not Found" });
      }
      if (url.includes("/sessions/%25E0%25A4%25A")) {
        return new Response("nope", { status: 404, statusText: "Not Found" });
      }
      if (url.includes("/sessions/s1")) {
        return new Response("broken", { status: 500, statusText: "Internal Server Error" });
      }
      return new Response("nope", { status: 500, statusText: "Internal Server Error" });
    };
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9/",
      bearerToken: "tok",
      fetch: fetchImpl,
    });
    await expect(client.health()).resolves.toBeNull();
    await expect(client.getConfig()).resolves.toMatchObject({ raw: null });
    await expect(client.getOtlp("s1")).resolves.toBe("otlp");
    await expect(client.deleteSession("s1")).resolves.toBeUndefined();
    await expect(client.openapi()).rejects.toMatchObject({ status: 404, path: "/openapi.yaml" });
    await expect(client.getSession("s1")).rejects.toMatchObject({ status: 500 });
    await expect(client.getSession("%E0%A4%A")).rejects.toMatchObject({ status: 404 });
  });

  it("throws when fetch is missing", () => {
    const previous = globalThis.fetch;
    // @ts-expect-error -- exercise the runtime guard
    globalThis.fetch = undefined;
    try {
      expect(() => new ControlClient({ controlUrl: "http://127.0.0.1:9" })).toThrow(/requires a fetch implementation/);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("reads openapi error text and swallows a failed error-body read", async () => {
    const failingText = {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => {
        throw new Error("closed");
      },
    } as unknown as Response;
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      bearerToken: "tok",
      fetch: async () => failingText,
    });
    await expect(client.openapi()).rejects.toMatchObject({ status: 503, body: "" });
  });
});

describe("v0.5.0 config and include=in_flight", () => {
  it("maps spec_targets and timeout strings including 0s", () => {
    expect(
      normalizeProxyConfig({
        version: "0.5.0",
        spec_targets: { openai: "openai-compatible", azure: "openai" },
        upstream_header_timeout: "0s",
        upstream_idle_timeout: "2s",
      }),
    ).toMatchObject({
      version: "0.5.0",
      specTargets: { openai: "openai-compatible", azure: "openai" },
      upstreamHeaderTimeout: "0s",
      upstreamIdleTimeout: "2s",
    });
    const camel = normalizeProxyConfig({
      specTargets: { local: "openai-compatible" },
      upstreamHeaderTimeout: "500ms",
      upstreamIdleTimeout: "0s",
    });
    expect(camel.specTargets).toEqual({ local: "openai-compatible" });
    expect(camel.upstreamHeaderTimeout).toBe("500ms");
    expect(camel.upstreamIdleTimeout).toBe("0s");
    expect(normalizeProxyConfig({ spec_targets: {} }).specTargets).toEqual({});
    expect(
      normalizeProxyConfig({ specTargets: { skip: 1, keep: "openai" }, upstream_header_timeout: "" }).specTargets,
    ).toEqual({ keep: "openai" });
    expect(normalizeProxyConfig({ specTargets: { skip: 1, keep: "openai" } }).upstreamHeaderTimeout).toBeUndefined();
    expect(normalizeProxyConfig({ SpecTargets: { azure: "openai" } }).specTargets).toEqual({ azure: "openai" });
    expect(normalizeProxyConfig({ spec_targets: "openai" }).specTargets).toBeUndefined();
    expect(normalizeProxyConfig({ spec_targets: null }).specTargets).toBeUndefined();
    expect(normalizeProxyConfig({ version: "0.5.0" }).specTargets).toBeUndefined();
    expect(normalizeProxyConfig(null).version).toBeUndefined();
  });

  it("sends include=in_flight only when requested", async () => {
    const seen: string[] = [];
    const fetchImpl: ControlFetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.includes("/sessions/live")) {
        return new Response(
          JSON.stringify({
            id: "live",
            calls: [{ id: "call_1", ended_at: "2026-10-22T00:00:01Z" }],
            in_flight: [
              {
                call_id: "call_2",
                seq: 2,
                method: "POST",
                path: "/v1/responses",
                phase: "awaiting_headers",
                started_at: "2026-10-22T00:00:00Z",
                elapsed_ms: 12,
                bytes_received: 0,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    };
    const client = new ControlClient({ controlUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    const settled = await client.getSession("live");
    expect(seen.some((url) => url.includes("include="))).toBe(false);
    expect(settled.inFlight).toHaveLength(1);
    const inflight = await client.getSession("live", { include: "in_flight" });
    expect(seen.some((url) => url.includes("include=in_flight"))).toBe(true);
    expect(inflight.inFlight?.[0]).toMatchObject({
      callId: "call_2",
      phase: "awaiting_headers",
      elapsedMs: 12,
    });
    expect(inflight.calls).toHaveLength(1);
  });
});

describe("control parsers", () => {
  it("parses empty, quoted, and invalid control error bodies", () => {
    expect(parseControlBody("")).toBeNull();
    expect(parseControlBody('"ok"')).toBe("ok");
    expect(parseControlError("not-json")).toBeUndefined();
    expect(parseControlError("{")).toBeUndefined();
    expect(parseControlError("{}")).toBeUndefined();
    expect(parseControlError(JSON.stringify({ error: { minCalls: 2 } }))).toBeUndefined();
    expect(parseControlError(JSON.stringify({ error: { type: "wait_timeout", callsSeen: 4, minCalls: 2 } }))).toEqual({
      type: "wait_timeout",
      callsSeen: 4,
      minCalls: 2,
    });
    expect(parseControlError(JSON.stringify(PIN.awaiting_headers))).toEqual({
      type: "wait_timeout",
      message: "wait timed out",
      callsSeen: 0,
      minCalls: 1,
      active: 1,
      inFlight: [
        expect.objectContaining({
          callId: "call_1",
          path: "/v1/responses",
          phase: "awaiting_headers",
        }),
      ],
    });
    expect(parseInFlightCalls(undefined)).toBeUndefined();
    expect(parseInFlightCalls("nope")).toBeUndefined();
    expect(parseInFlightCalls([null, "x", {}, { path: "/v1/responses" }])).toEqual([{ path: "/v1/responses" }]);
  });

  it("normalizes config/list fallbacks and keeps rewritten 404 hints", () => {
    expect(normalizeSessionList([{ SessionId: "s1" }])).toEqual([expect.objectContaining({ id: "s1", calls: 0, active: 0 })]);
    expect(normalizeSessionList([{ calls: 1 }])).toEqual([]);
    expect(rewriteSessionNotFoundHint(undefined)).toBe("");
    expect(formatZeroCallsMessage("s1", [])).toBe("no calls recorded for session s1; known sessions: (none)");
    expect(formatEmptySessionMessage("s1", ["a"], "already lists known sessions: x")).toBe(
      "already lists known sessions: x",
    );
    expect(formatEmptySessionMessage("s1", ["a"], "proxy said nope")).toBe(
      "proxy said nope; known sessions: a",
    );
  });
});

function queryString(url: string | undefined): string {
  const href = url ?? "";
  const index = href.indexOf("?");
  return index >= 0 ? href.slice(index + 1) : "";
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
