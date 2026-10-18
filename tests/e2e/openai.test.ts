import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { ControlClient, LabAssertionError, startProxy, type ProxyHandle } from "../../src/index.js";
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
  newLab,
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

describe("OpenAI E2E through llm-test-lab", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for OpenAI E2E tests on push and non-fork PRs.");
    }
    if (!process.env.LLMTESTLAB_BIN && !process.env.LLMTESTLAB_PROXY_URL) {
      throw new Error("LLMTESTLAB_BIN is required so E2E traffic goes through the real Go proxy.");
    }
    proxy = await startProxy({
      upstreamBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      healthTimeoutMs: 20_000,
    });
    process.env.LLMTESTLAB_PROXY_URL = proxy.proxyUrl;
    process.env.LLMTESTLAB_CONTROL_URL = proxy.controlUrl;
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    delete process.env.LLMTESTLAB_PROXY_URL;
    delete process.env.LLMTESTLAB_CONTROL_URL;
    console.log(`OpenAI E2E wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  });

  describe("Chat Completions", () => {
    it("records non-streaming plain text", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      );
      await lab.expect().outputText();
      await lab.expect().model(TEXT_MODEL);
      await lab.expect().tokenBounds({ total: { min: 1 } });
      await lab.expect().finishReason(/stop|completed/i);
      await lab.expect().noErrors();
      await lab.cleanup();
    });

    it("records streaming plain text", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.expect().outputText();
      await lab.expect().model(TEXT_MODEL);
      await lab.expect().tokenBounds({ total: { min: 1 } });
      await lab.expect().finishReason(/stop|completed/i);
      await lab.expect().streamed(true);
      await lab.expect().outputMatchesDeltas();
      await lab.cleanup();
    });

    it("records a forced tool call, result feedback, and final answer", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.expect().toolCalled("lookup_weather");
      await lab.expect().toolResultFedBack("lookup_weather");
      await lab.expect().outputText();
      await lab.expect().model(TOOL_MODEL);
      await lab.cleanup();
    });

    it("records a streaming forced tool call with JSON arguments from deltas", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.expect().streamed(true);
      await lab.expect().streamedToolArgsJson("lookup_weather");
      await lab.expect().toolCalled("lookup_weather");
      await lab.expect().toolResultFedBack("lookup_weather");
      await lab.expect().outputText();
      await lab.cleanup();
    });

    it("records parallel tool calls order-independently", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.expect().callCount(1);
      await lab.expect().toolCalled("lookup_weather");
      await lab.expect().toolCalled("lookup_time");
      await lab.expect().calledTimes("lookup_weather", 1);
      await lab.expect().calledTimes("lookup_time", 1);
      await lab.cleanup();
    });

    it("records strict json_schema structured output", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.expect().outputJsonValid(CITY_SCHEMA);
      await lab.cleanup();
    });

    it("records a multi-turn session with count, order, and filter helpers", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.expect().callCount(3);
      await lab.expect().order(["lookup_weather", "lookup_time"]);
      await lab.query({ apiType: "chat_completions" }).expect().callCount(3);
      await lab.query({ model: TEXT_MODEL }).expect().callCount(1);
      await lab.query({ model: TOOL_MODEL }).expect().callCount(2);
      await lab.cleanup();
    });

    it("records upstream 4xx for an invalid model and invalid key", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.expect().hasError();
      await lab.expect().errorStatus(404);
      await lab.expect().errorType(/invalid_request|invalid/i);
      await lab.expect().errorCode(/model/i);
      await lab.cleanup();

      const authLab = newLab(proxy);
      const authClient = new OpenAI(authLab.openAI());
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
      await authLab.expect().hasError();
      await authLab.expect().errorStatus(401);
      await authLab.expect().errorType(/auth|invalid/i);
      await authLab.expect().errorCode(/api_key|invalid|unauthorized/i);
      await authLab.cleanup();
    });

    it("records a client abort mid-stream and leaves the proxy healthy", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.expect().incomplete();
      const health = await new ControlClient({ controlUrl: proxy.controlUrl }).health();
      expect(health).toBe("ok");
      const rawHealth = await fetch(`${proxy.controlUrl.replace(/\/$/, "")}/healthz`);
      expect(rawHealth.status).toBe(200);
      expect((await rawHealth.text()).trim()).toBe("ok");
      const followUp = newLab(proxy);
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
      await lab.cleanup();
      await followUp.cleanup();
    });

    it("parses cached_tokens from a repeated long prompt", async () => {
      // Unique >=1024-token prompt. Index 0 must not satisfy cachedTokens.min=1.
      // The second call is retried up to 3 times; a hit is still required.
      // Recorded cached_tokens must equal nested cached_tokens in the raw body
      // on index 0 and on the call that actually hit.
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
        await lab.query({ index }).expect().tokenBounds({ prompt: { min: 1024 }, total: { min: 1 } });
        const record = (await lab.query({ index }).wait()).calls[0];
        expect(record).toBeDefined();
        if ((recordedCachedTokens(record!) ?? 0) > 0) {
          hitIndex = index;
          break;
        }
      }
      await lab.query({ index: 0 }).expect().tokenBounds({ prompt: { min: 1024 }, total: { min: 1 } });
      await expectCachedTokensFaithful(lab, 0);
      if (hitIndex !== undefined) await expectCachedTokensFaithful(lab, hitIndex);
      await expect(lab.query({ index: 0 }).expect().usageDetails({ cachedTokens: { min: 1 } })).rejects.toThrow(
        /usage details/i,
      );
      await lab.query({ index: hitIndex ?? 1 }).expect().usageDetails({ cachedTokens: { min: 1 } });
      await lab.cleanup();
    });

    it("isolates concurrent sessions", async () => {
      const labA = newLab(proxy);
      const labB = newLab(proxy);
      const clientA = openaiClient(labA);
      const clientB = openaiClient(labB);
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
      await labA.expect().promptContains("ALPHA_SESSION_A");
      await labB.expect().promptContains("BETA_SESSION_B");
      await labA.expect().callCount(1);
      await labB.expect().callCount(1);
      await expect(labA.expect().promptContains("BETA_SESSION_B")).rejects.toBeInstanceOf(LabAssertionError);
      await expect(labB.expect().promptContains("ALPHA_SESSION_A")).rejects.toBeInstanceOf(LabAssertionError);
      await labA.cleanup();
      await labB.cleanup();
    });

    it("fails main assertion helpers with clear messages when false", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
      await retryNetwork(() =>
        client.chat.completions.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with the single word ping." }],
        }),
      );
      await expect(lab.expect().toolCalled("no_such_tool")).rejects.toThrow(/expected tool "no_such_tool"/i);
      await expect(lab.expect().calledTimes("no_such_tool", 1)).rejects.toThrow(/called 1 time/i);
      await expect(lab.expect().order(["no_such_tool"])).rejects.toThrow(/expected tool order/i);
      await expect(lab.expect().toolResultFedBack("no_such_tool")).rejects.toThrow(/no call with an id was recorded/i);
      await expect(lab.expect().model("definitely-not-this-model")).rejects.toThrow(/expected model/i);
      await expect(lab.expect().finishReason("length")).rejects.toThrow(/finish reason/i);
      await expect(lab.expect().tokenBounds({ total: { max: 0 } })).rejects.toThrow(/token bounds/i);
      await expect(lab.expect().hasError()).rejects.toThrow(/expected an error/i);
      await expect(lab.expect().responseContains("___NO_SUCH_TEXT___")).rejects.toThrow(/response to contain/i);
      await expect(lab.expect().streamed(true)).rejects.toThrow(/streamed/i);
      await expect(lab.expect().callCount(0)).rejects.toThrow(/recorded call/i);
      await expect(lab.expect().outputText("___NO_SUCH_TEXT___")).rejects.toThrow(/output text/i);
      await expect(lab.expect().incomplete()).rejects.toThrow(/incomplete or errored/i);
      await expect(lab.expect().outputMatchesDeltas()).rejects.toThrow(/concatenated stream deltas/i);
      await expect(lab.expect().streamedToolArgsJson("lookup_weather")).rejects.toThrow(/streamed tool arguments/i);
      await expect(lab.expect().outputJsonValid(CITY_SCHEMA)).rejects.toThrow(/output text JSON to match schema/i);
      await expect(lab.expect().usageDetails({ cachedTokens: { min: 1_000_000 } })).rejects.toThrow(/usage details/i);
      await expect(lab.expect().errorStatus(500)).rejects.toThrow(/error status/i);
      await expect(lab.expect().errorType("no_such_error_type")).rejects.toThrow(/error type/i);
      await expect(lab.expect().errorCode("no_such_error_code")).rejects.toThrow(/error code/i);
      await expect(lab.query({ apiType: "responses" }).expect().rawRecorded()).rejects.toThrow(/raw_request or raw_response/i);

      const toolLab = newLab(proxy);
      const toolClient = openaiClient(toolLab);
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
      await expect(toolLab.expect().notCalled("lookup_weather")).rejects.toThrow(/not to be called/i);

      const schemaLab = newLab(proxy);
      await retryNetwork(() =>
        openaiClient(schemaLab).chat.completions.create({
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
      await expect(schemaLab.expect().outputJsonValid(CITY_SCHEMA)).rejects.toThrow(/output text JSON to match schema/i);
      await lab.cleanup();
      await toolLab.cleanup();
      await schemaLab.cleanup();
    });
  });

  describe("Responses", () => {
    it("records non-streaming plain text", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
      await retryNetwork(() =>
        client.responses.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          input: "Reply with the single word ping.",
        }),
      );
      const scoped = lab.query({ apiType: "responses" }).expect();
      await scoped.outputText();
      await scoped.model(TEXT_MODEL);
      await scoped.tokenBounds({ total: { min: 1 } });
      await scoped.finishReason(/completed|stop/i);
      await scoped.noErrors();
      await lab.cleanup();
    });

    it("records streaming plain text", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      const scoped = lab.query({ apiType: "responses" }).expect();
      await scoped.outputText();
      await scoped.model(TEXT_MODEL);
      await scoped.tokenBounds({ total: { min: 1 } });
      await scoped.finishReason(/completed|stop/i);
      await scoped.streamed(true);
      await scoped.outputMatchesDeltas();
      await lab.cleanup();
    });

    it("records a forced tool call, result feedback, and final answer", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      const scoped = lab.query({ apiType: "responses" }).expect();
      await scoped.toolCalled("lookup_weather");
      await scoped.toolResultFedBack("lookup_weather");
      await scoped.outputText();
      await lab.cleanup();
    });

    it("records a streaming forced tool call with JSON arguments from deltas", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      const scoped = lab.query({ apiType: "responses" }).expect();
      await scoped.streamed(true);
      await scoped.streamedToolArgsJson("lookup_weather");
      await scoped.toolCalled("lookup_weather");
      await scoped.toolResultFedBack("lookup_weather");
      await scoped.outputText();
      await lab.cleanup();
    });

    it("records parallel tool calls order-independently", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      const scoped = lab.query({ apiType: "responses" }).expect();
      await scoped.callCount(1);
      await scoped.toolCalled("lookup_weather");
      await scoped.toolCalled("lookup_time");
      await scoped.calledTimes("lookup_weather", 1);
      await scoped.calledTimes("lookup_time", 1);
      await lab.cleanup();
    });

    it("records strict json_schema structured output", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
      await retryNetwork(() =>
        client.responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          text: { format: { type: "json_schema", name: "city_ok", strict: true, schema: CITY_SCHEMA } },
          input: "Return JSON with city Paris and ok true.",
        }),
      );
      await lab.query({ apiType: "responses" }).expect().outputJsonValid(CITY_SCHEMA);
      await lab.cleanup();
    });

    it("records a multi-turn session with count, order, and filter helpers", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      const scoped = lab.query({ apiType: "responses" }).expect();
      await scoped.callCount(3);
      await scoped.order(["lookup_weather", "lookup_time"]);
      await lab.query({ model: TEXT_MODEL }).expect().callCount(1);
      await lab.query({ model: TOOL_MODEL }).expect().callCount(2);
      await lab.cleanup();
    });

    it("records upstream 4xx for an invalid model and invalid key", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      const scoped = lab.query({ apiType: "responses" }).expect();
      await scoped.hasError();
      await scoped.errorStatus(404);
      await scoped.errorType(/invalid_request|invalid/i);
      await scoped.errorCode(/model/i);
      await lab.cleanup();

      const authLab = newLab(proxy);
      const authClient = new OpenAI(authLab.openAI());
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
      const authScoped = authLab.query({ apiType: "responses" }).expect();
      await authScoped.hasError();
      await authScoped.errorStatus(401);
      await authScoped.errorType(/auth|invalid/i);
      await authScoped.errorCode(/api_key|invalid|unauthorized/i);
      await authLab.cleanup();
    });

    it("records a client abort mid-stream and leaves the proxy healthy", async () => {
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
      await lab.query({ apiType: "responses" }).expect().incomplete();
      const health = await new ControlClient({ controlUrl: proxy.controlUrl }).health();
      expect(health).toBe("ok");
      const rawHealth = await fetch(`${proxy.controlUrl.replace(/\/$/, "")}/healthz`);
      expect(rawHealth.status).toBe(200);
      expect((await rawHealth.text()).trim()).toBe("ok");
      const followUp = newLab(proxy);
      await retryNetwork(() =>
        openaiClient(followUp).responses.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          input: "Reply with the single word ok.",
        }),
      );
      await followUp.query({ apiType: "responses" }).expect().outputText();
      await lab.cleanup();
      await followUp.cleanup();
    });

    it("records cached_tokens from the raw Responses body", async () => {
      // Stable assertion: recorded cached_tokens equals
      // usage.input_tokens_details.cached_tokens in the raw upstream body
      // on index 0 and on the call that actually hit.
      // A prefix-cache hit is optional. Both calls share prompt_cache_key; the
      // second call is retried up to 3 times. If none hit, warn/notice and do
      // not fail — OpenAI Responses often returns cached_tokens=0 here.
      const lab = newLab(proxy);
      const client = openaiClient(lab);
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
        await lab.query({ ...responsesQuery, index }).expect().tokenBounds({ prompt: { min: 1024 }, total: { min: 1 } });
        const record = (await lab.query({ ...responsesQuery, index }).wait()).calls[0];
        expect(record).toBeDefined();
        if ((recordedCachedTokens(record!) ?? 0) > 0) {
          hitIndex = index;
          break;
        }
      }
      await lab.query({ ...responsesQuery, index: 0 }).expect().tokenBounds({ prompt: { min: 1024 }, total: { min: 1 } });
      await expectCachedTokensFaithful(lab, 0, responsesQuery);
      if (hitIndex !== undefined) {
        await expectCachedTokensFaithful(lab, hitIndex, responsesQuery);
        await lab.query({ ...responsesQuery, index: hitIndex }).expect().usageDetails({ cachedTokens: { min: 1 } });
      } else {
        noteResponsesCacheMiss();
      }
      await expect(
        lab.query({ ...responsesQuery, index: 0 }).expect().usageDetails({ cachedTokens: { min: 1 } }),
      ).rejects.toThrow(/usage details/i);
      await lab.cleanup();
    });

    it("isolates concurrent sessions", async () => {
      const labA = newLab(proxy);
      const labB = newLab(proxy);
      await Promise.all([
        retryNetwork(() =>
          openaiClient(labA).responses.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_output_tokens: 16,
            input: "Reply with the exact token ALPHA_SESSION_A.",
          }),
        ),
        retryNetwork(() =>
          openaiClient(labB).responses.create({
            model: TEXT_MODEL,
            temperature: 0,
            max_output_tokens: 16,
            input: "Reply with the exact token BETA_SESSION_B.",
          }),
        ),
      ]);
      await labA.query({ apiType: "responses" }).expect().promptContains("ALPHA_SESSION_A");
      await labB.query({ apiType: "responses" }).expect().promptContains("BETA_SESSION_B");
      await labA.expect().callCount(1);
      await labB.expect().callCount(1);
      await expect(labA.expect().promptContains("BETA_SESSION_B")).rejects.toBeInstanceOf(LabAssertionError);
      await expect(labB.expect().promptContains("ALPHA_SESSION_A")).rejects.toBeInstanceOf(LabAssertionError);
      await labA.cleanup();
      await labB.cleanup();
    });

    it("fails main assertion helpers with clear messages when false", async () => {
      const lab = newLab(proxy);
      await retryNetwork(() =>
        openaiClient(lab).responses.create({
          model: TEXT_MODEL,
          temperature: 0,
          max_output_tokens: 16,
          input: "Reply with the single word ping.",
        }),
      );
      const scoped = lab.query({ apiType: "responses" }).expect();
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
      await expect(lab.query({ apiType: "chat_completions" }).expect().rawRecorded()).rejects.toThrow(
        /raw_request or raw_response/i,
      );

      const toolLab = newLab(proxy);
      await retryNetwork(() =>
        openaiClient(toolLab).responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          input: "Use lookup_weather for Lisbon.",
          tools: [weatherToolResponses()],
          tool_choice: { type: "function", name: "lookup_weather" },
        }),
      );
      await expect(toolLab.query({ apiType: "responses" }).expect().notCalled("lookup_weather")).rejects.toThrow(
        /not to be called/i,
      );

      const schemaLab = newLab(proxy);
      await retryNetwork(() =>
        openaiClient(schemaLab).responses.create({
          model: TOOL_MODEL,
          temperature: 0,
          max_output_tokens: 32,
          text: { format: { type: "json_schema", name: "person_name", strict: true, schema: NAME_SCHEMA } },
          input: "Return JSON with name hello.",
        }),
      );
      await expect(schemaLab.query({ apiType: "responses" }).expect().outputJsonValid(CITY_SCHEMA)).rejects.toThrow(
        /output text JSON to match schema/i,
      );
      await lab.cleanup();
      await toolLab.cleanup();
      await schemaLab.cleanup();
    });
  });

  describe("shared", () => {
    it("proxies GET /v1/models and records the raw passthrough", async () => {
      const lab = newLab(proxy);
      const response = await lab.fetch(`${lab.baseURL}/models`, {
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
      });
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { data?: unknown };
      expect(Array.isArray(body.data)).toBe(true);
      await lab.expect().callCount(1);
      await lab.expect().rawRecorded();
      await lab.cleanup();
    });

    it("parses reasoning tokens from one reasoning-model call", async () => {
      const lab = newLab(proxy);
      await retryNetwork(() =>
        openaiClient(lab).responses.create({
          model: REASONING_MODEL,
          max_output_tokens: 256,
          reasoning: { effort: "medium" },
          input:
            "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost? Reply with only the integer.",
        }),
      );
      await lab.expect().model(REASONING_MODEL);
      await lab.expect().usageDetails({ reasoningTokens: { min: 1 } });
      await lab.cleanup();
    });
  });
});

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; message?: string };
  return candidate.name === "AbortError" || /abort/i.test(candidate.message ?? "");
}
