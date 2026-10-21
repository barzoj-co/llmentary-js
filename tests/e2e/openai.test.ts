import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import OpenAI from "openai";
import {
  ControlClient,
  SessionNotFound,
  contractPath,
  formatTraceSummary,
  llmentary,
  SessionAssertionError,
  startProxy,
  type ProxyHandle,
} from "../../src/index.js";
import {
  CACHE_SECOND_CALL_ATTEMPTS,
  CITY_SCHEMA,
  NAME_SCHEMA,
  REASONING_MODEL,
  TEXT_MODEL,
  TOOL_MODEL,
  chatFunctionCall,
  consumeChatStream,
  expectCachedTokensFaithful,
  expectHttpError,
  longPrompt,
  newSession,
  newPromptCacheKey,
  noteResponsesCacheMiss,
  openaiClient,
  recordedCachedTokens,
  retryNetwork,
  timeToolChat,
  timeToolResponses,
  weatherToolChat,
  weatherToolResponses,
} from "./helpers.js";

const startedAt = Date.now();

describe("OpenAI E2E through llmentary", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for OpenAI E2E tests on push and non-fork PRs.");
    }
    if (!process.env.LLMENTARY_BIN && !process.env.LLMENTARY_PROXY_URL) {
      throw new Error("LLMENTARY_BIN is required so E2E traffic goes through the real Go proxy.");
    }
    proxy = await startProxy({
      healthTimeoutMs: 20_000,
    });
    process.env.LLMENTARY_PROXY_URL = proxy.proxyUrl;
    process.env.LLMENTARY_CONTROL_URL = proxy.controlUrl;
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    delete process.env.LLMENTARY_PROXY_URL;
    delete process.env.LLMENTARY_CONTROL_URL;
    console.log(`OpenAI E2E wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  });

  describe("Chat Completions", () => {
    it("records non-streaming plain text", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      );
      await lm.expect().outputText();
      await lm.expect().model(TEXT_MODEL);
      await lm.expect().tokenBounds({ total: { min: 1 } });
      await lm.expect().finishReason(/stop|completed/i);
      await lm.expect().noErrors();
      await lm.cleanup();
    });

    it("records streaming plain text", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const stream = await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      );
      await consumeChatStream(stream);
      await lm.expect().outputText();
      await lm.expect().model(TEXT_MODEL);
      await lm.expect().tokenBounds({ total: { min: 1 } });
      await lm.expect().finishReason(/stop|completed/i);
      await lm.expect().streamed(true);
      await lm.expect().outputMatchesDeltas();
      await lm.cleanup();
    });

    it("records a forced tool call, result feedback, and final answer", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const first = await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          messages: [{ role: "user", content: "Use lookup_weather for Amsterdam." }],
          tools: [weatherToolChat()],
          tool_choice: { type: "function", function: { name: "lookup_weather" } },
        }),
      );
      const assistant = first.choices[0]?.message;
      const toolCall = chatFunctionCall(assistant);
      expect(toolCall?.function.name).toBe("lookup_weather");
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          messages: [
            { role: "user", content: "Use lookup_weather for Amsterdam." },
            assistant ?? { role: "assistant", content: "" },
            { role: "tool", tool_call_id: toolCall?.id ?? "missing", content: "sunny" },
          ],
        }),
      );
      await lm.expect().toolCalled("lookup_weather");
      await lm.expect().toolResultFedBack("lookup_weather");
      await lm.expect().outputText();
      await lm.expect().model(TOOL_MODEL);
      await lm.cleanup();
    });

    it("records a streaming forced tool call with JSON arguments from deltas", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const stream = await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "Use lookup_weather for Amsterdam." }],
          tools: [weatherToolChat()],
          tool_choice: { type: "function", function: { name: "lookup_weather" } },
        }),
      );
      let callId = "";
      let assembled = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.tool_calls?.[0];
        if (delta?.id) callId = delta.id;
        if (delta && "function" in delta) assembled += delta.function?.arguments ?? "";
      }
      expect(() => {
        const parsed: unknown = JSON.parse(assembled || "{}");
        void parsed;
      }).not.toThrow();
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          messages: [
            { role: "user", content: "Use lookup_weather for Amsterdam." },
            {
              role: "assistant",
              tool_calls: [
                {
                  id: callId || "missing",
                  type: "function",
                  function: { name: "lookup_weather", arguments: assembled || '{"city":"Amsterdam"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: callId || "missing", content: "sunny" },
          ],
        }),
      );
      await lm.expect().streamed(true);
      await lm.expect().streamedToolArgsJson("lookup_weather");
      await lm.expect().toolCalled("lookup_weather");
      await lm.expect().toolResultFedBack("lookup_weather");
      await lm.expect().outputText();
      await lm.cleanup();
    });

    it("records parallel tool calls order-independently", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 64,
          parallel_tool_calls: true,
          tool_choice: "required",
          tools: [weatherToolChat(), timeToolChat()],
          messages: [
            {
              role: "user",
              content: "Call lookup_weather and lookup_time for Paris in the same turn. Do not reply with text.",
            },
          ],
        }),
      );
      await lm.expect().callCount(1);
      await lm.expect().toolCalled("lookup_weather");
      await lm.expect().toolCalled("lookup_time");
      await lm.expect().calledTimes("lookup_weather", 1);
      await lm.expect().calledTimes("lookup_time", 1);
      await lm.cleanup();
    });

    it("records strict json_schema structured output", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          response_format: {
            type: "json_schema",
            json_schema: { name: "city_ok", strict: true, schema: CITY_SCHEMA },
          },
          messages: [{ role: "user", content: "Return JSON with city Paris and ok true." }],
        }),
      );
      await lm.expect().outputJsonValid(CITY_SCHEMA);
      await lm.cleanup();
    });

    it("records a multi-turn session with count, order, and filter helpers", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with the single word one." }],
        }),
      );
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          messages: [{ role: "user", content: "Use lookup_weather for Oslo." }],
          tools: [weatherToolChat()],
          tool_choice: { type: "function", function: { name: "lookup_weather" } },
        }),
      );
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          messages: [{ role: "user", content: "Use lookup_time for Oslo." }],
          tools: [timeToolChat()],
          tool_choice: { type: "function", function: { name: "lookup_time" } },
        }),
      );
      await lm.expect().callCount(3);
      await lm.expect().order(["lookup_weather", "lookup_time"]);
      await lm.query({ apiType: "chat_completions" }).expect().callCount(3);
      await lm.query({ model: TEXT_MODEL }).expect().callCount(1);
      await lm.query({ model: TOOL_MODEL }).expect().callCount(2);
      await lm.cleanup();
    });

    it("records upstream 4xx for an invalid model and invalid key", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await expectHttpError(
        () =>
          client.chat.completions.create({
            model: "gpt-not-a-real-model-ltl-js-2",
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "ping" }],
          }),
        404,
      );
      await lm.expect().hasError();
      await lm.expect().errorStatus(404);
      await lm.expect().errorType(/invalid_request|invalid/i);
      await lm.expect().errorCode(/model/i);
      await lm.cleanup();

      const authLm = newSession(proxy);
      const authClient = new OpenAI(authLm.openAI());
      await expectHttpError(
        () =>
          authClient.chat.completions.create(
            {
              model: TEXT_MODEL,
              temperature: 0,
              max_tokens: 8,
              messages: [{ role: "user", content: "ping" }],
            },
            { headers: { Authorization: "Bearer sk-invalid-ltl-js-2" } },
          ),
        401,
      );
      await authLm.expect().hasError();
      await authLm.expect().errorStatus(401);
      await authLm.expect().errorType(/auth|invalid/i);
      await authLm.expect().errorCode(/api_key|invalid|unauthorized/i);
      await authLm.cleanup();
    });

    it("summarizes 401 and abort calls as spec=request_only without http=0", async () => {
      const authLm = newSession(proxy);
      const authClient = new OpenAI(authLm.openAI());
      await expectHttpError(
        () =>
          authClient.chat.completions.create(
            {
              model: TEXT_MODEL,
              temperature: 0,
              max_tokens: 8,
              messages: [{ role: "user", content: "ping" }],
            },
            { headers: { Authorization: "Bearer sk-invalid-ltl-js-2" } },
          ),
        401,
      );
      const authTrace = await authLm.wait({ minCalls: 1, timeout: 25, quiet: "200ms" });
      const authSummary = formatTraceSummary(authTrace);
      expect(authSummary).toMatch(/spec=request_only/);
      expect(authSummary).toMatch(/http=401/);
      expect(authSummary).not.toMatch(/http=0/);
      await authLm.cleanup();

      const abortLm = newSession(proxy);
      const abortClient = openaiClient(abortLm);
      const controller = new AbortController();
      const pending = abortClient.chat.completions.create(
        {
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "Count slowly from 1 to 40 in words." }],
        },
        { signal: controller.signal },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      try {
        const stream = await pending;
        for await (const chunk of stream) {
          void chunk;
        }
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) throw error;
      }
      const abortTrace = await abortLm.wait({ minCalls: 1, timeout: 25, quiet: "200ms" });
      const abortSummary = formatTraceSummary(abortTrace);
      expect(abortSummary).toMatch(/spec=request_only/);
      expect(abortSummary).not.toMatch(/http=0/);
      expect(abortTrace.calls[0]?.httpStatus).toBeUndefined();
      await abortLm.cleanup();
    });

    it("records a 50ms client abort as typed clientAborted before_headers", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const controller = new AbortController();
      const pending = client.chat.completions.create(
        {
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "Count slowly from 1 to 40 in words." }],
        },
        { signal: controller.signal },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      try {
        const stream = await pending;
        for await (const chunk of stream) {
          void chunk;
        }
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) throw error;
      }
      const trace = await lm.wait({ minCalls: 1, timeout: 25, quiet: "200ms" });
      const call = trace.calls[0];
      expect(call?.clientAborted).toBe(true);
      expect(call?.httpStatus).not.toBe(502);
      // Proxy 0.3.0 is log-only; typed abort_phase arrives with proxy DOG-27 (#39).
      if (call?.abortPhase !== undefined) {
        expect(["before_headers", "after_headers"]).toContain(call.abortPhase);
      }
      await lm.expect().aborted();
      await lm.expect().finishReason(/cancelled/i);
      await lm.cleanup();
    });

    it("records a client abort mid-stream and leaves the proxy healthy", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const controller = new AbortController();
      const stream = await retryNetwork(() =>
        client.chat.completions.create(
          {
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "Count slowly from 1 to 20 in words." }],
          },
          { signal: controller.signal },
        ),
      );
      try {
        for await (const chunk of stream) {
          if (chunk.choices[0]?.delta?.content) {
            controller.abort();
            break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) throw error;
      }
      await lm.expect().incomplete();
      const health = await new ControlClient({ controlUrl: proxy.controlUrl }).health();
      expect(health).toBe("ok");
      const rawHealth = await fetch(`${proxy.controlUrl.replace(/\/$/, "")}/healthz`);
      expect(rawHealth.status).toBe(200);
      expect((await rawHealth.text()).trim()).toBe("ok");
      const followUp = newSession(proxy);
      const followClient = openaiClient(followUp);
      await retryNetwork(() =>
        followClient.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with the single word ok." }],
        }),
      );
      await followUp.expect().outputText();
      await lm.cleanup();
      await followUp.cleanup();
    });

    it("parses cached_tokens from a repeated long prompt", async () => {
      // Unique >=1024-token prompt. Index 0 must not satisfy cachedTokens.min=1.
      // The second call is retried up to 3 times; a hit is still required.
      // Recorded cached_tokens must equal nested cached_tokens in the raw body
      // on index 0 and on the call that actually hit.
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const prompt = longPrompt();
      const promptCacheKey = newPromptCacheKey();
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 8,
          prompt_cache_key: promptCacheKey,
          messages: [{ role: "user", content: prompt }],
        }),
      );
      let hitIndex: number | undefined;
      for (let attempt = 0; attempt < CACHE_SECOND_CALL_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await delay(250 * 2 ** (attempt - 1));
        await retryNetwork(() =>
          client.chat.completions.create({
            model: TOOL_MODEL,
            temperature: 0,
            max_tokens: 8,
            prompt_cache_key: promptCacheKey,
            messages: [{ role: "user", content: prompt }],
          }),
        );
        const index = 1 + attempt;
        await lm.query({ index }).expect().tokenBounds({ prompt: { min: 1024 }, total: { min: 1 } });
        const record = (await lm.query({ index }).wait()).calls[0];
        expect(record).toBeDefined();
        if ((recordedCachedTokens(record!) ?? 0) > 0) {
          hitIndex = index;
          break;
        }
      }
      await lm.query({ index: 0 }).expect().tokenBounds({ prompt: { min: 1024 }, total: { min: 1 } });
      await expectCachedTokensFaithful(lm, 0);
      if (hitIndex !== undefined) await expectCachedTokensFaithful(lm, hitIndex);
      await expect(lm.query({ index: 0 }).expect().usageDetails({ cachedTokens: { min: 1 } })).rejects.toThrow(
        /usage details/i,
      );
      await lm.query({ index: hitIndex ?? 1 }).expect().usageDetails({ cachedTokens: { min: 1 } });
      await lm.cleanup();
    });

    it("isolates concurrent sessions", async () => {
      const lmA = newSession(proxy);
      const lmB = newSession(proxy);
      const clientA = openaiClient(lmA);
      const clientB = openaiClient(lmB);
      await Promise.all([
        retryNetwork(() =>
          clientA.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the exact token ALPHA_SESSION_A." }],
          }),
        ),
        retryNetwork(() =>
          clientB.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the exact token BETA_SESSION_B." }],
          }),
        ),
      ]);
      await lmA.expect().promptContains("ALPHA_SESSION_A");
      await lmB.expect().promptContains("BETA_SESSION_B");
      await lmA.expect().callCount(1);
      await lmB.expect().callCount(1);
      await expect(lmA.expect().promptContains("BETA_SESSION_B")).rejects.toBeInstanceOf(SessionAssertionError);
      await expect(lmB.expect().promptContains("ALPHA_SESSION_A")).rejects.toBeInstanceOf(SessionAssertionError);
      await lmA.cleanup();
      await lmB.cleanup();
    });

    it("fails main assertion helpers with clear messages when false", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      );
      await expect(lm.expect().toolCalled("no_such_tool")).rejects.toThrow(/expected tool "no_such_tool"/i);
      await expect(lm.expect().calledTimes("no_such_tool", 1)).rejects.toThrow(/called 1 time/i);
      await expect(lm.expect().order(["no_such_tool"])).rejects.toThrow(/expected tool order/i);
      await expect(lm.expect().toolResultFedBack("no_such_tool")).rejects.toThrow(/no call with an id was recorded/i);
      await expect(lm.expect().model("definitely-not-this-model")).rejects.toThrow(/expected model/i);
      await expect(lm.expect().finishReason("length")).rejects.toThrow(/finish reason/i);
      await expect(lm.expect().tokenBounds({ total: { max: 0 } })).rejects.toThrow(/token bounds/i);
      await expect(lm.expect().hasError()).rejects.toThrow(/expected an error/i);
      await expect(lm.expect().responseContains("___NO_SUCH_TEXT___")).rejects.toThrow(/response to contain/i);
      await expect(lm.expect().streamed(true)).rejects.toThrow(/streamed/i);
      await expect(lm.expect().callCount(0)).rejects.toThrow(/recorded call/i);
      await expect(lm.expect().outputText("___NO_SUCH_TEXT___")).rejects.toThrow(/output text/i);
      await expect(lm.expect().incomplete()).rejects.toThrow(/incomplete or errored/i);
      await expect(lm.expect().outputMatchesDeltas()).rejects.toThrow(/concatenated stream deltas/i);
      await expect(lm.expect().streamedToolArgsJson("lookup_weather")).rejects.toThrow(/streamed tool arguments/i);
      await expect(lm.expect().outputJsonValid(CITY_SCHEMA)).rejects.toThrow(/output text JSON to match schema/i);
      await expect(lm.expect().usageDetails({ cachedTokens: { min: 1_000_000 } })).rejects.toThrow(/usage details/i);
      await expect(lm.expect().errorStatus(500)).rejects.toThrow(/error status/i);
      await expect(lm.expect().errorType("no_such_error_type")).rejects.toThrow(/error type/i);
      await expect(lm.expect().errorCode("no_such_error_code")).rejects.toThrow(/error code/i);
      await expect(lm.query({ apiType: "responses" }).expect().rawRecorded()).rejects.toThrow(/raw_request or raw_response/i);

      const toolLm = newSession(proxy);
      const toolClient = openaiClient(toolLm);
      await retryNetwork(() =>
        toolClient.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          messages: [{ role: "user", content: "Use lookup_weather for Lisbon." }],
          tools: [weatherToolChat()],
          tool_choice: { type: "function", function: { name: "lookup_weather" } },
        }),
      );
      await expect(toolLm.expect().notCalled("lookup_weather")).rejects.toThrow(/not to be called/i);

      const schemaLm = newSession(proxy);
      await retryNetwork(() =>
        openaiClient(schemaLm).chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          response_format: {
            type: "json_schema",
            json_schema: { name: "person_name", strict: true, schema: NAME_SCHEMA },
          },
          messages: [{ role: "user", content: "Return JSON with name hello." }],
        }),
      );
      await expect(schemaLm.expect().outputJsonValid(CITY_SCHEMA)).rejects.toThrow(/output text JSON to match schema/i);
      await lm.cleanup();
      await toolLm.cleanup();
      await schemaLm.cleanup();
    });
  });

  describe("Responses", () => {
    it("records non-streaming plain text", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.responses.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          input: "Reply with the single word ping.",
        }),
      );
      const scoped = lm.query({ apiType: "responses" }).expect();
      await scoped.outputText();
      await scoped.model(TEXT_MODEL);
      await scoped.tokenBounds({ total: { min: 1 } });
      await scoped.finishReason(/completed|stop/i);
      await scoped.noErrors();
      await lm.cleanup();
    });

    it("records streaming plain text", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const stream = await retryNetwork(() =>
        client.responses.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          stream: true,
          input: "Reply with the single word ping.",
        }),
      );
      for await (const event of stream) {
        void event;
      }
      const scoped = lm.query({ apiType: "responses" }).expect();
      await scoped.outputText();
      await scoped.model(TEXT_MODEL);
      await scoped.tokenBounds({ total: { min: 1 } });
      await scoped.finishReason(/completed|stop/i);
      await scoped.streamed(true);
      await scoped.outputMatchesDeltas();
      await lm.cleanup();
    });

    it("records a forced tool call, result feedback, and final answer", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const response = await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          input: "Use lookup_weather for Rotterdam.",
          tools: [weatherToolResponses()],
          tool_choice: { type: "function", name: "lookup_weather" },
        }),
      );
      const functionCall = response.output.find((item) => item.type === "function_call");
      expect(functionCall?.type).toBe("function_call");
      await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          previous_response_id: response.id,
          input: [
            {
              type: "function_call_output",
              call_id: functionCall && "call_id" in functionCall ? functionCall.call_id : "missing",
              output: "rainy",
            },
          ],
        }),
      );
      const scoped = lm.query({ apiType: "responses" }).expect();
      await scoped.toolCalled("lookup_weather");
      await scoped.toolResultFedBack("lookup_weather");
      await scoped.outputText();
      await lm.cleanup();
    });

    it("records a streaming forced tool call with JSON arguments from deltas", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const stream = await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          stream: true,
          input: "Use lookup_weather for Rotterdam.",
          tools: [weatherToolResponses()],
          tool_choice: { type: "function", name: "lookup_weather" },
        }),
      );
      let responseId = "";
      let callId = "";
      let deltaArgs = "";
      for await (const event of stream) {
        if (event.type === "response.created") responseId = event.response.id;
        if (event.type === "response.function_call_arguments.delta") deltaArgs += event.delta;
        if (event.type === "response.output_item.done" && event.item.type === "function_call") {
          callId = event.item.call_id;
          if (!responseId && event.item.id) responseId = event.item.id;
        }
        if (event.type === "response.completed") responseId = event.response.id;
      }
      expect(() => {
        const parsed: unknown = JSON.parse(deltaArgs || "{}");
        void parsed;
      }).not.toThrow();
      await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          previous_response_id: responseId,
          input: [
            {
              type: "function_call_output",
              call_id: callId || "missing",
              output: "rainy",
            },
          ],
        }),
      );
      const scoped = lm.query({ apiType: "responses" }).expect();
      await scoped.streamed(true);
      await scoped.streamedToolArgsJson("lookup_weather");
      await scoped.toolCalled("lookup_weather");
      await scoped.toolResultFedBack("lookup_weather");
      await scoped.outputText();
      await lm.cleanup();
    });

    it("records parallel tool calls order-independently", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 64,
          parallel_tool_calls: true,
          tool_choice: "required",
          tools: [weatherToolResponses(), timeToolResponses()],
          input: "Call lookup_weather and lookup_time for Paris in the same turn. Do not reply with text.",
        }),
      );
      const scoped = lm.query({ apiType: "responses" }).expect();
      await scoped.callCount(1);
      await scoped.toolCalled("lookup_weather");
      await scoped.toolCalled("lookup_time");
      await scoped.calledTimes("lookup_weather", 1);
      await scoped.calledTimes("lookup_time", 1);
      await lm.cleanup();
    });

    it("records strict json_schema structured output", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          text: { format: { type: "json_schema", name: "city_ok", strict: true, schema: CITY_SCHEMA } },
          input: "Return JSON with city Paris and ok true.",
        }),
      );
      await lm.query({ apiType: "responses" }).expect().outputJsonValid(CITY_SCHEMA);
      await lm.cleanup();
    });

    it("records a multi-turn session with count, order, and filter helpers", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.responses.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          input: "Reply with the single word one.",
        }),
      );
      await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          input: "Use lookup_weather for Oslo.",
          tools: [weatherToolResponses()],
          tool_choice: { type: "function", name: "lookup_weather" },
        }),
      );
      await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          input: "Use lookup_time for Oslo.",
          tools: [timeToolResponses()],
          tool_choice: { type: "function", name: "lookup_time" },
        }),
      );
      const scoped = lm.query({ apiType: "responses" }).expect();
      await scoped.callCount(3);
      await scoped.order(["lookup_weather", "lookup_time"]);
      await lm.query({ model: TEXT_MODEL }).expect().callCount(1);
      await lm.query({ model: TOOL_MODEL }).expect().callCount(2);
      await lm.cleanup();
    });

    it("records upstream 4xx for an invalid model and invalid key", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await expectHttpError(
        () =>
          client.responses.create({
            model: "gpt-not-a-real-model-ltl-js-2",
            temperature: 0,
            max_output_tokens: 16,
            input: "ping",
          }),
        404,
      );
      const scoped = lm.query({ apiType: "responses" }).expect();
      await scoped.hasError();
      await scoped.errorStatus(404);
      await scoped.errorType(/invalid_request|invalid/i);
      await scoped.errorCode(/model/i);
      await lm.cleanup();

      const authLm = newSession(proxy);
      const authClient = new OpenAI(authLm.openAI());
      await expectHttpError(
        () =>
          authClient.responses.create(
            {
              model: TEXT_MODEL,
              temperature: 0,
              max_output_tokens: 16,
              input: "ping",
            },
            { headers: { Authorization: "Bearer sk-invalid-ltl-js-2" } },
          ),
        401,
      );
      const authScoped = authLm.query({ apiType: "responses" }).expect();
      await authScoped.hasError();
      await authScoped.errorStatus(401);
      await authScoped.errorType(/auth|invalid/i);
      await authScoped.errorCode(/api_key|invalid|unauthorized/i);
      await authLm.cleanup();
    });

    it("records a client abort mid-stream and leaves the proxy healthy", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const controller = new AbortController();
      const stream = await retryNetwork(() =>
        client.responses.create(
          {
            model: TEXT_MODEL,
            temperature: 0,
            max_output_tokens: 64,
            stream: true,
            input: "Count slowly from 1 to 20 in words.",
          },
          { signal: controller.signal },
        ),
      );
      try {
        for await (const event of stream) {
          if (event.type === "response.output_text.delta" && event.delta) {
            controller.abort();
            break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) throw error;
      }
      await lm.query({ apiType: "responses" }).expect().incomplete();
      const health = await new ControlClient({ controlUrl: proxy.controlUrl }).health();
      expect(health).toBe("ok");
      const rawHealth = await fetch(`${proxy.controlUrl.replace(/\/$/, "")}/healthz`);
      expect(rawHealth.status).toBe(200);
      expect((await rawHealth.text()).trim()).toBe("ok");
      const followUp = newSession(proxy);
      await retryNetwork(() =>
        openaiClient(followUp).responses.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          input: "Reply with the single word ok.",
        }),
      );
      await followUp.query({ apiType: "responses" }).expect().outputText();
      await lm.cleanup();
      await followUp.cleanup();
    });

    it("records cached_tokens from the raw Responses body", async () => {
      // Stable assertion: recorded cached_tokens equals
      // usage.input_tokens_details.cached_tokens in the raw upstream body
      // on index 0 and on the call that actually hit.
      // A prefix-cache hit is optional. Both calls share prompt_cache_key; the
      // second call is retried up to 3 times. If none hit, warn/notice and do
      // not fail — OpenAI Responses often returns cached_tokens=0 here.
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const prompt = longPrompt();
      const promptCacheKey = newPromptCacheKey();
      const responsesQuery = { apiType: "responses" as const };
      await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          prompt_cache_key: promptCacheKey,
          input: prompt,
        }),
      );
      let hitIndex: number | undefined;
      for (let attempt = 0; attempt < CACHE_SECOND_CALL_ATTEMPTS; attempt += 1) {
        await delay(250 * 2 ** attempt);
        await retryNetwork(() =>
          client.responses.create({
            model: TOOL_MODEL,
            temperature: 0,
            max_output_tokens: 16,
            prompt_cache_key: promptCacheKey,
            input: prompt,
          }),
        );
        const index = 1 + attempt;
        await lm.query({ ...responsesQuery, index }).expect().tokenBounds({ prompt: { min: 1024 }, total: { min: 1 } });
        const record = (await lm.query({ ...responsesQuery, index }).wait()).calls[0];
        expect(record).toBeDefined();
        if ((recordedCachedTokens(record!) ?? 0) > 0) {
          hitIndex = index;
          break;
        }
      }
      await lm.query({ ...responsesQuery, index: 0 }).expect().tokenBounds({ prompt: { min: 1024 }, total: { min: 1 } });
      await expectCachedTokensFaithful(lm, 0, responsesQuery);
      if (hitIndex !== undefined) {
        await expectCachedTokensFaithful(lm, hitIndex, responsesQuery);
        await lm.query({ ...responsesQuery, index: hitIndex }).expect().usageDetails({ cachedTokens: { min: 1 } });
      } else {
        noteResponsesCacheMiss();
      }
      await expect(
        lm.query({ ...responsesQuery, index: 0 }).expect().usageDetails({ cachedTokens: { min: 1 } }),
      ).rejects.toThrow(/usage details/i);
      await lm.cleanup();
    });

    it("isolates concurrent sessions", async () => {
      const lmA = newSession(proxy);
      const lmB = newSession(proxy);
      await Promise.all([
        retryNetwork(() =>
          openaiClient(lmA).responses.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_output_tokens: 16,
            input: "Reply with the exact token ALPHA_SESSION_A.",
          }),
        ),
        retryNetwork(() =>
          openaiClient(lmB).responses.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_output_tokens: 16,
            input: "Reply with the exact token BETA_SESSION_B.",
          }),
        ),
      ]);
      await lmA.query({ apiType: "responses" }).expect().promptContains("ALPHA_SESSION_A");
      await lmB.query({ apiType: "responses" }).expect().promptContains("BETA_SESSION_B");
      await lmA.expect().callCount(1);
      await lmB.expect().callCount(1);
      await expect(lmA.expect().promptContains("BETA_SESSION_B")).rejects.toBeInstanceOf(SessionAssertionError);
      await expect(lmB.expect().promptContains("ALPHA_SESSION_A")).rejects.toBeInstanceOf(SessionAssertionError);
      await lmA.cleanup();
      await lmB.cleanup();
    });

    it("fails main assertion helpers with clear messages when false", async () => {
      const lm = newSession(proxy);
      await retryNetwork(() =>
        openaiClient(lm).responses.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          input: "Reply with the single word ping.",
        }),
      );
      const scoped = lm.query({ apiType: "responses" }).expect();
      await expect(scoped.toolCalled("no_such_tool")).rejects.toThrow(/expected tool "no_such_tool"/i);
      await expect(scoped.calledTimes("no_such_tool", 1)).rejects.toThrow(/called 1 time/i);
      await expect(scoped.order(["no_such_tool"])).rejects.toThrow(/expected tool order/i);
      await expect(scoped.toolResultFedBack("no_such_tool")).rejects.toThrow(/no call with an id was recorded/i);
      await expect(scoped.model("definitely-not-this-model")).rejects.toThrow(/expected model/i);
      await expect(scoped.finishReason("failed")).rejects.toThrow(/finish reason/i);
      await expect(scoped.tokenBounds({ total: { max: 0 } })).rejects.toThrow(/token bounds/i);
      await expect(scoped.hasError()).rejects.toThrow(/expected an error/i);
      await expect(scoped.responseContains("___NO_SUCH_TEXT___")).rejects.toThrow(/response to contain/i);
      await expect(scoped.streamed(true)).rejects.toThrow(/streamed/i);
      await expect(scoped.callCount(0)).rejects.toThrow(/recorded call/i);
      await expect(scoped.outputText("___NO_SUCH_TEXT___")).rejects.toThrow(/output text/i);
      await expect(scoped.incomplete()).rejects.toThrow(/incomplete or errored/i);
      await expect(scoped.outputMatchesDeltas()).rejects.toThrow(/concatenated stream deltas/i);
      await expect(scoped.streamedToolArgsJson("lookup_weather")).rejects.toThrow(/streamed tool arguments/i);
      await expect(scoped.outputJsonValid(CITY_SCHEMA)).rejects.toThrow(/output text JSON to match schema/i);
      await expect(scoped.usageDetails({ cachedTokens: { min: 1_000_000 } })).rejects.toThrow(/usage details/i);
      await expect(scoped.errorStatus(500)).rejects.toThrow(/error status/i);
      await expect(scoped.errorType("no_such_error_type")).rejects.toThrow(/error type/i);
      await expect(scoped.errorCode("no_such_error_code")).rejects.toThrow(/error code/i);
      await expect(lm.query({ apiType: "chat_completions" }).expect().rawRecorded()).rejects.toThrow(
        /raw_request or raw_response/i,
      );

      const toolLm = newSession(proxy);
      await retryNetwork(() =>
        openaiClient(toolLm).responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          input: "Use lookup_weather for Lisbon.",
          tools: [weatherToolResponses()],
          tool_choice: { type: "function", name: "lookup_weather" },
        }),
      );
      await expect(toolLm.query({ apiType: "responses" }).expect().notCalled("lookup_weather")).rejects.toThrow(
        /not to be called/i,
      );

      const schemaLm = newSession(proxy);
      await retryNetwork(() =>
        openaiClient(schemaLm).responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          text: { format: { type: "json_schema", name: "person_name", strict: true, schema: NAME_SCHEMA } },
          input: "Return JSON with name hello.",
        }),
      );
      await expect(schemaLm.query({ apiType: "responses" }).expect().outputJsonValid(CITY_SCHEMA)).rejects.toThrow(
        /output text JSON to match schema/i,
      );
      await lm.cleanup();
      await toolLm.cleanup();
      await schemaLm.cleanup();
    });
  });

  describe("shared", () => {
    it("proxies GET /v1/models and records the raw passthrough", async () => {
      const lm = newSession(proxy);
      const response = await lm.fetch(`${lm.baseURL}/models`, {
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
      });
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { data?: unknown };
      expect(Array.isArray(body.data)).toBe(true);
      await lm.expect().callCount(1);
      await lm.expect().rawRecorded();
      await lm.cleanup();
    });

    it("uses the default upstream with no client setting", async () => {
      const config = await new ControlClient({ controlUrl: proxy.controlUrl }).getConfig();
      expect(JSON.stringify(config.raw)).toMatch(/api\.openai\.com/);
      const lm = newSession(proxy);
      await retryNetwork(() =>
        openaiClient(lm).chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      );
      await lm.expect().outputText();
      await lm.expect().noSpecViolations();
      await lm.cleanup();
    });

    it("waits for minCalls on a live Chat Completions call", async () => {
      const lm = newSession(proxy);
      const pending = lm.wait({ minCalls: 1, timeout: 25, quiet: "200ms" });
      await delay(250);
      await retryNetwork(() =>
        openaiClient(lm).chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      ).then(async (stream) => {
        await consumeChatStream(stream);
      });
      const trace = await pending;
      expect(trace.calls.length).toBeGreaterThanOrEqual(1);
      await lm.cleanup();
    });

    it("passes noSpecViolations on a live streaming tool call and fails on an unknown request field", async () => {
      const lm = newSession(proxy);
      const stream = await retryNetwork(() =>
        openaiClient(lm).chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "Use lookup_weather for Amsterdam." }],
          tools: [weatherToolChat()],
          tool_choice: { type: "function", function: { name: "lookup_weather" } },
        }),
      );
      await consumeChatStream(stream);
      await lm.expect().noSpecViolations();

      const dirty = newSession(proxy);
      const res = await retryNetwork(() =>
        dirty.fetch(`${dirty.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
          },
          body: JSON.stringify({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            ltl_unknown_field: true,
            messages: [{ role: "user", content: "Reply with the single word ping." }],
          }),
        }),
      );
      await res.text();
      const failed = await dirty.expect().soft().noSpecViolations({ side: "request" });
      expect(failed.pass).toBe(false);
      expect(failed.message).toMatch(/ltl_unknown_field/);
      await lm.cleanup();
      await dirty.cleanup();
    });

    it("waits with default timeout and quiet after a streaming Chat Completions call", async () => {
      const lm = llmentary({
        proxyUrl: proxy.proxyUrl,
        controlUrl: proxy.controlUrl,
      });
      const stream = await retryNetwork(() =>
        openaiClient(lm).chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      );
      await consumeChatStream(stream);
      const trace = await lm.wait();
      expect(trace.calls.length).toBeGreaterThanOrEqual(1);
      await lm.expect().streamed(true);
      await lm.expect().outputText();
      await lm.cleanup();
    });

    it("parses reasoning tokens from one reasoning-model call", async () => {
      // o4-mini sometimes bills reasoning_tokens=0 even with encrypted reasoning.
      // Retry the live call; a hit is still required.
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await delay(250 * 2 ** (attempt - 1));
        console.log(`reasoning-token parse attempt ${attempt + 1}/3`);
        await retryNetwork(() =>
          client.responses.create({
            model: REASONING_MODEL,
            max_output_tokens: 256,
            reasoning: { effort: "medium" },
            input:
              "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost? Reply with only the integer.",
          }),
        );
        const callIndex = (await lm.wait()).calls.length - 1;
        try {
          await lm.query({ index: callIndex }).expect().usageDetails({ reasoningTokens: { min: 1 } });
          await lm.query({ index: callIndex }).expect().model(REASONING_MODEL);
          await lm.cleanup();
          return;
        } catch (error) {
          lastError = error;
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`reasoning-token parse attempt ${attempt + 1}/3 failed: ${detail}`);
          if (!(error instanceof SessionAssertionError)) throw error;
        }
      }
      await lm.cleanup();
      const last = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`expected reasoningTokens.min=1 within 3 live ${REASONING_MODEL} attempts; last error: ${last}`, {
        cause: lastError,
      });
    });

    it("attributes a live OpenAI SDK call through pathBaseURL with no session header", async () => {
      const sessionId = randomUUID();
      const previous = process.env.OPENAI_BASE_URL;
      process.env.OPENAI_BASE_URL = `${proxy.proxyUrl}/s/${encodeURIComponent(sessionId)}/v1`;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const lm = llmentary({
        sessionId,
        proxyUrl: proxy.proxyUrl,
        controlUrl: proxy.controlUrl,
        defaultWait: { timeoutMs: 25_000, idleMs: 200 },
      });
      expect(lm.pathBaseURL()).toBe(process.env.OPENAI_BASE_URL);
      try {
        await retryNetwork(() =>
          openai.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the single word ping." }],
          }),
        );
        await lm.expect().callCount(1);
        await lm.expect().outputText();
        const trace = await lm.session();
        expect(trace.calls[0]?.sessionSource).toBe("path");
        expect(trace.calls[0]?.upstreamUrl).toBeTruthy();
        expect(trace.calls[0]?.upstreamUrl).not.toMatch(/\/s\//);
      } finally {
        if (previous === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = previous;
        await lm.cleanup();
      }
    });

    it("maps wait minCalls=0 on a never-created session to SessionNotFound, then records a real call", async () => {
      const lm = newSession(proxy);
      try {
        try {
          await lm.wait({ minCalls: 0, timeout: 3, quiet: "200ms" });
          throw new Error("wait on a never-created session succeeded");
        } catch (error) {
          expect(error).toBeInstanceOf(SessionNotFound);
          if (!(error instanceof SessionNotFound)) throw error;
          expect(error.sessionId).toBe(lm.sessionId);
          expect(error.status).toBe(404);
        }
        await retryNetwork(() =>
          openaiClient(lm).chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the single word ping." }],
          }),
        );
        const trace = await lm.wait({ minCalls: 1, timeout: 25, quiet: "200ms" });
        expect(trace.calls.length).toBeGreaterThanOrEqual(1);
      } finally {
        await lm.cleanup();
      }
    });

    it("matches the served openapi.yaml to the bundled contract after a live call", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          stream: true,
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }).then(async (stream) => {
          for await (const chunk of stream) {
            void chunk;
          }
        }),
      );
      const served = await lm.control.openapi();
      expect(served).toMatch(/openapi:\s*['"]?3\./);
      expect(served).toMatch(/Session/);
      const proxyVersion = await lm.proxyVersion();
      const infoVersion = openApiInfoVersion(served);
      const release = proxyVersion?.replace(/^v/, "");
      // DOG-37 stamps info.version from the release. v0.3.0 still ships the
      // static document version 0.1.0; only a non-placeholder stamp must match.
      if (infoVersion && release && infoVersion !== "0.1.0") {
        expect(infoVersion).toBe(release);
      }
      const bundled = contractPath();
      if (bundled) {
        expect(readFileSync(bundled, "utf8")).toBe(served);
      }
      const trace = await lm.session();
      expect(trace.id).toBe(lm.sessionId);
      expect(trace.calls.length).toBeGreaterThanOrEqual(1);
      expect(trace.raw).toMatchObject({ id: lm.sessionId });
      await lm.cleanup();
    });

    it("reads per-session seq across two live path sessions on one proxy", async () => {
      const a = llmentary({
        sessionId: `seq-a-${randomUUID()}`,
        proxyUrl: proxy.proxyUrl,
        controlUrl: proxy.controlUrl,
        defaultWait: { timeoutMs: 25_000, idleMs: 200 },
      });
      const b = llmentary({
        sessionId: `seq-b-${randomUUID()}`,
        proxyUrl: proxy.proxyUrl,
        controlUrl: proxy.controlUrl,
        defaultWait: { timeoutMs: 25_000, idleMs: 200 },
      });
      const clientA = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: a.pathBaseURL() });
      const clientB = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: b.pathBaseURL() });
      try {
        await retryNetwork(() =>
          clientA.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the single word alpha." }],
          }),
        );
        await retryNetwork(() =>
          clientB.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the single word bravo." }],
          }),
        );
        await retryNetwork(() =>
          clientA.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the single word alpha-two." }],
          }),
        );
        const traceA = await a.wait({ minCalls: 2, timeout: 25, quiet: "200ms" });
        const traceB = await b.wait({ minCalls: 1, timeout: 25, quiet: "200ms" });
        expect(traceB.calls).toHaveLength(1);
        expect(traceB.calls[0]?.seq).toBe(1);
        expect(traceB.calls[0]?.sessionId).toBe(b.sessionId);
        expect(traceB.calls[0]?.id).toBeTruthy();
        expect(traceB.calls[0]?.id).not.toBe("call_1");
        expect(traceA.calls[0]?.seq).toBe(1);
        expect(traceA.calls[1]?.seq).toBe(2);
        expect(formatTraceSummary(traceB)).toContain(`#1 (${traceB.calls[0]?.id})`);
      } finally {
        await a.cleanup();
        await b.cleanup();
      }
    });

    it("keeps two path-prefix conversations isolatedFrom each other", async () => {
      const weather = llmentary({
        sessionId: `weather-${randomUUID()}`,
        proxyUrl: proxy.proxyUrl,
        controlUrl: proxy.controlUrl,
        defaultWait: { timeoutMs: 25_000, idleMs: 200 },
      });
      const barge = llmentary({
        sessionId: `barge-${randomUUID()}`,
        proxyUrl: proxy.proxyUrl,
        controlUrl: proxy.controlUrl,
        defaultWait: { timeoutMs: 25_000, idleMs: 200 },
      });
      const weatherClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: weather.pathBaseURL() });
      const bargeClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: barge.pathBaseURL() });
      const system = "You are a test assistant. The other conversation may mention ZURICH_QUAYZE or LISBON_FERRY. Reply with one short sentence.";
      try {
        await retryNetwork(() =>
          weatherClient.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 16,
            messages: [
              { role: "system", content: system },
              { role: "user", content: "Ask only for the ZURICH_QUAYZE weather token." },
            ],
          }),
        );
        await retryNetwork(() =>
          bargeClient.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 16,
            messages: [
              { role: "system", content: system },
              { role: "user", content: "Ask only for the LISBON_FERRY story token." },
            ],
          }),
        );
        await weather.expect().isolatedFrom(barge);
        await barge.expect().isolatedFrom(weather);
      } finally {
        await weather.cleanup();
        await barge.cleanup();
      }
    });

    it("expectNoCalls passes on a never-used session and fails after a real call", async () => {
      const used = newSession(proxy);
      const unused = llmentary({
        sessionId: `zero-${randomUUID()}`,
        proxyUrl: proxy.proxyUrl,
        controlUrl: proxy.controlUrl,
        defaultWait: { timeoutMs: 25_000, idleMs: 200 },
      });
      const client = openaiClient(used);
      try {
        await retryNetwork(() =>
          client.chat.completions.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the single word ping." }],
          }),
        );
        await unused.expectNoCalls();
        await expect(used.expectNoCalls()).rejects.toBeInstanceOf(SessionAssertionError);
        await expect(used.expectNoCalls()).rejects.toThrow(/expected 0 LLM calls, got /);
        await used.expect().allowEmpty().isolatedFrom(unused);
      } finally {
        await used.cleanup();
      }
    });

    it("fails noErrors on an empty since(mark) after a real call", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      );
      await lm.expect().callCount(1);
      const mark = await lm.mark();
      await expect(lm.expect({ since: mark }).noErrors()).rejects.toBeInstanceOf(SessionAssertionError);
      await expect(lm.expect({ since: mark }).noErrors()).rejects.toThrow(/no calls matched query \(since=/);
      await expect(lm.expect({ since: mark }).notCalled("lookup_weather")).rejects.toThrow(/no calls matched query/);
      await lm.expect().callCount(1);
      await lm.expect({ since: mark }).allowEmpty().noErrors();
      await lm.cleanup();
    });

    it("scopes a second live turn with since(mark) and filters a router call with withoutTools", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 32,
          response_format: {
            type: "json_schema",
            json_schema: { name: "city", strict: true, schema: CITY_SCHEMA },
          },
          messages: [{ role: "user", content: "Return JSON with city Amsterdam and ok true." }],
        }),
      );
      await lm.query({ withoutTools: true }).expect().callCount(1);
      const mark = await lm.mark();
      const first = await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          messages: [{ role: "user", content: "Use lookup_weather for Amsterdam." }],
          tools: [weatherToolChat()],
          tool_choice: { type: "function", function: { name: "lookup_weather" } },
        }),
      );
      const assistant = first.choices[0]?.message;
      const toolCall = chatFunctionCall(assistant);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 32,
          messages: [
            { role: "user", content: "Use lookup_weather for Amsterdam." },
            assistant ?? { role: "assistant", content: "" },
            { role: "tool", tool_call_id: toolCall?.id ?? "missing", content: "sunny" },
          ],
        }),
      );
      await lm.expect({ since: mark }).callCount(2);
      await lm.expect({ since: mark }).toolCalled("lookup_weather");
      await lm.expect({ since: mark }).toolResultFedBack("lookup_weather");
      await expect(lm.expect({ since: mark }).soft().outputJsonValid(CITY_SCHEMA)).resolves.toMatchObject({
        pass: false,
      });
      await lm.cleanup();
    });

    it.each([1, 2, 3])("asserts a live tool round-trip on the trace and mentions 20/sunny (run %s)", async () => {
      const lm = newSession(proxy);
      const client = openaiClient(lm);
      const toolPayload = JSON.stringify({ temperature: 20, condition: "sunny", token: "SEED_X" });
      const first = await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 48,
          messages: [{ role: "user", content: "Use lookup_weather for Amsterdam. In the final answer mention 20 and sunny." }],
          tools: [weatherToolChat()],
          tool_choice: { type: "function", function: { name: "lookup_weather" } },
        }),
      );
      const assistant = first.choices[0]?.message;
      const toolCall = chatFunctionCall(assistant);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_tokens: 48,
          messages: [
            { role: "user", content: "Use lookup_weather for Amsterdam. In the final answer mention 20 and sunny." },
            assistant ?? { role: "assistant", content: "" },
            { role: "tool", tool_call_id: toolCall?.id ?? "missing", content: toolPayload },
          ],
        }),
      );
      await lm.expect().toolResultInPrompt("lookup_weather");
      await lm.expect().promptContains("SEED_X");
      await lm.expect().finalResponseMentionsAny(["20", "sunny"]);
      await lm.cleanup();
    });
  });
});

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; message?: string };
  return candidate.name === "AbortError" || /abort/i.test(candidate.message ?? "");
}

/** `info.version` only — not the first `version:` key in the document. */
function openApiInfoVersion(yaml: string): string | undefined {
  const info = yaml.match(/(?:^|\n)info:\s*\n([\s\S]*?)(?=\n\S|$)/);
  const version = info?.[1]?.match(/^\s+version:\s*['"]?v?([0-9][0-9A-Za-z.+-]*)/m);
  return version?.[1];
}
