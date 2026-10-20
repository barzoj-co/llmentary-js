import { afterEach, describe, expect, it } from "vitest";
import {
  ControlClient,
  SessionNotFound,
  combineAbortSignals,
  formatZeroCallsMessage,
  parseControlBody,
  type ControlFetch,
} from "../src/control.js";
import { WaitTimeoutError, resetWaitEnvDeprecationWarnings } from "../src/wait.js";

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
