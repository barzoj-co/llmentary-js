import { randomUUID } from "node:crypto";
import { AssertionScope, recordsForTrace } from "./assertions.js";
import { ControlClient } from "./control.js";
import { firstNonEmpty } from "./env.js";
import type { LabConfig, QueryOptions, SessionTrace, WaitOptions } from "./types.js";

const SESSION_HEADER = "x-test-session";
const BAGGAGE_KEY = "llmentary.session.id";

export class Lab {
  readonly sessionId: string;
  readonly proxyUrl: string;
  readonly controlUrl: string;
  readonly bearerToken: string | undefined;
  readonly baseURL: string;
  readonly headers: Record<string, string>;
  readonly control: ControlClient;
  readonly defaultWait: WaitOptions;

  constructor(config: LabConfig = {}) {
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
    this.defaultWait = config.defaultWait ?? {
      timeoutMs: Number(firstNonEmpty(process.env.LLMENTARY_WAIT_TIMEOUT_MS) ?? 5_000),
      idleMs: Number(firstNonEmpty(process.env.LLMENTARY_WAIT_IDLE_MS) ?? 100),
    };
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

  query(query: QueryOptions): LabQuery {
    return new LabQuery(this, query);
  }

  expect(): AssertionScope {
    return new AssertionScope({
      control: this.control,
      sessionId: this.sessionId,
      defaultWait: this.defaultWait,
    });
  }

  softExpect(): AssertionScope {
    return this.expect().soft();
  }

  async wait(options?: WaitOptions): Promise<SessionTrace> {
    return this.control.wait(this.sessionId, { ...this.defaultWait, ...options });
  }

  async session(): Promise<SessionTrace> {
    return this.control.getSession(this.sessionId);
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

export class LabQuery {
  constructor(
    readonly lab: Lab,
    readonly queryOptions: QueryOptions,
  ) {}

  expect(): AssertionScope {
    return new AssertionScope({
      control: this.lab.control,
      sessionId: this.lab.sessionId,
      query: this.queryOptions,
      defaultWait: this.lab.defaultWait,
    });
  }

  softExpect(): AssertionScope {
    return this.expect().soft();
  }

  async wait(options?: WaitOptions): Promise<SessionTrace> {
    const trace = await this.lab.wait(options);
    return {
      ...trace,
      calls: recordsForTrace(trace, this.queryOptions),
    };
  }
}

export function createLab(config: LabConfig = {}): Lab {
  return new Lab(config);
}

export function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    [SESSION_HEADER]: sessionId,
    baggage: `${BAGGAGE_KEY}=${sessionId}`,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
