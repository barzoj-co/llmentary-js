export type ApiType = "chat_completions" | "responses" | (string & {});

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

export interface QueryOptions {
  apiType?: ApiType;
  model?: string | RegExp;
  /** 0-based index into the filtered call list. */
  index?: number;
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

export interface CallRecord {
  id?: string;
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
  validation?: Validation;
  /** `[]` means checked and clean; omitted means validation was not run. */
  specViolations?: SpecViolation[];
  /** `[]` means checked and clean; omitted means ignored fields were not recorded. */
  ignoredFields?: IgnoredField[];
  raw: JsonValue;
}

export interface SessionTrace {
  id: string;
  calls: CallRecord[];
  raw: JsonValue;
  summary?: string;
  specViolations(): SpecViolation[];
  ignoredFields(): IgnoredField[];
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
