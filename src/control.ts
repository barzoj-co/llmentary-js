import type { JsonValue, SessionTrace, WaitOptions } from "./types.js";
import { normalizeSessionTrace } from "./normalize.js";

export type ControlFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ControlClientOptions {
  controlUrl: string;
  bearerToken?: string;
  fetch?: ControlFetch;
  /** Client-side abort timeout for control requests. `wait()` uses a longer window than `timeoutMs`. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const WAIT_ABORT_PADDING_MS = 5_000;

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
      throw new Error("llm-test-lab requires a fetch implementation; use Node >=18 or pass fetch.");
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
    const params = new URLSearchParams();
    if (options.timeoutMs !== undefined) params.set("timeout_ms", String(options.timeoutMs));
    if (options.idleMs !== undefined) params.set("idle_ms", String(options.idleMs));
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    const waitMs = options.timeoutMs ?? this.requestTimeoutMs;
    const body = await this.request(`/sessions/${encodeURIComponent(sessionId)}/wait${suffix}`, {
      signal:
        options.signal ?? AbortSignal.timeout(Math.max(this.requestTimeoutMs, waitMs + WAIT_ABORT_PADDING_MS)),
    });
    return normalizeSessionTrace(sessionId, body);
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
      throw new Error(
        `llm-test-lab control API ${init.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`,
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
