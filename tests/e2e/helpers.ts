import { setTimeout as delay } from "node:timers/promises";
import OpenAI, { APIError } from "openai";
import {
  LabAssertionError,
  createLab,
  type JsonObject,
  type LlmTestLab,
  type ProxyHandle,
} from "../../src/index.js";

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

export function newLab(proxy: ProxyHandle): LlmTestLab {
  return createLab({
    proxyUrl: proxy.proxyUrl,
    controlUrl: proxy.controlUrl,
    defaultWait: { timeoutMs: 25_000, idleMs: 200 },
  });
}

export function openaiClient(lab: LlmTestLab): OpenAI {
  return new OpenAI(lab.openAI());
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof LabAssertionError) return false;
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
    if (error instanceof LabAssertionError) throw error;
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

export function longPrompt(): string {
  return `Repeat this prefix silently and reply with the single word pong.\n${"The quick brown fox jumps over the lazy dog. ".repeat(120)}`;
}

export function chatFunctionCall(
  message: OpenAI.Chat.ChatCompletionMessage | undefined,
): Extract<OpenAI.Chat.ChatCompletionMessageToolCall, { type: "function" }> | undefined {
  const call = message?.tool_calls?.[0];
  return call && call.type === "function" ? call : undefined;
}
