export type ApiType = "chat_completions" | "responses" | (string & {});

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface WaitOptions {
  timeoutMs?: number;
  idleMs?: number;
  signal?: AbortSignal;
}

export interface QueryOptions {
  apiType?: ApiType;
  model?: string | RegExp;
  /** 0-based index into the filtered call list. */
  index?: number;
}

export interface LabConfig {
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

export interface CallRecord {
  id?: string;
  apiType?: ApiType;
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
  raw: JsonValue;
}

export interface SessionTrace {
  id: string;
  calls: CallRecord[];
  raw: JsonValue;
  summary?: string;
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

export interface LlmTestLabGlobals {
  __LLM_TEST_LAB__?: ProxyHandle;
}
