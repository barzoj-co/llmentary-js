import type {
  AbortPhase,
  ApiType,
  CallOutcome,
  CallRecord,
  IgnoredField,
  InFlightCall,
  JsonObject,
  JsonValue,
  ReasoningIn,
  SessionTrace,
  SpecViolation,
  Validation,
} from "./types.js";

export function normalizeSessionTrace(sessionId: string, raw: JsonValue): SessionTrace {
  const object = asObject(raw);
  const id = stringAt(object, "id") ?? stringAt(object, "session_id") ?? sessionId;
  const callsValue =
    arrayAt(object, "calls") ??
    arrayAt(object, "Calls") ??
    arrayAt(object, "records") ??
    arrayAt(object, "Records") ??
    arrayAt(object, "requests") ??
    arrayAt(object, "Requests") ??
    arrayAt(object, "traces") ??
    arrayAt(object, "Traces") ??
    [];
  const calls = callsValue.map((value) => {
    const record = normalizeCallRecord(value);
    return record.sessionId ? record : { ...record, sessionId: id };
  });
  const summary = stringAt(object, "summary") ?? stringAt(object, "trace_summary");
  const inFlight = parseInFlightCalls(valueAt(object, "in_flight") ?? valueAt(object, "inFlight"));
  return attachTraceHelpers(id, calls, raw, summary, inFlight);
}

