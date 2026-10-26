export type ApiType = "chat_completions" | "responses" | (string & {});

/** `before_headers` | `after_headers`. Omitted when the call is not aborted. */
export type AbortPhase = "before_headers" | "after_headers";

/** Terminal state of a settled call (DOG-58). */
export type CallOutcome = "committed" | "cancelled" | "failed";

/** Per-upstream spec target (`GET /config` `spec_targets`, `validation.target`). */
export type SpecTarget = "openai" | "openai-compatible" | (string & {});

/** In-flight wait snapshot. `http_status` is present after upstream headers. */
export type InFlightPhase = "awaiting_headers" | "streaming" | (string & {});

/** Request-side assistant reasoning echo (`normalized.reasoning_in`). */
export interface ReasoningIn {
  assistantTurns?: number;
  withReasoning?: number;
  /** Unicode character count. `0` is valid for encrypted-only reasoning. */
  chars?: number;
  raw: JsonValue;
}

/** Settled-only `calls` omit these; they appear on `error.in_flight` / `include=in_flight`. */
export interface InFlightCall {
  callId?: string;
  seq?: number;
  method?: string;
  path?: string;
  apiFamily?: string;
  upstream?: string;
  startedAt?: string;
  elapsedMs?: number;
  phase?: InFlightPhase;
  bytesReceived?: number;
  httpStatus?: number;
}

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
  /** Keep calls that are not `clientAborted` (DOG-50). */
  committed?: boolean;
  /** Keep only `clientAborted` calls (DOG-50). */
  aborted?: boolean;
  /** Keep only settled calls whose `outcome` is one of these states (DOG-58). */
  outcome?: readonly CallOutcome[];
}

export interface CallCountOptions {
  /**
   * Count calls that are not `clientAborted` (DOG-50).
   *
   * @deprecated Cancelled calls are excluded by default since DOG-58.
   */
  excludeAborted?: boolean;
  /** Count `cancelled` calls too (DOG-58). Default is to exclude them. */
  includeCancelled?: boolean;
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
  /** `name=openai` or `name=openai-compatible`. Repeatable / comma-separated. */
  specTargets?: string;
  /** Go duration. `0` / `0s` disables (default). */
  upstreamHeaderTimeout?: string;
  /** Go duration. `0` / `0s` disables (default). */
  upstreamIdleTimeout?: string;
  /** Extra first path segments after `/s/{session}` / `/u/{name}`. */
  allowPathPrefix?: string;
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
  /** `openai` or `openai-compatible` when the proxy recorded a spec target. */
  target?: SpecTarget;
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
  severity?: string;
  count?: number;
  raw: JsonValue;
}

export interface IgnoredField {
  /** Effective side: wire `context`, then `side`. Public field is still `side`. */
  side?: string;
  path?: string;
  pointer?: string;
  kind?: string;
  /** `info` | `warning` | `error`; absent when the proxy does not classify the entry. */
  severity?: string;
  /** `report_only` for compatible-target vendor extras. */
  action?: string;
  message?: string;
  raw: JsonValue;
}

export interface SpecAssertionOptions {
  side?: string;
  /** 0-based indices into the filtered call list, or call ids. */
  calls?: Array<number | string>;
  ignorePaths?: string[];
  /** Entry `kind` (also matches a spec violation `keyword`). */
  ignoreKeywords?: string[];
  /** Alias of `ignoreKeywords`; the union of both is used when both are given. */
  ignoreKinds?: string[];
  /**
   * Drop findings whose `severity` is below this level
   * (`info` < `warning` < `error`). Findings without `severity` are kept
   * (fail closed).
   */
  minSeverity?: "info" | "warning" | "error";
  allowUnvalidated?: boolean;
}

export interface IsolatedFromOptions {
  /** Require every call's `sessionSource` to be `path`. */
  requirePathSource?: boolean;
  /**
   * Allow isolation to pass when this session or the other session has
   * zero calls. Prefer `allowEmpty()` on the expectation. Default is to
   * fail with `no calls recorded for session <id>` (empty self) or
   * `no calls recorded for session <id> (isolated_from needs calls on both sides)`
   * (empty or unknown other).
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
  /**
   * `committed` | `cancelled` | `failed` (DOG-58). Set on settled calls;
   * the abort phase never changes it.
   */
  outcome?: CallOutcome;
  validation?: Validation;
  /** Request-side reasoning echo (`normalized.reasoning_in`). */
  reasoningIn?: ReasoningIn;
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
  /**
   * Top-level `upstream_called`. True after the outbound request was written
   * (`httptrace.WroteRequest`). A header timeout or cancel can leave this false.
   */
  upstreamCalled?: boolean;
  /** `normalized.error.source` (`proxy` for DOG-39 upstream timeouts). */
  errorSource?: string;
  /** Joined text for each user-role message (Chat `messages`, Responses `input`). */
  userTexts?: string[];
  raw: JsonValue;
}

export interface SessionTrace {
  id: string;
  calls: CallRecord[];
  /** Present when the proxy returned `in_flight` (`include=in_flight` or a 504 body). */
  inFlight?: InFlightCall[];
  raw: JsonValue;
  summary?: string;
  specViolations(): SpecViolation[];
  ignoredFields(): IgnoredField[];
  since(mark: SessionMark): CallRecord[];
}

/** OpenAPI 0.5.0 `SessionSummary.spec` (`GET /sessions[].spec`). */
export interface SessionSpecSummary {
  checked: number;
  clean: number;
  findings: number;
  requestOnly: number;
  notChecked: number;
}

export interface SessionSummary {
  id: string;
  calls: number;
  active: number;
  sources: string[];
  firstStartedAt?: string;
  lastEndedAt?: string;
  /** Session spec counters from proxy DOG-38 (`spec_violation_count` / `SpecViolationCount`). */
  specViolationCount?: number;
  ignoredFieldCount?: number;
  /** Typed `GET /sessions[].spec` (DOG-51). */
  spec?: SessionSpecSummary;
  raw: JsonValue;
}

export interface ProxyConfig {
  version?: string;
  upstreams?: JsonValue;
  /** Effective `--spec-target` map (`openai` / `openai-compatible` per upstream name). */
  specTargets?: Record<string, string>;
  /** Effective `--upstream-header-timeout` (`0s` disables). */
  upstreamHeaderTimeout?: string;
  /** Effective `--upstream-idle-timeout` (`0s` disables). */
  upstreamIdleTimeout?: string;
  raw: JsonValue;
}

export interface ListSessionsOptions {
  source?: string;
}

export interface GetSessionOptions {
  /** Settled-only by default. `in_flight` adds `in_flight` next to `calls` (DOG-36). */
  include?: "in_flight";
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
