export type ApiType = "chat_completions" | "responses" | (string & {});

/** `before_headers` | `after_headers`. Omitted when the call is not aborted. */
export type AbortPhase = "before_headers" | "after_headers";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface WaitOptions {
  /** Wait budget. Number is seconds; string is a Go duration (`30s`, `500ms`). */
  timeout?: number | string;
  /** Quiet window after the last call. Number is seconds; string is a Go duration. */
  quiet?: number | string;
  /** Return only after at least this many finished calls (proxy `min_calls`). */
  minCalls?: number;
  /** @deprecated Use `timeout` (seconds or Go duration). */
  timeoutMs?: number;
  /** @deprecated Use `quiet` (seconds or Go duration). */
  idleMs?: number;
  signal?: AbortSignal;
}

/** Call-count checkpoint from `lm.mark()`. `since: mark` keeps calls with seq >= mark. */
export type SessionMark = number;

export interface QueryOptions {
  apiType?: ApiType;
  model?: string | RegExp;
  /** 0-based index into the filtered call list. */
  index?: number;
  /** Keep calls whose request offered this tool. */
  offersTool?: string;
  /** Keep calls that offered no tools (router / structured-output). */
  withoutTools?: boolean;
  /** Keep calls after this mark (0-based seq / call count from `mark()`). */
  since?: SessionMark;
  /**
   * Allow empty-session and empty-filter assertions to proceed.
   * Prefer `allowEmpty()` on the query or expectation. Default is to fail with
   * `no calls recorded for session <id>` (whole session) or
   * `no calls matched query (<filters>)` (filtered).
   */
  allowEmpty?: boolean;
}

export interface SessionOptions {
  proxyUrl?: string;
  controlUrl?: string;
  bearerToken?: string;
  sessionId?: string;
  defaultWait?: WaitOptions;
  fetch?: typeof fetch;
}

export interface ProxyLaunchOptions {
  proxyUrl?: string;
  controlUrl?: string;
  bearerToken?: string;
  binaryPath?: string;
  upstreamBaseUrl?: string;
  upstreamName?: string;
  upstreams?: string;
  host?: string;
  port?: number;
  controlPort?: number;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  healthTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface ProxyHandle {
  proxyUrl: string;
  controlUrl: string;
  bearerToken?: string;
  pid?: number;
  instanceId?: string;
  exePath?: string;
  stop(): Promise<void>;
}

export interface Validation {
  mode?: string;
  profile?: string;
  specSha?: string;
  requestChecked?: boolean;
  responseChecked?: boolean;
  skippedReason?: string;
  truncated?: boolean;
  schemaSubsetRetrieved?: string;
  durationUs?: number;
  raw: JsonValue;
}

export interface SpecViolation {
  side?: string;
  source?: string;
  path?: string;
  pointer?: string;
  keyword?: string;
  message?: string;
  profile?: string;
  schemaRef?: string;
  offset?: number;
  eventIndex?: number;
  raw: JsonValue;
}

export interface IgnoredField {
  side?: string;
  path?: string;
  pointer?: string;
  kind?: string;
  severity?: string;
  message?: string;
  raw: JsonValue;
}

export interface SpecAssertionOptions {
  side?: string;
  /** 0-based indices into the filtered call list, or call ids. */
  calls?: Array<number | string>;
  ignorePaths?: string[];
  ignoreKeywords?: string[];
  allowUnvalidated?: boolean;
}

export interface IsolatedFromOptions {
  /** Require every call's `sessionSource` to be `path`. */
  requirePathSource?: boolean;
  /**
   * Allow isolation to pass when this session has zero calls.
   * Prefer `allowEmpty()` on the expectation. Default is to fail with
   * `no calls recorded for session <id>`. An empty *other* session is not
   * a leak (it introduced nothing).
   */
  allowEmpty?: boolean;
  /**
   * Ignore user texts shorter than this after normalization
   * (trim, collapse whitespace, casefold). Default 8.
   */
  minChars?: number;
  /** User texts to ignore after the same normalization. */
  ignoreTexts?: string[];
}

export interface CallRecord {
  id?: string;
  /** 1-based index within this session. Process-global `id` is not this. */
  seq?: number;
  /** Session this call was recorded on (`session_id` on the wire). */
  sessionId?: string;
  apiType?: ApiType;
  apiFamily?: string;
  model?: string;
  request?: JsonValue;
  response?: JsonValue;
  error?: JsonValue;
  metadata?: JsonObject;
  usage?: JsonObject;
  latencyMs?: number;
  ttftMs?: number;
  retries?: number;
  startedAt?: string;
  finishedAt?: string;
  streamed?: boolean;
  httpStatus?: number;
  /** Top-level `client_aborted`, falling back to `normalized.client_aborted`. */
  clientAborted?: boolean;
  /**
   * `before_headers` | `after_headers` when the client cancelled.
   * Omitted when the call is not aborted. A close after `[DONE]` or a
   * terminal Responses event is not an abort.
   */
  abortPhase?: AbortPhase;
  validation?: Validation;
  /** `[]` means checked and clean; omitted means validation was not run. */
  specViolations?: SpecViolation[];
  /** `[]` means checked and clean; omitted means ignored fields were not recorded. */
  ignoredFields?: IgnoredField[];
  promptText?: string;
  responseText?: string;
  /** How the proxy attributed the call (`path`, `header`, `baggage`, `default`). */
  sessionSource?: string;
  /** Upstream URL the proxy forwarded to (the `/s/{session}` prefix is not forwarded). */
  upstreamUrl?: string;
  /** Joined text for each user-role message (Chat `messages`, Responses `input`). */
  userTexts?: string[];
  raw: JsonValue;
}

export interface SessionTrace {
  id: string;
  calls: CallRecord[];
  raw: JsonValue;
  summary?: string;
  specViolations(): SpecViolation[];
  ignoredFields(): IgnoredField[];
  since(mark: SessionMark): CallRecord[];
}

export interface SessionSummary {
  id: string;
  calls: number;
  active: number;
  sources: string[];
  firstStartedAt?: string;
  lastEndedAt?: string;
  raw: JsonValue;
}

export interface ProxyConfig {
  version?: string;
  upstreams?: JsonValue;
  raw: JsonValue;
}

export interface ListSessionsOptions {
  source?: string;
}

export interface AssertionResult {
  pass: boolean;
  message: string;
  trace: SessionTrace;
  error?: Error;
}

export interface ToolCallAssertionOptions {
  argsSubset?: JsonValue;
  argsMatcher?: (args: JsonValue, call: NormalizedToolCall, record: CallRecord) => boolean;
}

export interface CalledTimesOptions extends ToolCallAssertionOptions {
  count: number;
}

export interface NormalizedToolCall {
  id?: string;
  name: string;
  args: JsonValue;
  raw: JsonValue;
  index: number;
  record: CallRecord;
}

export interface TokenBounds {
  prompt?: Bounds;
  completion?: Bounds;
  total?: Bounds;
}

export interface UsageDetailsBounds {
  cachedTokens?: Bounds;
  reasoningTokens?: Bounds;
}

export interface Bounds {
  min?: number;
  max?: number;
}

export interface JsonSchemaAssertionOptions {
  schema: JsonObject;
  data?: "response" | "request" | "toolArguments";
  toolName?: string;
}

export interface BinaryDownloadOptions {
  version?: string;
  repo?: string;
  githubToken?: string;
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

export interface BinaryResolutionOptions extends BinaryDownloadOptions {
  binaryName?: string;
  allowDownload?: boolean;
}

export interface SessionGlobals {
  __LLMENTARY__?: ProxyHandle;
}