export function normalizeCallRecord(raw: JsonValue): CallRecord {
  const object = asObject(raw);
  const normalized = objectAt(object, "normalized");
  const decodedRequest = decodeRecordPayload(valueAt(object, "raw_request") ?? valueAt(object, "rawRequest"));
  const decodedResponse = decodeRecordPayload(valueAt(object, "raw_response") ?? valueAt(object, "rawResponse"));
  const headerRequest = valueAt(object, "request") ?? valueAt(object, "request_body") ?? valueAt(object, "requestBody");
  const headerResponse = valueAt(object, "response") ?? valueAt(object, "response_body") ?? valueAt(object, "responseBody");
  const request = preferBody(decodedRequest, headerRequest);
  const response = synthesizeResponse(decodedResponse, headerResponse, normalized);
  const error =
    valueAt(normalized, "error") ??
    valueAt(object, "error") ??
    valueAt(object, "stream_error") ??
    valueAt(object, "streamError");
  const metadata = objectAt(object, "metadata") ?? objectAt(object, "meta");
  const usage =
    objectAt(normalized, "usage") ??
    objectAt(object, "usage") ??
    objectAt(asObject(response), "usage") ??
    objectAt(asObject(objectAt(object, "final_response")), "usage");
  const apiFamily =
    stringAt(object, "api_family") ??
    stringAt(object, "apiFamily") ??
    stringAt(object, "api_type") ??
    stringAt(object, "apiType") ??
    stringAt(object, "endpoint") ??
    stringAt(metadata, "api_type");
  const apiType = normalizeApiType(
    apiFamily ??
      inferApiTypeFromRequestPath(
        stringAt(objectAt(object, "upstream"), "url") ?? stringAt(object, "path"),
      ),
  );
  const validation = parseValidation(objectAt(normalized, "validation") ?? objectAt(object, "validation"));
  const specViolations = parseSpecViolationList(normalized, object);
  const ignoredFields = parseIgnoredFieldList(normalized, object);
  const model =
    modelFromNormalized(normalized) ??
    stringAt(object, "model") ??
    stringAt(asObject(request), "model") ??
    stringAt(asObject(response), "model") ??
    stringAt(metadata, "model");
  const id = stringAt(object, "id");
  const seq = numberAt(object, "seq") ?? numberAt(object, "sequence") ?? numberAt(object, "sequence_number");
  const sessionId = stringAt(object, "session_id") ?? stringAt(object, "sessionId");
  const userTexts = extractUserTexts(request);
  const latencyMs = numberAt(object, "latency_ms") ?? numberAt(object, "latencyMs") ?? numberAt(metadata, "latency_ms");
  const ttftMs = numberAt(object, "ttft_ms") ?? numberAt(object, "ttftMs") ?? numberAt(metadata, "ttft_ms");
  const retries = numberAt(object, "retries") ?? numberAt(metadata, "retries");
  const startedAt = stringAt(object, "started_at") ?? stringAt(object, "startedAt");
  const finishedAt = stringAt(object, "ended_at") ?? stringAt(object, "finished_at") ?? stringAt(object, "finishedAt");
  const streamed = inferStreamed(request, normalized, object);
  const httpStatus = inferHttpStatus(object, error, metadata);
  const clientAborted = inferClientAborted(object, normalized);
  const abortPhase = inferAbortPhase(object, normalized);
  const usageWithDetails = enrichUsageDetails(usage, response, decodedResponse);
  const reasoningIn = parseReasoningIn(valueAt(normalized, "reasoning_in") ?? valueAt(normalized, "reasoningIn"));
  const promptText = textFromPayload(request);
  const responseText = responseTextFromPayload(response, normalized);
  const sessionSource =
    stringAt(object, "session_source") ??
    stringAt(object, "sessionSource") ??
    stringAt(metadata, "session_source") ??
    stringAt(metadata, "sessionSource");
  const upstreamUrl =
    stringAt(objectAt(object, "upstream"), "url") ??
    stringAt(object, "upstream_url") ??
    stringAt(object, "upstreamUrl");
  const upstreamCalled =
    booleanAt(object, "upstream_called") ?? booleanAt(object, "upstreamCalled");
  const errorSource = stringAt(asObject(error), "source");
  const outcome = finishedAt
    ? inferOutcome(object, normalized, {
        raw,
        ...(error !== undefined ? { error } : {}),
        ...(metadata ? { metadata } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(clientAborted !== undefined ? { clientAborted } : {}),
      })
    : undefined;
  return {
    raw,
    ...(id ? { id } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(userTexts.length > 0 ? { userTexts } : {}),
    ...(apiType ? { apiType } : {}),
    ...(apiFamily ? { apiFamily } : {}),
    ...(model ? { model } : {}),
    ...(validation ? { validation } : {}),
    ...(specViolations !== undefined ? { specViolations } : {}),
    ...(ignoredFields !== undefined ? { ignoredFields } : {}),
    ...(request !== undefined ? { request } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(metadata ? { metadata } : {}),
    ...(usageWithDetails ? { usage: usageWithDetails } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(streamed !== undefined ? { streamed } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(clientAborted !== undefined ? { clientAborted } : {}),
    ...(clientAborted === true && abortPhase ? { abortPhase } : {}),
    ...(outcome ? { outcome } : {}),
    ...(reasoningIn ? { reasoningIn } : {}),
    ...(promptText ? { promptText } : {}),
    ...(responseText ? { responseText } : {}),
    ...(sessionSource ? { sessionSource } : {}),
    ...(upstreamUrl ? { upstreamUrl } : {}),
    ...(upstreamCalled !== undefined ? { upstreamCalled } : {}),
    ...(errorSource ? { errorSource } : {}),
  };
}

function attachTraceHelpers(
  id: string,
  calls: CallRecord[],
  raw: JsonValue,
  summary?: string,
  inFlight?: InFlightCall[],
): SessionTrace {
  return {
    id,
    calls,
    raw,
    ...(summary !== undefined ? { summary } : {}),
    ...(inFlight !== undefined ? { inFlight } : {}),
    specViolations() {
      return calls.flatMap((call) => call.specViolations ?? []);
    },
    ignoredFields() {
      return calls.flatMap((call) => call.ignoredFields ?? []);
    },
    since(mark) {
      return calls.slice(mark);
    },
  };
}

export function asObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

export function valueAt(object: JsonObject | undefined, key: string): JsonValue | undefined {
  if (!object) return undefined;
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

export function stringAt(object: JsonObject | undefined, key: string): string | undefined {
  const value = valueAt(object, key);
  return typeof value === "string" ? value : undefined;
}

export function numberAt(object: JsonObject | undefined, key: string): number | undefined {
  const value = valueAt(object, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function objectAt(object: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = valueAt(object, key);
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function arrayAt(object: JsonObject | undefined, key: string): JsonValue[] | undefined {
  const value = valueAt(object, key);
  return Array.isArray(value) ? value : undefined;
}

function normalizeApiType(value: string | undefined): ApiType | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[-./]/g, "_");
  if (normalized.includes("response")) return "responses";
  if (normalized.includes("chat") || normalized.includes("completion")) return "chat_completions";
  return value;
}

function inferApiTypeFromRequestPath(path: string | undefined): ApiType | undefined {
  if (!path) return undefined;
  if (path.includes("/chat/completions")) return "chat_completions";
  if (path.includes("/responses")) return "responses";
  return undefined;
}

function modelFromNormalized(normalized: JsonObject | undefined): string | undefined {
  const model = objectAt(normalized, "model");
  return stringAt(model, "returned") ?? stringAt(model, "requested") ?? stringAt(normalized, "model");
}

function preferBody(decoded: JsonValue | undefined, headerOrBody: JsonValue | undefined): JsonValue | undefined {
  if (isJsonObjectBody(decoded) || typeof decoded === "string") return decoded;
  if (isJsonObjectBody(headerOrBody)) return headerOrBody;
  return decoded ?? headerOrBody;
}

function synthesizeResponse(
  decoded: JsonValue | undefined,
  headerResponse: JsonValue | undefined,
  normalized: JsonObject | undefined,
): JsonValue | undefined {
  if (isJsonObjectBody(decoded)) return decoded;
  if (isJsonObjectBody(headerResponse)) return headerResponse;
  if (!normalized) return decoded ?? headerResponse;

  const synthesized: JsonObject = {};
  if (typeof decoded === "string" && decoded) synthesized.raw_text = decoded;
  const outputText = stringAt(normalized, "output_text");
  const toolCalls = arrayAt(normalized, "tool_calls");
  const finishReason = stringAt(normalized, "finish_reason");
  const usage = objectAt(normalized, "usage");
  const error = valueAt(normalized, "error");
  const model = modelFromNormalized(normalized);
  if (outputText) synthesized.output_text = outputText;
  if (toolCalls) synthesized.tool_calls = toolCalls;
  if (finishReason) synthesized.finish_reason = finishReason;
  if (usage) synthesized.usage = usage;
  if (error !== undefined) synthesized.error = error;
  if (model) synthesized.model = model;
  return Object.keys(synthesized).length > 0 ? synthesized : decoded ?? headerResponse;
}

function isJsonObjectBody(value: JsonValue | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return !isHeadersOnly(value);
}

function isHeadersOnly(value: JsonValue): boolean {
  const object = asObject(value);
  const keys = Object.keys(object);
  return keys.includes("headers") && keys.every((key) => key === "headers");
}

function decodeRecordPayload(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return decodeRawPayload(value);
  return value;
}

function decodeRawPayload(value: string | undefined): JsonValue | undefined {
  if (!value) return undefined;
  const text = decodeMaybeBase64(value);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

function decodeMaybeBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("data:")) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (!decoded || decoded.includes("\u0000")) return trimmed;
    return decoded;
  } catch {
    return trimmed;
  }
}

function inferStreamed(
  request: JsonValue | undefined,
  normalized: JsonObject | undefined,
  object: JsonObject,
): boolean | undefined {
  if (valueAt(asObject(request), "stream") === true || valueAt(object, "stream") === true) return true;
  if (valueAt(normalized, "streamed") === true || valueAt(object, "streamed") === true) return true;
  if (valueAt(asObject(request), "stream") === false) return false;
  if (valueAt(normalized, "streamed") === false || valueAt(object, "streamed") === false) return false;
  return undefined;
}

function booleanAt(object: JsonObject | undefined, key: string): boolean | undefined {
  const value = valueAt(object, key);
  return typeof value === "boolean" ? value : undefined;
}

function inferClientAborted(object: JsonObject, normalized: JsonObject | undefined): boolean | undefined {
  return (
    booleanAt(object, "client_aborted") ??
    booleanAt(object, "clientAborted") ??
    booleanAt(normalized, "client_aborted") ??
    booleanAt(normalized, "clientAborted")
  );
}

/** DOG-58 terminal state for a settled call. The abort phase never changes it. */
export function inferOutcome(
  object: JsonObject,
  normalized: JsonObject | undefined,
  record: CallRecord,
): CallOutcome {
  const recorded = asCallOutcome(record.outcome) ?? asCallOutcome(valueAt(object, "outcome"));
  if (recorded) return recorded;
  const errorObject = asObject(record.error);
  const errorSource = valueAt(errorObject, "source");
  const clientError =
    stringAt(errorObject, "normalized") === "client_aborted" &&
    record.clientAborted === true &&
    (errorSource === undefined || errorSource === null || errorSource === "client");
  if (record.error !== undefined && !clientError) return "failed";
  const httpStatus = outcomeHttpStatus(object, record);
  if (httpStatus !== undefined && httpStatus >= 400) return "failed";
  if (record.clientAborted === true) return "cancelled";
  if (valueAt(normalized, "stream_truncated") === true) return "failed";
  if (httpStatus === 0) return "failed";
  return "committed";
}

/** `inferHttpStatus` drops `0`; the DOG-58 rule needs to see it. */
function outcomeHttpStatus(object: JsonObject, record: CallRecord): number | undefined {
  return (
    record.httpStatus ??
    numberAt(object, "http_status") ??
    numberAt(object, "status") ??
    numberAt(object, "status_code")
  );
}

function asCallOutcome(value: JsonValue | undefined): CallOutcome | undefined {
  return value === "committed" || value === "cancelled" || value === "failed" ? value : undefined;
}

function inferAbortPhase(object: JsonObject, normalized: JsonObject | undefined): AbortPhase | undefined {
  const raw =
    stringAt(object, "abort_phase") ??
    stringAt(object, "abortPhase") ??
    stringAt(normalized, "abort_phase") ??
    stringAt(normalized, "abortPhase");
  if (raw === "before_headers" || raw === "after_headers") return raw;
  return undefined;
}

function inferHttpStatus(
  object: JsonObject,
  error: JsonValue | undefined,
  metadata: JsonObject | undefined,
): number | undefined {
  const errorObject = asObject(error);
  const nestedError = objectAt(errorObject, "error") ?? asObject(valueAt(asObject(objectAt(object, "response")), "error"));
  const candidates = [
    numberAt(object, "status"),
    numberAt(object, "status_code"),
    numberAt(object, "http_status"),
    numberAt(errorObject, "status"),
    numberAt(errorObject, "http_status"),
    numberAt(nestedError, "status"),
    numberAt(nestedError, "http_status"),
    numberAt(metadata, "status"),
    numberAt(metadata, "http_status"),
  ];
  return candidates.find((status) => status !== undefined && status !== 0);
}

function enrichUsageDetails(
  usage: JsonObject | undefined,
  response: JsonValue | undefined,
  decodedResponse: JsonValue | undefined,
): JsonObject | undefined {
  const fromResponse = objectAt(asObject(response), "usage") ?? objectAt(asObject(decodedResponse), "usage");
  const base = usage ?? fromResponse;
  if (!base && !fromResponse) return usage;
  const merged: JsonObject = { ...(fromResponse ?? {}), ...(base ?? {}) };
  const cached = firstPositiveOrDefined(
    numberAt(objectAt(merged, "input_tokens_details"), "cached_tokens"),
    numberAt(objectAt(merged, "prompt_tokens_details"), "cached_tokens"),
    numberAt(objectAt(merged, "promptTokensDetails"), "cached_tokens"),
    numberAt(objectAt(merged, "inputTokensDetails"), "cached_tokens"),
    numberAt(merged, "cached_tokens"),
  );
  const reasoning = firstPositiveOrDefined(
    numberAt(objectAt(merged, "output_tokens_details"), "reasoning_tokens"),
    numberAt(objectAt(merged, "completion_tokens_details"), "reasoning_tokens"),
    numberAt(objectAt(merged, "completionTokensDetails"), "reasoning_tokens"),
    numberAt(objectAt(merged, "outputTokensDetails"), "reasoning_tokens"),
    numberAt(merged, "reasoning_tokens"),
  );
  if (cached !== undefined) merged.cached_tokens = cached;
  if (reasoning !== undefined) merged.reasoning_tokens = reasoning;
  return Object.keys(merged).length > 0 ? merged : usage;
}

/** Prefer a nested >0 detail over a top-level 0 that would otherwise shadow it via `??`. */
export function firstPositiveOrDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.find((value) => value > 0) ?? defined[0];
}

function parseValidation(raw: JsonObject | undefined): Validation | undefined {
  if (!raw || Object.keys(raw).length === 0) return undefined;
  const out: Validation = { raw };
  const mode = stringAt(raw, "mode");
  const profile = stringAt(raw, "profile");
  const target = stringAt(raw, "target");
  const specSha = stringAt(raw, "spec_sha") ?? stringAt(raw, "specSha");
  const skippedReason = stringAt(raw, "skipped_reason") ?? stringAt(raw, "skippedReason");
  const schemaSubsetRetrieved = stringAt(raw, "schema_subset_retrieved") ?? stringAt(raw, "schemaSubsetRetrieved");
  const durationUs = numberAt(raw, "duration_us") ?? numberAt(raw, "durationUs");
  if (mode) out.mode = mode;
  if (profile) out.profile = profile;
  if (target) out.target = target;
  if (specSha) out.specSha = specSha;
  if (typeof valueAt(raw, "request_checked") === "boolean" || typeof valueAt(raw, "requestChecked") === "boolean") {
    out.requestChecked = Boolean(valueAt(raw, "request_checked") ?? valueAt(raw, "requestChecked"));
  }
  if (typeof valueAt(raw, "response_checked") === "boolean" || typeof valueAt(raw, "responseChecked") === "boolean") {
    out.responseChecked = Boolean(valueAt(raw, "response_checked") ?? valueAt(raw, "responseChecked"));
  }
  if (skippedReason) out.skippedReason = skippedReason;
  if (typeof valueAt(raw, "truncated") === "boolean") out.truncated = Boolean(valueAt(raw, "truncated"));
  if (schemaSubsetRetrieved) out.schemaSubsetRetrieved = schemaSubsetRetrieved;
  if (durationUs !== undefined) out.durationUs = durationUs;
  return out;
}

function parseSpecViolationList(normalized: JsonObject | undefined, object: JsonObject): SpecViolation[] | undefined {
  const values = firstArrayAt([normalized, object], ["spec_violations", "specViolations", "SpecViolations"]);
  return values?.map((value) => parseSpecViolation(value));
}

function parseIgnoredFieldList(normalized: JsonObject | undefined, object: JsonObject): IgnoredField[] | undefined {
  const values = firstArrayAt([normalized, object], ["ignored_fields", "ignoredFields", "IgnoredFields"]);
  return values?.map((value) => parseIgnoredField(value));
}

/** Missing or null keys fall through; an empty array is an intentional clean list. */
function firstArrayAt(objects: Array<JsonObject | undefined>, keys: string[]): JsonValue[] | undefined {
  for (const object of objects) {
    for (const key of keys) {
      const value = valueAt(object, key);
      if (Array.isArray(value)) return value;
    }
  }
  return undefined;
}

function parseSpecViolation(raw: JsonValue): SpecViolation {
  const object = asObject(raw);
  const out: SpecViolation = { raw };
  const side = stringAt(object, "context") || stringAt(object, "side");
  const source = stringAt(object, "source");
  const path = stringAt(object, "path");
  const pointer = stringAt(object, "pointer");
  const keyword = stringAt(object, "keyword");
  const message = stringAt(object, "message");
  const profile = stringAt(object, "profile");
  const schemaRef = stringAt(object, "schema_ref") ?? stringAt(object, "schemaRef");
  const offset = numberAt(object, "offset");
  const eventIndex = numberAt(object, "event_index") ?? numberAt(object, "eventIndex");
  const severity = stringAt(object, "severity");
  const count = numberAt(object, "count");
  if (side) out.side = side;
  if (source) out.source = source;
  if (path) out.path = path;
  if (pointer) out.pointer = pointer;
  if (keyword) out.keyword = keyword;
  if (message) out.message = message;
  if (profile) out.profile = profile;
  if (schemaRef) out.schemaRef = schemaRef;
  if (offset !== undefined) out.offset = offset;
  if (eventIndex !== undefined) out.eventIndex = eventIndex;
  if (severity) out.severity = severity;
  if (count !== undefined) out.count = count;
  return out;
}

function parseIgnoredField(raw: JsonValue): IgnoredField {
  const object = asObject(raw);
  const out: IgnoredField = { raw };
  const side = stringAt(object, "context") || stringAt(object, "side");
  const path = stringAt(object, "path");
  const pointer = stringAt(object, "pointer");
  const kind = stringAt(object, "kind");
  const severity = stringAt(object, "severity");
  const action = stringAt(object, "action");
  const message = stringAt(object, "message");
  if (side) out.side = side;
  if (path) out.path = path;
  if (pointer) out.pointer = pointer;
  if (kind) out.kind = kind;
  if (severity) out.severity = severity;
  if (action) out.action = action;
  if (message) out.message = message;
  return out;
}

export function validationWasRun(record: CallRecord): boolean {
  if (record.specViolations !== undefined) return true;
  const validation = record.validation;
  if (!validation) return false;
  if (validation.skippedReason) return false;
  if (validation.requestChecked === true || validation.responseChecked === true) return true;
  if (validation.mode && validation.mode !== "off") return true;
  return false;
}

export function attachSessionTraceHelpers(
  id: string,
  calls: CallRecord[],
  raw: JsonValue,
  summary?: string,
  inFlight?: InFlightCall[],
): SessionTrace {
  return attachTraceHelpers(id, calls, raw, summary, inFlight);
}

export function parseInFlightCalls(raw: JsonValue | undefined): InFlightCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((value) => parseInFlightCall(value))
    .filter((call): call is InFlightCall => call !== undefined);
}

function parseInFlightCall(raw: JsonValue): InFlightCall | undefined {
  const object = asObject(raw);
  const callId = stringAt(object, "call_id") ?? stringAt(object, "callId") ?? stringAt(object, "id");
  const method = stringAt(object, "method");
  const path = stringAt(object, "path");
  const phase = stringAt(object, "phase");
  if (!callId && !method && !path && !phase) return undefined;
  const seq = numberAt(object, "seq");
  const apiFamily =
    stringAt(object, "api_family") ?? stringAt(object, "apiFamily") ?? stringAt(object, "api_type");
  const upstream = stringAt(object, "upstream");
  const startedAt = stringAt(object, "started_at") ?? stringAt(object, "startedAt");
  const elapsedMs = numberAt(object, "elapsed_ms") ?? numberAt(object, "elapsedMs");
  const bytesReceived = numberAt(object, "bytes_received") ?? numberAt(object, "bytesReceived");
  const httpStatus = numberAt(object, "http_status") ?? numberAt(object, "httpStatus");
  return {
    ...(callId ? { callId } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(method ? { method } : {}),
    ...(path ? { path } : {}),
    ...(apiFamily ? { apiFamily } : {}),
    ...(upstream ? { upstream } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(phase ? { phase } : {}),
    ...(bytesReceived !== undefined ? { bytesReceived } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

function parseReasoningIn(raw: JsonValue | undefined): ReasoningIn | undefined {
  const object = asObject(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const assistantTurns = numberAt(object, "assistant_turns") ?? numberAt(object, "assistantTurns");
  const withReasoning = numberAt(object, "with_reasoning") ?? numberAt(object, "withReasoning");
  const chars = numberAt(object, "chars");
  if (assistantTurns === undefined && withReasoning === undefined && chars === undefined && Object.keys(object).length === 0) {
    return undefined;
  }
  return {
    raw,
    ...(assistantTurns !== undefined ? { assistantTurns } : {}),
    ...(withReasoning !== undefined ? { withReasoning } : {}),
    ...(chars !== undefined ? { chars } : {}),
  };
}

export function extractUserTexts(request: JsonValue | undefined): string[] {
  const texts: string[] = [];
  for (const message of extractUserMessages(request)) {
    texts.push(message);
  }
  return texts;
}

/** One string per user-role message; content parts are joined. */
export function extractUserMessages(request: JsonValue | undefined): string[] {
  const texts: string[] = [];
  const object = asObject(request);
  for (const message of asArray(valueAt(object, "messages"))) {
    collectUserRoleMessage(message, texts);
  }
  const input = valueAt(object, "input");
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed) texts.push(trimmed);
  } else {
    for (const item of asArray(input)) {
      collectUserRoleMessage(item, texts);
    }
  }
  return texts;
}

export function normalizeIsolationText(text: string): string {
  // toUpperCase().toLowerCase() applies full Unicode casefold (ß → ss).
  return text.trim().replace(/\s+/g, " ").toUpperCase().toLowerCase();
}

function collectUserRoleMessage(value: JsonValue, texts: string[]): void {
  const object = asObject(value);
  if (stringAt(object, "role") !== "user") return;
  const joined = joinContentParts(valueAt(object, "content"));
  if (joined) texts.push(joined);
}

function joinContentParts(content: JsonValue | undefined): string {
  if (typeof content === "string") return content.trim();
  const parts: string[] = [];
  for (const part of asArray(content)) {
    if (typeof part === "string") {
      if (part.trim()) parts.push(part.trim());
      continue;
    }
    const object = asObject(part);
    const text = stringAt(object, "text") ?? stringAt(object, "input_text");
    if (text?.trim()) parts.push(text.trim());
  }
  return parts.join(" ").trim();
}

function textFromPayload(value: JsonValue | undefined): string | undefined {
  const text = collectText(value);
  return text || undefined;
}

function responseTextFromPayload(response: JsonValue | undefined, normalized: JsonObject | undefined): string | undefined {
  const outputText = stringAt(asObject(response), "output_text") ?? stringAt(normalized, "output_text");
  if (outputText) return outputText;
  const texts: string[] = [];
  for (const choice of asArray(valueAt(asObject(response), "choices"))) {
    const content = valueAt(objectAt(asObject(choice), "message"), "content");
    if (typeof content === "string" && content.trim()) texts.push(content);
  }
  for (const item of asArray(valueAt(asObject(response), "output"))) {
    const itemObject = asObject(item);
    if (stringAt(itemObject, "type") !== "message") continue;
    for (const part of asArray(valueAt(itemObject, "content"))) {
      if (typeof part === "string" && part.trim()) texts.push(part);
      else {
        const text = stringAt(asObject(part), "text");
        if (text?.trim()) texts.push(text);
      }
    }
  }
  if (texts.length > 0) return texts.join("\n");
  return typeof response === "string" && response.trim() ? response : undefined;
}

function collectText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("\n");
  return Object.values(value)
    .map(collectText)
    .filter(Boolean)
    .join("\n");
}

export function specStatusForRecord(record: CallRecord): string {
  const skipped = record.validation?.skippedReason;
  if (skipped) return `skipped:${skipped}`;
  if (!validationWasRun(record)) return "not checked";
  const count = record.specViolations?.length ?? 0;
  if (count > 0) return `${count} violation${count === 1 ? "" : "s"}`;
  if (record.validation?.requestChecked === true && record.validation.responseChecked !== true) {
    return "request_only";
  }
  return "clean";
}
