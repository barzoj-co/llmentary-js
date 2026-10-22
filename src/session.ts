import { randomUUID } from "node:crypto";
import { AssertionScope, recordsForTrace } from "./assertions.js";
import { ControlClient } from "./control.js";
import { attachSessionTraceHelpers } from "./normalize.js";
import { firstNonEmpty } from "./env.js";
import type {
  AssertionResult,
  GetSessionOptions,
  ListSessionsOptions,
  ProxyConfig,
  QueryOptions,
  SessionMark,
  SessionOptions,
  SessionSummary,
  SessionTrace,
  WaitOptions,
} from "./types.js";
import { mergeWaitOptions, resolveWait, resolvedWaitToOptions } from "./wait.js";

const SESSION_HEADER = "x-test-session";
const BAGGAGE_KEY = "llmentary.session.id";

export class Session {
  readonly sessionId: string;
  readonly proxyUrl: string;
  readonly controlUrl: string;
  readonly bearerToken: string | undefined;
  readonly baseURL: string;
  readonly headers: Record<string, string>;
  readonly control: ControlClient;
  readonly defaultWait: WaitOptions;

  constructor(config: SessionOptions = {}) {
    this.sessionId = config.sessionId ?? randomUUID();
    this.proxyUrl = trimTrailingSlash(
      firstNonEmpty(config.proxyUrl, process.env.LLMENTARY_PROXY_URL) ?? "http://127.0.0.1:4010",
    );
    this.controlUrl = trimTrailingSlash(
      firstNonEmpty(config.controlUrl, process.env.LLMENTARY_CONTROL_URL) ?? this.proxyUrl,
    );
    this.bearerToken = firstNonEmpty(
      config.bearerToken,
      process.env.LLMENTARY_BEARER_TOKEN,
      process.env.LLMENTARY_CONTROL_TOKEN,
    );
    this.baseURL = `${this.proxyUrl}/v1`;
    this.defaultWait = resolvedWaitToOptions(resolveWait(config.defaultWait));
    this.headers = {
      [SESSION_HEADER]: this.sessionId,
      baggage: `${BAGGAGE_KEY}=${this.sessionId}`,
    };
    this.control = new ControlClient({
      controlUrl: this.controlUrl,
      ...(this.bearerToken ? { bearerToken: this.bearerToken } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  pathBaseURL(upstream?: string): string {
    return formatPathBaseURL(this.proxyUrl, this.sessionId, upstream);
  }

  query(query: QueryOptions): SessionQuery {
    return new SessionQuery(this, query);
  }

  expect(query?: QueryOptions): AssertionScope {
    return new AssertionScope({
      control: this.control,
      sessionId: this.sessionId,
      ...(query ? { query } : {}),
      defaultWait: this.defaultWait,
    });
  }

  /**
   * Assert this session recorded zero LLM calls. `SessionNotFound` (never
   * created / DELETE'd) passes. A session with calls fails with the trace
   * summary. Whole-session `expect().callCount(0)` stays strict (DOG-2)
   * unless you pass `{ allowEmpty: true }` or call `allowEmpty()`.
   */
  async expectNoCalls(options?: WaitOptions): Promise<AssertionResult> {
    return this.expect().expectNoCalls(options);
  }

  async mark(options?: WaitOptions): Promise<SessionMark> {
    return (await this.wait(options)).calls.length;
  }

  softExpect(): AssertionScope {
    return this.expect().soft();
  }

  async wait(options?: WaitOptions): Promise<SessionTrace> {
    return this.control.wait(this.sessionId, mergeWaitOptions(this.defaultWait, options));
  }

  async session(options: GetSessionOptions = {}): Promise<SessionTrace> {
    return this.control.getSession(this.sessionId, options);
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    return this.control.listSessions(options);
  }

  async config(): Promise<ProxyConfig> {
    return this.control.getConfig();
  }

  async proxyVersion(): Promise<string | undefined> {
    return (await this.control.getConfig()).version;
  }

  async openapi(): Promise<string> {
    return this.control.openapi();
  }

  async cleanup(): Promise<void> {
    await this.control.deleteSession(this.sessionId);
  }

  fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(this.headers)) {
      if (key === "baggage" && headers.has("baggage")) {
        headers.set("baggage", `${headers.get("baggage")},${value}`);
      } else if (!headers.has(key)) {
        headers.set(key, value);
      }
    }
    return fetch(input, { ...init, headers });
  }

  openAI(options: { apiKey?: string; baseURL?: string; defaultHeaders?: Record<string, string> } = {}): {
    apiKey: string;
    baseURL: string;
    defaultHeaders: Record<string, string>;
  } {
    return {
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? "llmentary",
      baseURL: options.baseURL ?? this.baseURL,
      defaultHeaders: {
        ...this.headers,
        ...(options.defaultHeaders ?? {}),
      },
    };
  }

  vercelAI(): { baseURL: string; headers: Record<string, string> } {
    return {
      baseURL: this.baseURL,
      headers: this.headers,
    };
  }
}

export class SessionQuery {
  constructor(
    readonly session: Session,
    readonly queryOptions: QueryOptions,
  ) {}

  offersTool(name: string): SessionQuery {
    return new SessionQuery(this.session, { ...this.queryOptions, offersTool: name });
  }

  withoutTools(): SessionQuery {
    return new SessionQuery(this.session, { ...this.queryOptions, withoutTools: true });
  }

  since(mark: SessionMark): SessionQuery {
    return new SessionQuery(this.session, { ...this.queryOptions, since: mark });
  }

  /** Opt out of the empty-session / empty-filter failure on zero-call assertions. */
  allowEmpty(): SessionQuery {
    return new SessionQuery(this.session, { ...this.queryOptions, allowEmpty: true });
  }

  expect(query?: QueryOptions): AssertionScope {
    return new AssertionScope({
      control: this.session.control,
      sessionId: this.session.sessionId,
      query: { ...this.queryOptions, ...query },
      defaultWait: this.session.defaultWait,
    });
  }

  softExpect(): AssertionScope {
    return this.expect().soft();
  }

  async wait(options?: WaitOptions): Promise<SessionTrace> {
    const trace = await this.session.wait(options);
    return attachSessionTraceHelpers(
      trace.id,
      recordsForTrace(trace, this.queryOptions),
      trace.raw,
      trace.summary,
      trace.inFlight,
    );
  }
}

export function llmentary(config: SessionOptions = {}): Session {
  return new Session(config);
}

export function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    [SESSION_HEADER]: sessionId,
    baggage: `${BAGGAGE_KEY}=${sessionId}`,
  };
}

export function formatPathBaseURL(proxyUrl: string, sessionId: string, upstream?: string): string {
  const base = trimTrailingSlash(proxyUrl);
  const session = encodeURIComponent(sessionId);
  if (upstream) return `${base}/s/${session}/u/${encodeURIComponent(upstream)}`;
  return `${base}/s/${session}/v1`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
