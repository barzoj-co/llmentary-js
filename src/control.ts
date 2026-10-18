import type { JsonValue, SessionTrace, WaitOptions } from "./types.js";
import { normalizeSessionTrace } from "./normalize.js";

export interface ControlClientOptions {
  controlUrl: string;
  bearerToken?: string;
  fetch?: typeof fetch;
}

export class ControlClient {
  readonly controlUrl: string;
  readonly bearerToken: string | undefined;
  readonly fetchImpl: typeof fetch;

  constructor(options: ControlClientOptions) {
    this.controlUrl = trimTrailingSlash(options.controlUrl);
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
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
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.request(`/sessions/${encodeURIComponent(sessionId)}/wait${suffix}`);
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
    const response = await this.fetchImpl(`${this.controlUrl}${path}`, { ...init, headers });
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
