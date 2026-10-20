import type { CallRecord, JsonValue, SessionTrace, WaitOptions } from "./types.js";
import { normalizeSessionTrace } from "./normalize.js";
import {
  WAIT_HTTP_PADDING_MS,
  formatWaitTimeoutError,
  resolveWait,
} from "./wait.js";

export type ControlFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ControlClientOptions {
  controlUrl: string;
  bearerToken?: string;
  fetch?: ControlFetch;
  /** Client-side abort timeout for non-wait control requests. `wait()` aborts at timeout + quiet + 5s. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class ControlClient {
  readonly controlUrl: string;
  readonly bearerToken: string | undefined;
  readonly fetchImpl: ControlFetch;
  readonly requestTimeoutMs: number;

  constructor(options: ControlClientOptions) {
    this.controlUrl = trimTrailingSlash(options.controlUrl);
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!this.fetchImpl) {
      throw new Error("llmentary requires a fetch implementation; use Node >=18 or pass fetch.");
    }
  }

  async health(): Promise<JsonValue> {
    return this.request("/healthz");
  }

  async getSession(sessionId: string): Promise<SessionTrace> {
    const body = await this.request(`/sessions/${encodeURIComponent(sessionId)}`);
    return normalizeSessionTrace(sessionId, body);
  }

  async wait(sessionId: string, options: WaitOptions = {}): Promise<SessionTrace> {
    const resolved = resolveWait(options);
    const params = new URLSearchParams();
    params.set("timeout", resolved.timeout);
    params.set("quiet", resolved.quiet);
    const abortMs = resolved.timeoutMs + resolved.quietMs + WAIT_HTTP_PADDING_MS;
    const timeout = AbortSignal.timeout(abortMs);
    try {
      const body = await this.request(`/sessions/${encodeURIComponent(sessionId)}/wait?${params.toString()}`, {
        signal: options.signal ? combineAbortSignals(options.signal, timeout) : timeout,
      });
      return normalizeSessionTrace(sessionId, body);
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 504) {
        const stats = await this.waitTimeoutStats(sessionId, error.body);
        throw new Error(formatWaitTimeoutError(sessionId, resolved.timeout, stats.calls, stats.stillActive));
      }
      throw error;
    }
  }

  private async waitTimeoutStats(
    sessionId: string,
    body: string,
  ): Promise<{ calls: number; stillActive: number }> {
    const fromBody = trySessionCounts(sessionId, body);
    if (fromBody) return fromBody;
    try {
      return sessionCounts(await this.getSession(sessionId));
    } catch {
      return { calls: 0, stillActive: 0 };
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  async getOtlp(sessionId: string): Promise<JsonValue> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/otlp`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<JsonValue> {
    const headers = new Headers(init.headers);
    if (this.bearerToken) headers.set("authorization", `Bearer ${this.bearerToken}`);
    const signal = init.signal ?? AbortSignal.timeout(this.requestTimeoutMs);
    const response = await this.fetchImpl(`${this.controlUrl}${path}`, { ...init, headers, signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ControlApiError(
        `llmentary control API ${init.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`,
        { status: response.status, path, body: text },
      );
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    return parseControlBody(text);
  }
}

export function parseControlBody(text: string): JsonValue {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    return JSON.parse(trimmed) as JsonValue;
  }
  return trimmed;
}

export function combineAbortSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
    left.removeEventListener("abort", onAbort);
    right.removeEventListener("abort", onAbort);
  };
  if (left.aborted || right.aborted) {
    controller.abort();
    return controller.signal;
  }
  left.addEventListener("abort", onAbort, { once: true });
  right.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export class ControlApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(message: string, options: { status: number; path: string; body: string }) {
    super(message);
    this.name = "ControlApiError";
    this.status = options.status;
    this.path = options.path;
    this.body = options.body;
  }
}

function trySessionCounts(sessionId: string, text: string): { calls: number; stillActive: number } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const hasCalls = ["calls", "records", "requests", "traces"].some((key) =>
      Array.isArray((parsed as Record<string, unknown>)[key]),
    );
    if (!hasCalls) return undefined;
    return sessionCounts(normalizeSessionTrace(sessionId, parsed));
  } catch {
    return undefined;
  }
}

function sessionCounts(trace: SessionTrace): { calls: number; stillActive: number } {
  return {
    calls: trace.calls.length,
    stillActive: trace.calls.filter((call) => isActiveCall(call)).length,
  };
}

function isActiveCall(call: CallRecord): boolean {
  return !call.finishedAt;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
