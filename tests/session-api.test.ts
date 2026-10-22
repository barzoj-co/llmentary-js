import { afterEach, describe, expect, it } from "vitest";
import { AssertionScope } from "../src/assertions.js";
import type { ControlFetch } from "../src/control.js";
import { formatPathBaseURL, llmentary, sessionHeaders } from "../src/session.js";

const keys = ["LLMENTARY_PROXY_URL", "LLMENTARY_CONTROL_URL", "OPENAI_API_KEY"] as const;
const previous: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of keys) {
    if (!(key in previous)) continue;
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

function hrefOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("session query and client helpers", () => {
  it("builds path-style base URLs and session headers", () => {
    expect(formatPathBaseURL("http://127.0.0.1:4010/", "s1")).toBe("http://127.0.0.1:4010/s/s1/v1");
    expect(formatPathBaseURL("http://127.0.0.1:4010", "s1", "openai")).toBe("http://127.0.0.1:4010/s/s1/u/openai");
    expect(sessionHeaders("s1")).toEqual({
      "x-test-session": "s1",
      baggage: "llmentary.session.id=s1",
    });
  });

  it("chains SessionQuery filters onto expect and wait", async () => {
    const fetchImpl: ControlFetch = async () =>
      new Response(
        JSON.stringify({
          id: "s1",
          calls: [],
          in_flight: [{ call_id: "call_q", phase: "awaiting_headers" }],
        }),
        { status: 200 },
      );
    const lm = llmentary({
      proxyUrl: "http://127.0.0.1:9/",
      controlUrl: "http://127.0.0.1:9/",
      sessionId: "s1",
      fetch: fetchImpl,
    });
    const query = lm
      .query({ model: "gpt-4.1-mini" })
      .offersTool("lookup")
      .withoutTools()
      .since(1)
      .allowEmpty()
      .committed()
      .aborted();
    expect(query.queryOptions).toMatchObject({
      model: "gpt-4.1-mini",
      offersTool: "lookup",
      withoutTools: true,
      since: 1,
      allowEmpty: true,
      committed: true,
      aborted: true,
    });
    expect(query.expect()).toBeInstanceOf(AssertionScope);
    expect(query.softExpect()).toBeInstanceOf(AssertionScope);
    const filtered = await query.wait();
    expect(filtered.id).toBe("s1");
    expect(filtered.calls).toEqual([]);
    expect(filtered.inFlight).toEqual([{ callId: "call_q", phase: "awaiting_headers" }]);
  });

  it("exposes mark, session, config, list, openapi, and client wrappers", async () => {
    stash("OPENAI_API_KEY", undefined);
    const fetchImpl: ControlFetch = async (input, init) => {
      const url = new URL(hrefOf(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/sessions/s1" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/sessions/s1/wait") {
        const calls =
          url.searchParams.get("min_calls") === "0"
            ? []
            : [{ request: { model: "a" } }, { request: { model: "b" } }];
        return new Response(JSON.stringify({ id: "s1", calls }), { status: 200 });
      }
      if (url.pathname === "/sessions/s1") {
        const include = url.searchParams.get("include");
        return new Response(
          JSON.stringify({
            id: "s1",
            calls: [],
            ...(include === "in_flight" ? { in_flight: [{ call_id: "call_live", phase: "streaming" }] } : {}),
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/sessions") {
        expect(url.searchParams.get("source")).toBe("live");
        return new Response(JSON.stringify({ sessions: [{ id: "s1", sources: ["live"] }] }), { status: 200 });
      }
      if (url.pathname === "/config") {
        return new Response(JSON.stringify({ version: "v0.4.0", upstreams: "openai=http://127.0.0.1:9" }), {
          status: 200,
        });
      }
      if (url.pathname === "/openapi.yaml") {
        return new Response("openapi: 3.1.0\n", { status: 200 });
      }
      return new Response(`unhandled ${method} ${url.pathname}`, { status: 404 });
    };
    const lm = llmentary({
      proxyUrl: "http://127.0.0.1:9",
      controlUrl: "http://127.0.0.1:9",
      sessionId: "s1",
      fetch: fetchImpl,
    });
    expect(lm.pathBaseURL()).toBe("http://127.0.0.1:9/s/s1/v1");
    expect(lm.pathBaseURL("openai")).toBe("http://127.0.0.1:9/s/s1/u/openai");
    expect(lm.softExpect()).toBeInstanceOf(AssertionScope);
    await expect(lm.mark()).resolves.toBe(2);
    await expect(lm.session()).resolves.toMatchObject({ id: "s1" });
    expect((await lm.session()).inFlight).toBeUndefined();
    await expect(lm.session({ include: "in_flight" })).resolves.toMatchObject({
      id: "s1",
      inFlight: [{ callId: "call_live", phase: "streaming" }],
    });
    await expect(lm.listSessions({ source: "live" })).resolves.toEqual([expect.objectContaining({ id: "s1" })]);
    await expect(lm.config()).resolves.toMatchObject({ version: "v0.4.0" });
    await expect(lm.proxyVersion()).resolves.toBe("v0.4.0");
    await expect(lm.openapi()).resolves.toContain("openapi: 3.1.0");
    const openai = lm.openAI({ defaultHeaders: { "x-extra": "1" } });
    expect(openai.apiKey).toBe("llmentary");
    expect(openai.baseURL).toBe("http://127.0.0.1:9/v1");
    expect(openai.defaultHeaders["x-test-session"]).toBe("s1");
    expect(openai.defaultHeaders["x-extra"]).toBe("1");
    expect(lm.vercelAI()).toEqual({
      baseURL: "http://127.0.0.1:9/v1",
      headers: lm.headers,
    });
    await expect(lm.expectNoCalls()).resolves.toMatchObject({
      pass: true,
      message: "expected 0 LLM calls, got 0",
    });
    await lm.cleanup();
  });

  it("merges baggage on Session.fetch and leaves other headers intact", async () => {
    const seen: Array<{ url: string; headers: string | null; session: string | null }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: hrefOf(input),
        headers: headers.get("baggage"),
        session: headers.get("x-test-session"),
      });
      return new Response("ok", { status: 200 });
    };
    try {
      const lm = llmentary({
        proxyUrl: "http://127.0.0.1:9",
        controlUrl: "http://127.0.0.1:9",
        sessionId: "s1",
      });
      await lm.fetch("http://127.0.0.1:9/v1/models", { headers: { baggage: "prior=1" } });
      expect(seen[0]).toMatchObject({
        url: "http://127.0.0.1:9/v1/models",
        headers: "prior=1,llmentary.session.id=s1",
        session: "s1",
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
