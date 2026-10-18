import type { ApiType, CallRecord, JsonObject, JsonValue, SessionTrace } from "./types.js";

export function normalizeSessionTrace(sessionId: string, raw: JsonValue): SessionTrace {
  const object = asObject(raw);
  const id = stringAt(object, "id") ?? stringAt(object, "session_id") ?? sessionId;
  const callsValue =
    arrayAt(object, "calls") ??
    arrayAt(object, "records") ??
    arrayAt(object, "requests") ??
    arrayAt(object, "traces") ??
    [];
  const calls = callsValue.map((value) => normalizeCallRecord(value));
  const summary = stringAt(object, "summary") ?? stringAt(object, "trace_summary");
  return {
    id,
    calls,
    raw,
    ...(summary !== undefined ? { summary } : {}),
  };
}

export function normalizeCallRecord(raw: JsonValue): CallRecord {
  const object = asObject(raw);
  const normalized = objectAt(object, "normalized");
  const decodedRequest = decodeRawPayload(stringAt(object, "raw_request"));
  const decodedResponse = decodeRawPayload(stringAt(object, "raw_response"));
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
  const apiType = normalizeApiType(
    stringAt(object, "api_family") ??
      stringAt(object, "api_type") ??
      stringAt(object, "apiType") ??
      stringAt(object, "endpoint") ??
      stringAt(metadata, "api_type") ??
      inferApiTypeFromRequestPath(
        stringAt(objectAt(object, "upstream"), "url") ?? stringAt(object, "path"),
      ),
  );
  const model =
    modelFromNormalized(normalized) ??
    stringAt(object, "model") ??
    stringAt(asObject(request), "model") ??
    stringAt(asObject(response), "model") ??
    stringAt(metadata, "model");
  const id = stringAt(object, "id");
  const latencyMs = numberAt(object, "latency_ms") ?? numberAt(object, "latencyMs") ?? numberAt(metadata, "latency_ms");
  const ttftMs = numberAt(object, "ttft_ms") ?? numberAt(object, "ttftMs") ?? numberAt(metadata, "ttft_ms");
  const retries = numberAt(object, "retries") ?? numberAt(metadata, "retries");
  const startedAt = stringAt(object, "started_at") ?? stringAt(object, "startedAt");
  const finishedAt = stringAt(object, "ended_at") ?? stringAt(object, "finished_at") ?? stringAt(object, "finishedAt");
  const streamed = inferStreamed(request, normalized, object);
  const httpStatus = inferHttpStatus(object, error, metadata);
  const usageWithDetails = enrichUsageDetails(usage, response, decodedResponse);
  return {
    raw,
    ...(id ? { id } : {}),
    ...(apiType ? { apiType } : {}),
    ...(model ? { model } : {}),
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

function inferHttpStatus(
  object: JsonObject,
  error: JsonValue | undefined,
  metadata: JsonObject | undefined,
): number | undefined {
  const errorObject = asObject(error);
  const nestedError = objectAt(errorObject, "error") ?? asObject(valueAt(asObject(objectAt(object, "response")), "error"));
  return (
    numberAt(object, "status") ??
    numberAt(object, "status_code") ??
    numberAt(object, "http_status") ??
    numberAt(errorObject, "status") ??
    numberAt(errorObject, "http_status") ??
    numberAt(nestedError, "status") ??
    numberAt(nestedError, "http_status") ??
    numberAt(metadata, "status") ??
    numberAt(metadata, "http_status")
  );
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
