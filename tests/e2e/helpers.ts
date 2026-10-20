import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import OpenAI, { APIError } from "openai";
import {
  SessionAssertionError,
  llmentary,
  type CallRecord,
  type JsonObject,
  type JsonValue,
  type Session,
  type ProxyHandle,
} from "../../src/index.js";
import { asObject, numberAt, objectAt, stringAt } from "../../src/normalize.js";

export const TEXT_MODEL = "gpt-4.1-nano";
export const TOOL_MODEL = "gpt-4.1-mini";
export const REASONING_MODEL = "o4-mini";

export const CITY_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    city: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["city", "ok"],
};

export const NAME_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
  },
  required: ["name"],
};

export function newSession(proxy: ProxyHandle): Session {
  return llmentary({
    proxyUrl: proxy.proxyUrl,
    controlUrl: proxy.controlUrl,
    defaultWait: { timeoutMs: 25_000, idleMs: 200 },
  });
}

export function openaiClient(lm: Session): OpenAI {
  return new OpenAI(lm.openAI());
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof SessionAssertionError) return false;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: number; code?: string; message?: string; cause?: unknown };
  if (candidate.status === 429 || (candidate.status !== undefined && candidate.status >= 500)) return true;
  const cause =
    candidate.cause instanceof Error
      ? candidate.cause.message
      : typeof candidate.cause === "string"
        ? candidate.cause
        : "";
  const text = `${candidate.code ?? ""} ${candidate.message ?? ""} ${cause}`.toLowerCase();
  return /econnreset|etimedout|econnrefused|fetch failed|socket|network|rate limit|overloaded|timeout|429/.test(text);
}

export async function retryNetwork<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isRetryableNetworkError(error) || attempt === attempts - 1) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
  throw last;
}

export async function expectHttpError(fn: () => Promise<unknown>, status: number): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof SessionAssertionError) throw error;
    if (error instanceof APIError && error.status === status) return error;
    if (error && typeof error === "object" && "status" in error && (error as { status?: number }).status === status) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected upstream HTTP ${status}`);
}

export async function consumeChatStream(
  stream: AsyncIterable<{ choices?: Array<{ delta?: { content?: string | null; tool_calls?: unknown } }> }>,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk.choices?.[0]?.delta?.content ?? "";
  }
  return text;
}

export function weatherToolChat(): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "lookup_weather",
      description: "Look up deterministic test weather.",
      strict: true,
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  };
}

export function timeToolChat(): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "lookup_time",
      description: "Look up deterministic test local time.",
      strict: true,
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  };
}

export function weatherToolResponses(): OpenAI.Responses.Tool {
  return {
    type: "function",
    name: "lookup_weather",
    description: "Look up deterministic test weather.",
    strict: true,
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  };
}

export function timeToolResponses(): OpenAI.Responses.Tool {
  return {
    type: "function",
    name: "lookup_time",
    description: "Look up deterministic test local time.",
    strict: true,
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  };
}

/** Unique prefix + enough filler that prompt_tokens is >= 1024 for automatic prefix caching. */
export function longPrompt(): string {
  const unit = "The quick brown fox jumps over the lazy dog. ";
  return `Cache-key ${randomUUID()}. Repeat this prefix silently and reply with the single word pong.\n${unit.repeat(250)}`;
}

export const CACHE_SECOND_CALL_ATTEMPTS = 3;

export function newPromptCacheKey(): string {
  return `ltl-js-2-${randomUUID()}`;
}

/** Normalized `cached_tokens` the proxy recorded on the call. */
export function recordedCachedTokens(record: CallRecord): number | undefined {
  const usage = asObject(record.usage);
  return (
    numberAt(usage, "cached_tokens") ??
    numberAt(objectAt(usage, "input_tokens_details"), "cached_tokens") ??
    numberAt(objectAt(usage, "prompt_tokens_details"), "cached_tokens")
  );
}

/**
 * Nested cached_tokens from the raw upstream JSON body
 * (`usage.input_tokens_details.cached_tokens`, falling back to Chat Completions
 * `usage.prompt_tokens_details.cached_tokens`).
 */
export function rawUpstreamCachedTokens(record: CallRecord): number | undefined {
  const usage = objectAt(asObject(decodeRawResponse(record)), "usage");
  return (
    numberAt(objectAt(usage, "input_tokens_details"), "cached_tokens") ??
    numberAt(objectAt(usage, "prompt_tokens_details"), "cached_tokens")
  );
}

/** Proxy recorded cached_tokens must equal the nested value in the raw upstream body. */
export function expectCachedTokensMatchRaw(record: CallRecord): void {
  const raw = rawUpstreamCachedTokens(record);
  expect(typeof raw).toBe("number");
  expect(Number.isFinite(raw)).toBe(true);
  expect(recordedCachedTokens(record)).toBe(raw);
}

export async function expectCachedTokensFaithful(
  lm: Session,
  index: number,
  query: { apiType?: "chat_completions" | "responses" } = {},
): Promise<void> {
  const record = (await lm.query({ ...query, index }).wait()).calls[0];
  expect(record).toBeDefined();
  expectCachedTokensMatchRaw(record!);
}

export function noteResponsesCacheMiss(): void {
  const message =
    "OpenAI Responses returned no cache hit after 3 attempts with a stable prompt_cache_key; proxy faithfulness is still asserted against usage.input_tokens_details.cached_tokens in the raw upstream body.";
  console.warn(message);
  console.log(`::notice::${message}`);
}

function decodeRawResponse(record: CallRecord): JsonValue | undefined {
  const encoded = stringAt(asObject(record.raw), "raw_response");
  if (!encoded) return undefined;
  const trimmed = encoded.trim();
  const candidates = [trimmed];
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("data:")) {
    try {
      candidates.push(Buffer.from(trimmed, "base64").toString("utf8"));
    } catch {
      // Keep the original payload.
    }
  }
  for (const candidate of candidates) {
    const text = candidate.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      // Try the next encoding.
    }
  }
  return undefined;
}

export function chatFunctionCall(
  message: OpenAI.Chat.ChatCompletionMessage | undefined,
): Extract<OpenAI.Chat.ChatCompletionMessageToolCall, { type: "function" }> | undefined {
  const call = message?.tool_calls?.[0];
  return call && call.type === "function" ? call : undefined;
}
