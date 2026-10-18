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
  const request = valueAt(object, "request") ?? valueAt(object, "request_body") ?? valueAt(object, "requestBody");
  const response = valueAt(object, "response") ?? valueAt(object, "response_body") ?? valueAt(object, "responseBody");
  const error = valueAt(object, "error") ?? valueAt(object, "stream_error") ?? valueAt(object, "streamError");
  const metadata = objectAt(object, "metadata") ?? objectAt(object, "meta");
  const usage =
    objectAt(object, "usage") ??
    objectAt(asObject(response), "usage") ??
    objectAt(asObject(objectAt(object, "final_response")), "usage");
  const apiType = normalizeApiType(
    stringAt(object, "api_type") ??
      stringAt(object, "apiType") ??
      stringAt(object, "endpoint") ??
      stringAt(metadata, "api_type") ??
      inferApiTypeFromRequestPath(stringAt(object, "path")),
  );
  const model =
    stringAt(object, "model") ??
    stringAt(asObject(request), "model") ??
    stringAt(asObject(response), "model") ??
    stringAt(metadata, "model");
  const id = stringAt(object, "id");
  const latencyMs = numberAt(object, "latency_ms") ?? numberAt(object, "latencyMs") ?? numberAt(metadata, "latency_ms");
  const ttftMs = numberAt(object, "ttft_ms") ?? numberAt(object, "ttftMs") ?? numberAt(metadata, "ttft_ms");
  const retries = numberAt(object, "retries") ?? numberAt(metadata, "retries");
  const startedAt = stringAt(object, "started_at") ?? stringAt(object, "startedAt");
  const finishedAt = stringAt(object, "finished_at") ?? stringAt(object, "finishedAt");
  return {
    raw,
    ...(id ? { id } : {}),
    ...(apiType ? { apiType } : {}),
    ...(model ? { model } : {}),
    ...(request !== undefined ? { request } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(metadata ? { metadata } : {}),
    ...(usage ? { usage } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
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
  const normalized = value.toLowerCase().replace(/[-/]/g, "_");
  if (normalized.includes("chat") && normalized.includes("completion")) return "chat_completions";
  if (normalized.includes("response")) return "responses";
  return value;
}

function inferApiTypeFromRequestPath(path: string | undefined): ApiType | undefined {
  if (!path) return undefined;
  if (path.includes("/chat/completions")) return "chat_completions";
  if (path.includes("/responses")) return "responses";
  return undefined;
}
