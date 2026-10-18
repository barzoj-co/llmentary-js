import { describe, expect, it } from "vitest";
import { ControlClient, combineAbortSignals, parseControlBody, type ControlFetch } from "../src/control.js";

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
  it("appends wait query params from URLSearchParams.toString", async () => {
    const urls: string[] = [];
    const fetchImpl: ControlFetch = async (input) => {
      urls.push(requestUrl(input));
      return new Response(JSON.stringify({ id: "s1", calls: [] }), { status: 200 });
    };
    const client = new ControlClient({
      controlUrl: "http://127.0.0.1:9",
      fetch: fetchImpl,
    });
    await client.wait("s1", { timeoutMs: 5_000, idleMs: 100 });
    expect(urls[0]).toContain("/sessions/s1/wait?");
    expect(urls[0]).toContain("timeout_ms=5000");
    expect(urls[0]).toContain("idle_ms=100");
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

  it("combines caller cancellation with a timeout signal", async () => {
    const idle = new AbortController();
    const timed = combineAbortSignals(idle.signal, AbortSignal.timeout(40));
    await new Promise((resolve) => timed.addEventListener("abort", resolve, { once: true }));
    expect(timed.aborted).toBe(true);

    const controller = new AbortController();
    const combined = combineAbortSignals(controller.signal, AbortSignal.timeout(5_000));
    controller.abort();
    expect(combined.aborted).toBe(true);
  });
});
