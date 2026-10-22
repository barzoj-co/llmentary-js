import type {
  CallRecord,
  GetSessionOptions,
  InFlightCall,
  JsonValue,
  ListSessionsOptions,
  ProxyConfig,
  SessionSummary,
  SessionTrace,
  WaitOptions,
} from "./types.js";
import {
  asArray,
  asObject,
  normalizeSessionTrace,
  numberAt,
  parseInFlightCalls,
  stringAt,
  valueAt,
} from "./normalize.js";
import { WAIT_HTTP_PADDING_MS, WaitTimeoutError, resolveWait } from "./wait.js";

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

  async getConfig(): Promise<ProxyConfig> {
    const body = await this.request("/config");
    return normalizeProxyConfig(body);
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const params = new URLSearchParams();
    if (options.source) params.set("source", options.source);
    const query = params.toString();
    const body = await this.request(`/sessions${query ? `?${query}` : ""}`);
    return normalizeSessionList(body);
  }

  async getSession(sessionId: string, options: GetSessionOptions = {}): Promise<SessionTrace> {
    const params = new URLSearchParams();
    if (options.include) params.set("include", options.include);
    const query = params.toString();
    const body = await this.request(`/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ""}`);
    return normalizeSessionTrace(sessionId, body);
  }

  async wait(sessionId: string, options: WaitOptions = {}): Promise<SessionTrace> {
    const resolved = resolveWait(options);
    const params = new URLSearchParams();
    params.set("timeout", resolved.timeout);
    params.set("quiet", resolved.quiet);
    if (resolved.minCalls !== undefined) params.set("min_calls", String(resolved.minCalls));
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
        throw new WaitTimeoutError(sessionId, resolved.timeout, stats.calls, stats.stillActive, stats.inFlight);
      }
      throw error;
    }
  }

  private async waitTimeoutStats(sessionId: string, body: string): Promise<WaitTimeoutStats> {
    const fromBody = trySessionCounts(sessionId, body);
    if (fromBody) return fromBody;
    return sessionCounts(await this.getSession(sessionId));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  async getOtlp(sessionId: string): Promise<JsonValue> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/otlp`);
  }

  /** Served control contract (`GET /openapi.yaml`), with the bearer token when set. */
  async openapi(): Promise<string> {
    const headers = new Headers();
    if (this.bearerToken) headers.set("authorization", `Bearer ${this.bearerToken}`);
    const path = "/openapi.yaml";
    const response = await this.fetchImpl(`${this.controlUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ControlApiError(
        `llmentary control API GET ${path} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`,
        { status: response.status, path, body: text },
      );
    }
    return response.text();
  }

  private async request(path: string, init: RequestInit = {}): Promise<JsonValue> {
    const headers = new Headers(init.headers);
    if (this.bearerToken) headers.set("authorization", `Bearer ${this.bearerToken}`);
    const signal = init.signal ?? AbortSignal.timeout(this.requestTimeoutMs);
    const response = await this.fetchImpl(`${this.controlUrl}${path}`, { ...init, headers, signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const sessionId = sessionLookupId(path);
      if (response.status === 404 && sessionId) {
        throw new SessionNotFound(sessionId, {
          status: response.status,
          path,
          body: text,
        });
      }
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

export class SessionNotFound extends ControlApiError {
  readonly sessionId: string;

  constructor(sessionId: string, options: { status: number; path: string; body: string }) {
    const parsed = parseControlError(options.body);
    const hint =
      rewriteSessionNotFoundHint(parsed?.message?.trim()) ||
      `no calls recorded for session "${sessionId}"; list sessions with GET /sessions`;
    super(hint, options);
    this.name = "SessionNotFound";
    this.sessionId = sessionId;
  }
}

/** Proxy 404 used to say `known sessions: GET /sessions` (a hint, not a list). */
export function rewriteSessionNotFoundHint(message: string | undefined): string {
  if (!message) return "";
  return message.replace(/known sessions:\s*GET \/sessions/gi, "list sessions with GET /sessions");
}

export function formatZeroCallsMessage(sessionId: string, knownSessionIds: string[]): string {
  const known = knownSessionIds.length > 0 ? knownSessionIds.join(", ") : "(none)";
  return `no calls recorded for session ${sessionId}; known sessions: ${known}`;
}

/** Combine a 404 hint with a known-session list so `known sessions:` appears at most once. */
export function formatEmptySessionMessage(
  sessionId: string,
  knownSessionIds: string[],
  proxyMessage?: string,
): string {
  const rewritten = rewriteSessionNotFoundHint(proxyMessage?.trim());
  const known = knownSessionIds.length > 0 ? knownSessionIds.join(", ") : "(none)";
  const list = `known sessions: ${known}`;
  if (!rewritten) return `no calls recorded for session ${sessionId}; ${list}`;
  if (/known sessions:/i.test(rewritten)) {
    return rewritten;
  }
  return `${rewritten.replace(/;?\s*$/, "")}; ${list}`;
}

export interface ControlErrorBody {
  type?: string;
  message?: string;
  callsSeen?: number;
  minCalls?: number;
  active?: number;
  inFlight?: InFlightCall[];
}

export function parseControlError(text: string): ControlErrorBody | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    const object = asObject(parsed);
    const error = asObject(valueAt(object, "error") ?? parsed);
    const type = stringAt(error, "type");
    const message = stringAt(error, "message");
    const callsSeen = numberAt(error, "calls_seen") ?? numberAt(error, "callsSeen");
    const minCalls = numberAt(error, "min_calls") ?? numberAt(error, "minCalls");
    const active = numberAt(error, "active") ?? numberAt(error, "Active");
    const inFlight = parseInFlightCalls(valueAt(error, "in_flight") ?? valueAt(error, "inFlight"));
    if (!type && !message && callsSeen === undefined && active === undefined && inFlight === undefined) {
      return undefined;
    }
    return {
      ...(type ? { type } : {}),
      ...(message ? { message } : {}),
      ...(callsSeen !== undefined ? { callsSeen } : {}),
      ...(minCalls !== undefined ? { minCalls } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(inFlight !== undefined ? { inFlight } : {}),
    };
  } catch {
    return undefined;
  }
}

export { parseInFlightCalls } from "./normalize.js";

export function normalizeSessionList(raw: JsonValue): SessionSummary[] {
  const object = asObject(raw);
  const values = asArray(
    valueAt(object, "sessions") ?? valueAt(object, "Sessions") ?? raw,
  );
  return values
    .map((value) => normalizeSessionSummary(value))
    .filter((session): session is SessionSummary => Boolean(session));
}

export function normalizeSessionSummary(raw: JsonValue): SessionSummary | undefined {
  const object = asObject(raw);
  const id = stringAt(object, "id") ?? stringAt(object, "session_id") ?? stringAt(object, "Id") ?? stringAt(object, "SessionId");
  if (!id) return undefined;
  const sources = asArray(valueAt(object, "sources") ?? valueAt(object, "Sources")).filter(
    (value): value is string => typeof value === "string",
  );
  const firstStartedAt =
    stringAt(object, "first_started_at") ?? stringAt(object, "firstStartedAt") ?? stringAt(object, "FirstStartedAt");
  const lastEndedAt =
    stringAt(object, "last_ended_at") ?? stringAt(object, "lastEndedAt") ?? stringAt(object, "LastEndedAt");
  const specViolationCount =
    numberAt(object, "spec_violation_count") ??
    numberAt(object, "specViolationCount") ??
    numberAt(object, "SpecViolationCount");
  const ignoredFieldCount =
    numberAt(object, "ignored_field_count") ??
    numberAt(object, "ignoredFieldCount") ??
    numberAt(object, "IgnoredFieldCount");
  return {
    id,
    calls: numberAt(object, "calls") ?? numberAt(object, "Calls") ?? 0,
    active: numberAt(object, "active") ?? numberAt(object, "Active") ?? 0,
    sources,
    ...(firstStartedAt ? { firstStartedAt } : {}),
    ...(lastEndedAt ? { lastEndedAt } : {}),
    ...(specViolationCount !== undefined ? { specViolationCount } : {}),
    ...(ignoredFieldCount !== undefined ? { ignoredFieldCount } : {}),
    raw,
  };
}

export function normalizeProxyConfig(raw: JsonValue): ProxyConfig {
  const object = asObject(raw);
  const version = stringAt(object, "version") ?? stringAt(object, "Version");
  const upstreams = valueAt(object, "upstreams") ?? valueAt(object, "Upstreams");
  const specTargets = parseSpecTargets(
    valueAt(object, "spec_targets") ?? valueAt(object, "specTargets") ?? valueAt(object, "SpecTargets"),
  );
  const upstreamHeaderTimeout =
    stringAt(object, "upstream_header_timeout") ??
    stringAt(object, "upstreamHeaderTimeout") ??
    stringAt(object, "UpstreamHeaderTimeout");
  const upstreamIdleTimeout =
    stringAt(object, "upstream_idle_timeout") ??
    stringAt(object, "upstreamIdleTimeout") ??
    stringAt(object, "UpstreamIdleTimeout");
  return {
    ...(version ? { version } : {}),
    ...(upstreams !== undefined ? { upstreams } : {}),
    ...(specTargets !== undefined ? { specTargets } : {}),
    ...(upstreamHeaderTimeout ? { upstreamHeaderTimeout } : {}),
    ...(upstreamIdleTimeout ? { upstreamIdleTimeout } : {}),
    raw,
  };
}

function parseSpecTargets(raw: JsonValue | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string" && value) out[name] = value;
  }
  return out;
}

function sessionLookupId(path: string): string | undefined {
  const pathname = path.split("?")[0] ?? path;
  const match = pathname.match(/^\/sessions\/([^/]+)(?:\/(?:otlp|wait))?$/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

interface WaitTimeoutStats {
  calls: number;
  stillActive: number;
  inFlight: InFlightCall[];
}

function trySessionCounts(sessionId: string, text: string): WaitTimeoutStats | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const error = parseControlError(trimmed);
    const hasCalls = ["calls", "records", "requests", "traces"].some((key) =>
      Array.isArray((parsed as Record<string, unknown>)[key]),
    );
    const settled = hasCalls ? sessionCounts(normalizeSessionTrace(sessionId, parsed)) : undefined;
    const inFlight = error?.inFlight;
    const stillActive =
      error?.active ??
      (inFlight !== undefined ? inFlight.length : undefined) ??
      settled?.stillActive ??
      (error?.callsSeen !== undefined ? 0 : undefined);
    const calls = error?.callsSeen ?? settled?.calls;
    if (calls === undefined && stillActive === undefined) return undefined;
    return {
      calls: calls ?? 0,
      stillActive: stillActive ?? 0,
      inFlight: inFlight ?? [],
    };
  } catch {
    return undefined;
  }
}

function sessionCounts(trace: SessionTrace): WaitTimeoutStats {
  return {
    calls: trace.calls.length,
    stillActive: trace.calls.filter((call) => isActiveCall(call)).length,
    inFlight: [],
  };
}

function isActiveCall(call: CallRecord): boolean {
  return !call.finishedAt;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
