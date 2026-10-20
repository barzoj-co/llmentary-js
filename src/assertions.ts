import { Ajv2020 } from "ajv/dist/2020.js";
import { ControlClient, SessionNotFound, formatZeroCallsMessage } from "./control.js";
import { mentionsAnyResult, type MentionsAnyOptions } from "./mentions.js";
import {
  asArray,
  asObject,
  attachSessionTraceHelpers,
  firstPositiveOrDefined,
  numberAt,
  objectAt,
  specStatusForRecord,
  stringAt,
  validationWasRun,
  valueAt,
} from "./normalize.js";
import type {
  AssertionResult,
  Bounds,
  CallRecord,
  IgnoredField,
  JsonObject,
  JsonSchemaAssertionOptions,
  JsonValue,
  NormalizedToolCall,
  QueryOptions,
  SessionTrace,
  SpecAssertionOptions,
  SpecViolation,
  TokenBounds,
  ToolCallAssertionOptions,
  UsageDetailsBounds,
  WaitOptions,
} from "./types.js";
import { WaitTimeoutError } from "./wait.js";

export class SessionAssertionError extends Error {
  readonly trace: SessionTrace;

  constructor(message: string, trace: SessionTrace) {
    super(`${message}\n\n${formatTraceSummary(trace)}`);
    this.name = "SessionAssertionError";
    this.trace = trace;
  }
}

export interface AssertionScopeOptions {
  control: ControlClient;
  sessionId: string;
  query?: QueryOptions;
  defaultWait?: WaitOptions;
  soft?: boolean;
}

export class AssertionScope {
  private readonly control: ControlClient;
  private readonly sessionId: string;
  private readonly query: QueryOptions;
  private readonly defaultWait: WaitOptions;
  private readonly softMode: boolean;
  private readonly collected: AssertionResult[] = [];
  private lastTrace: SessionTrace | undefined;

  constructor(options: AssertionScopeOptions) {
    this.control = options.control;
    this.sessionId = options.sessionId;
    this.query = options.query ?? {};
    this.defaultWait = options.defaultWait ?? {};
    this.softMode = options.soft ?? false;
  }

  soft(): AssertionScope {
    return new AssertionScope({
      control: this.control,
      sessionId: this.sessionId,
      query: this.query,
      defaultWait: this.defaultWait,
      soft: true,
    });
  }

  async toolCalled(name: string, options: ToolCallAssertionOptions = {}): Promise<AssertionResult> {
    return this.evaluate(`expected tool "${name}" to be called`, (trace) => {
      const calls = toolCallsForTrace(trace, this.query).filter((call) => call.name === name);
      const matching = filterByArgs(calls, options);
      return {
        pass: matching.length > 0,
        message:
          matching.length > 0
            ? `tool "${name}" was called`
            : `expected tool "${name}" to be called${argsDescription(options)}, but saw ${calls.length} matching-name call(s)`,
      };
    });
  }

  async notCalled(name: string): Promise<AssertionResult> {
    return this.evaluate(`expected tool "${name}" not to be called`, (trace) => {
      const calls = toolCallsForTrace(trace, this.query).filter((call) => call.name === name);
      return {
        pass: calls.length === 0,
        message:
          calls.length === 0
            ? `tool "${name}" was not called`
            : `expected tool "${name}" not to be called, but it was called ${calls.length} time(s)`,
      };
    });
  }

  async calledTimes(name: string, count: number, options: ToolCallAssertionOptions = {}): Promise<AssertionResult> {
    return this.evaluate(`expected tool "${name}" to be called ${count} time(s)`, (trace) => {
      const calls = filterByArgs(
        toolCallsForTrace(trace, this.query).filter((call) => call.name === name),
        options,
      );
      return {
        pass: calls.length === count,
        message: `expected tool "${name}" to be called ${count} time(s)${argsDescription(options)}, got ${calls.length}`,
      };
    });
  }

  async argsSubset(name: string, subset: JsonValue): Promise<AssertionResult> {
    return this.toolCalled(name, { argsSubset: subset });
  }

  async argsMatcher(
    name: string,
    matcher: (args: JsonValue, call: NormalizedToolCall, record: CallRecord) => boolean,
  ): Promise<AssertionResult> {
    return this.toolCalled(name, { argsMatcher: matcher });
  }

  async order(expectedToolNames: string[]): Promise<AssertionResult> {
    return this.evaluate(`expected tool order ${expectedToolNames.join(" -> ")}`, (trace) => {
      const actual = toolCallsForTrace(trace, this.query).map((call) => call.name);
      let position = 0;
      for (const name of actual) {
        if (name === expectedToolNames[position]) position += 1;
        if (position === expectedToolNames.length) break;
      }
      return {
        pass: position === expectedToolNames.length,
        message: `expected tool order ${expectedToolNames.join(" -> ")}, actual order ${actual.join(" -> ") || "<none>"}`,
      };
    });
  }

  async parallelToolCalls(expected = true): Promise<AssertionResult> {
    return this.requestParam("parallel_tool_calls", expected);
  }

  async toolResultFedBack(name?: string): Promise<AssertionResult> {
    return this.evaluate("expected tool result to be fed back", (trace) => {
      const records = recordsForTrace(trace, this.query);
      const toolCallIds = new Set(
        toolCallsForRecords(records)
          .filter((call) => (name ? call.name === name : true))
          .map((call) => call.id)
          .filter((id): id is string => Boolean(id)),
      );
      if (name && toolCallIds.size === 0) {
        return {
          pass: false,
          message: `expected a result for tool "${name}" to be sent back, but no call with an id was recorded`,
        };
      }
      const fedBack = records.some((record) => containsToolResult(record.request, toolCallIds));
      return {
        pass: fedBack,
        message: name
          ? `expected a result for tool "${name}" to be sent back to the model`
          : "expected at least one tool result to be sent back to the model",
      };
    });
  }

  async model(expected: string | RegExp): Promise<AssertionResult> {
    return this.evaluate(`expected model ${String(expected)}`, (trace) => {
      const records = recordsForTrace(trace, this.query);
      const models = records.flatMap((record) => {
        const requested = stringAt(asObject(record.request), "model");
        return [record.model, requested].filter((value): value is string => Boolean(value));
      });
      const pass = models.some((model) => matchesModel(model, expected));
      return { pass, message: `expected model ${String(expected)}, saw ${[...new Set(models)].join(", ") || "<none>"}` };
    });
  }

  async requestParam(path: string, expected: JsonValue | ((value: JsonValue | undefined) => boolean)): Promise<AssertionResult> {
    return this.evaluate(`expected request param ${path}`, (trace) => {
      const records = recordsForTrace(trace, this.query);
      const values = records.map((record) => getPath(record.request, path));
      const pass = values.some((value) => (typeof expected === "function" ? expected(value) : deepEqual(value, expected)));
      return { pass, message: `expected request param ${path} to match, saw ${values.map(stringify).join(", ")}` };
    });
  }

  async finishReason(expected: string | RegExp): Promise<AssertionResult> {
    return this.evaluate(`expected finish reason ${String(expected)}`, (trace) => {
      const reasons = recordsForTrace(trace, this.query).flatMap((record) => finishReasons(record.response));
      const pass = reasons.some((reason) => (expected instanceof RegExp ? expected.test(reason) : reason === expected));
      return { pass, message: `expected finish reason ${String(expected)}, saw ${reasons.join(", ") || "<none>"}` };
    });
  }

  async tokenBounds(bounds: TokenBounds): Promise<AssertionResult> {
    return this.evaluate("expected token usage bounds", (trace) => {
      const records = recordsForTrace(trace, this.query);
      const usages = records.map((record) => usageNumbers(record));
      const pass =
        records.length > 0 &&
        usages.every(
          (usage) =>
            usage !== undefined &&
          checkBounds(usage.prompt, bounds.prompt) &&
          checkBounds(usage.completion, bounds.completion) &&
            checkBounds(usage.total, bounds.total),
        );
      return { pass, message: `expected token bounds ${stringify(bounds)}, saw ${stringify(usages)}` };
    });
  }

  async latency(bounds: Bounds): Promise<AssertionResult> {
    return this.numericRecordBound("latencyMs", bounds);
  }

  async ttft(bounds: Bounds): Promise<AssertionResult> {
    return this.numericRecordBound("ttftMs", bounds);
  }

  async retries(bounds: Bounds): Promise<AssertionResult> {
    return this.numericRecordBound("retries", bounds);
  }

  async noRetries(): Promise<AssertionResult> {
    return this.retries({ max: 0 });
  }

  async noErrors(): Promise<AssertionResult> {
    return this.evaluate("expected no errors", (trace) => {
      const errors = recordsForTrace(trace, this.query).filter((record) => record.error !== undefined);
      return { pass: errors.length === 0, message: `expected no errors, saw ${errors.length}` };
    });
  }

  async hasError(pattern?: string | RegExp): Promise<AssertionResult> {
    return this.evaluate("expected an error", (trace) => {
      const errors = recordsForTrace(trace, this.query).map((record) => record.error).filter((value) => value !== undefined);
      const pass = pattern
        ? errors.some((error) => matchesText(extractText(error), pattern))
        : errors.length > 0;
      return { pass, message: `expected an error${pattern ? ` matching ${String(pattern)}` : ""}, saw ${stringify(errors)}` };
    });
  }

  async midStreamError(pattern?: string | RegExp): Promise<AssertionResult> {
    return this.evaluate("expected a mid-stream error", (trace) => {
      const errors = recordsForTrace(trace, this.query)
        .map((record) => record.error)
        .filter((error): error is JsonValue => error !== undefined && isMidStreamError(error));
      const pass = pattern
        ? errors.some((error) => matchesText(extractText(error), pattern))
        : errors.length > 0;
      return {
        pass,
        message: `expected a mid-stream error${pattern ? ` matching ${String(pattern)}` : ""}, saw ${stringify(errors)}`,
      };
    });
  }

  async promptContains(textOrPattern: string | RegExp): Promise<AssertionResult> {
    return this.textAssertion("prompt", textOrPattern, (record) => extractText(record.request));
  }

  async responseContains(textOrPattern: string | RegExp): Promise<AssertionResult> {
    return this.textAssertion("response", textOrPattern, (record) => extractText(record.response));
  }

  async responseJsonValid(options: JsonSchemaAssertionOptions): Promise<AssertionResult> {
    return this.evaluate("expected response JSON schema to be valid", (trace) => {
      const ajv = new Ajv2020({ strict: false });
      const validate = ajv.compile(options.schema);
      const values =
        options.data === "request"
          ? recordsForTrace(trace, this.query).map((record) => record.request)
          : options.data === "toolArguments"
            ? toolCallsForTrace(trace, this.query)
                .filter((call) => (options.toolName ? call.name === options.toolName : true))
                .map((call) => call.args)
            : recordsForTrace(trace, this.query).map((record) => record.response);
      const pass = values.some((value) => validate(value));
      return {
        pass,
        message: pass
          ? "response JSON matched schema"
          : `expected one payload to match schema; last errors: ${stringify(validate.errors ?? [])}`,
      };
    });
  }

  async responseJsonSchema(schema: JsonObject): Promise<AssertionResult> {
    return this.responseJsonValid({ schema });
  }

  async callCount(expected: number): Promise<AssertionResult> {
    return this.evaluate(`expected ${expected} recorded call(s)`, (trace) => {
      const records = recordsForTrace(trace, this.query);
      return {
        pass: records.length === expected,
        message: `expected ${expected} recorded call(s), got ${records.length}`,
      };
    });
  }

  async streamed(expected = true): Promise<AssertionResult> {
    return this.evaluate(`expected streamed=${expected}`, (trace) => {
      const records = recordsForTrace(trace, this.query);
      const flags = records.map((record) => record.streamed === true);
      const pass = expected ? flags.some(Boolean) : records.length > 0 && flags.every((flag) => !flag);
      return {
        pass,
        message: `expected streamed=${expected}, saw ${flags.map(String).join(", ") || "<none>"}`,
      };
    });
  }

  async outputText(expected?: string | RegExp): Promise<AssertionResult> {
    return this.evaluate("expected output text", (trace) => {
      const texts = recordsForTrace(trace, this.query).flatMap(outputTextsForRecord);
      const pass =
        expected === undefined ? texts.some((text) => text.trim().length > 0) : texts.some((text) => matchesText(text, expected));
      return {
        pass,
        message: `expected output text${expected ? ` matching ${String(expected)}` : " to be present"}, saw ${stringify(texts)}`,
      };
    });
  }

  async outputMatchesDeltas(): Promise<AssertionResult> {
    return this.evaluate("expected output text to equal concatenated stream deltas", (trace) => {
      const comparisons = recordsForTrace(trace, this.query).map((record) => {
        const output = outputTextsForRecord(record)[0] ?? "";
        const deltas = concatenatedDeltasForRecord(record);
        return { output, deltas, equal: output.length > 0 && output === deltas };
      });
      const pass = comparisons.some((comparison) => comparison.equal);
      return {
        pass,
        message: `expected output text to equal concatenated stream deltas, saw ${stringify(comparisons)}`,
      };
    });
  }

  async streamedToolArgsJson(name?: string): Promise<AssertionResult> {
    return this.evaluate("expected streamed tool arguments to be valid JSON", (trace) => {
      const parsed: JsonValue[] = [];
      const errors: string[] = [];
      for (const record of recordsForTrace(trace, this.query)) {
        const entries = assembledToolArgDeltas(record);
        const candidates =
          entries.length > 0
            ? entries
            : toolCallsForRecords([record])
                .filter((call) => (name ? call.name === name : true))
                .map((call) => [call.name, typeof call.args === "string" ? call.args : JSON.stringify(call.args)] as const);
        for (const [toolName, args] of candidates) {
          if (name && toolName !== name) continue;
          try {
            parsed.push(JSON.parse(args) as JsonValue);
          } catch (error) {
            errors.push(`${toolName}: ${args} (${error instanceof Error ? error.message : String(error)})`);
          }
        }
      }
      const pass = parsed.length > 0 && errors.length === 0;
      return {
        pass,
        message: pass
          ? "streamed tool arguments were valid JSON"
          : `expected streamed tool arguments to be valid JSON, parsed=${parsed.length} errors=${errors.join("; ") || "<none>"}`,
      };
    });
  }

  async outputJsonValid(schema: JsonObject): Promise<AssertionResult> {
    return this.evaluate("expected output JSON to match schema", (trace) => {
      const ajv = new Ajv2020({ strict: false });
      const validate = ajv.compile(schema);
      const texts = recordsForTrace(trace, this.query).flatMap(outputTextsForRecord);
      const values: JsonValue[] = [];
      for (const text of texts) {
        try {
          values.push(JSON.parse(text) as JsonValue);
        } catch {
          // Keep looking at other payloads.
        }
      }
      const pass = values.some((value) => validate(value));
      return {
        pass,
        message: pass
          ? "output JSON matched schema"
          : `expected output text JSON to match schema; last errors: ${stringify(validate.errors ?? [])}; texts=${stringify(texts)}`,
      };
    });
  }

  async usageDetails(bounds: UsageDetailsBounds): Promise<AssertionResult> {
    return this.evaluate("expected usage details", (trace) => {
      const details = recordsForTrace(trace, this.query).map(usageDetailsForRecord);
      const pass = details.some(
        (detail) =>
          checkBounds(detail.cachedTokens, bounds.cachedTokens) &&
          checkBounds(detail.reasoningTokens, bounds.reasoningTokens),
      );
      return { pass, message: `expected usage details ${stringify(bounds)}, saw ${stringify(details)}` };
    });
  }

  async errorStatus(expected: number | Bounds): Promise<AssertionResult> {
    return this.evaluate(`expected error status ${stringify(expected)}`, (trace) => {
      const statuses = recordsForTrace(trace, this.query)
        .map((record) => record.httpStatus ?? httpStatusFromError(record.error) ?? httpStatusFromError(record.response))
        .filter((status): status is number => status !== undefined);
      const pass = statuses.some((status) =>
        typeof expected === "number" ? status === expected : checkBounds(status, expected),
      );
      return {
        pass,
        message: `expected error status ${stringify(expected)}, saw ${statuses.join(", ") || "<none>"}`,
      };
    });
  }

  async errorType(expected: string | RegExp): Promise<AssertionResult> {
    return this.evaluate(`expected error type ${String(expected)}`, (trace) => {
      const types = recordsForTrace(trace, this.query).flatMap((record) => errorFields(record, "type"));
      const pass = types.some((type) => matchesText(type, expected));
      return { pass, message: `expected error type ${String(expected)}, saw ${types.join(", ") || "<none>"}` };
    });
  }

  async errorCode(expected: string | RegExp): Promise<AssertionResult> {
    return this.evaluate(`expected error code ${String(expected)}`, (trace) => {
      const codes = recordsForTrace(trace, this.query).flatMap((record) => errorFields(record, "code"));
      const pass = codes.some((code) => matchesText(code, expected));
      return { pass, message: `expected error code ${String(expected)}, saw ${codes.join(", ") || "<none>"}` };
    });
  }

  async incomplete(): Promise<AssertionResult> {
    return this.evaluate("expected an incomplete or errored trace", (trace) => {
      const records = recordsForTrace(trace, this.query);
      const pass = records.some((record) => isIncompleteRecord(record));
      return {
        pass,
        message: pass
          ? "trace is incomplete or errored"
          : `expected an incomplete or errored trace, saw ${records
              .map((record) => stringify({ error: record.error, finish: finishReasons(record.response), streamed: record.streamed }))
              .join("; ") || "<none>"}`,
      };
    });
  }

  async rawRecorded(): Promise<AssertionResult> {
    return this.evaluate("expected raw request/response to be recorded", (trace) => {
      const records = recordsForTrace(trace, this.query);
      const pass = records.some((record) => hasRawPayload(record));
      return {
        pass,
        message: pass
          ? "raw request/response was recorded"
          : "expected raw_request or raw_response to be recorded on the trace",
      };
    });
  }

  async noSpecViolations(options: SpecAssertionOptions = {}): Promise<AssertionResult> {
    return this.evaluate("expected no spec violations", (trace) => evaluateSpecFindings(trace, this.query, options, "violations"));
  }

  async noIgnoredFields(options: SpecAssertionOptions = {}): Promise<AssertionResult> {
    return this.evaluate("expected no ignored fields", (trace) => evaluateSpecFindings(trace, this.query, options, "ignored"));
  }

  async finalResponseMentionsAny(
    candidates: readonly string[],
    options: MentionsAnyOptions = {},
  ): Promise<AssertionResult> {
    return this.evaluate("expected the final response to mention any candidate", (trace) => {
      const records = recordsForTrace(trace, this.query);
      const last = records[records.length - 1];
      const text = last ? last.responseText || outputTextsForRecord(last).join("\n") || extractText(last.response) : "";
      return mentionsAnyResult(text, candidates, options);
    });
  }

  async toolResultInPrompt(name?: string): Promise<AssertionResult> {
    return this.evaluate("expected tool result in the next prompt", (trace) => {
      const records = recordsForTrace(trace, this.query);
      let sawCall = false;
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record) continue;
        const called = toolCallsForRecords([record]).filter((call) => (name ? call.name === name : true));
        if (called.length === 0) continue;
        sawCall = true;
        const ids = new Set(called.map((call) => call.id).filter((id): id is string => Boolean(id)));
        for (const later of records.slice(index + 1)) {
          const contents = toolResultContents(later.request, ids);
          const prompt = later.promptText || extractText(later.request);
          if (contents.some((content) => content.length > 0 && prompt.includes(content))) {
            return {
              pass: true,
              message: name
                ? `tool "${name}" result was present in a later prompt`
                : "tool result was present in a later prompt",
            };
          }
        }
      }
      return {
        pass: false,
        message: name
          ? sawCall
            ? `expected the next request after tool "${name}" to carry that tool's result content`
            : `expected a result for tool "${name}" in a later prompt, but no call was recorded`
          : "expected a later request to carry a tool result verbatim",
      };
    });
  }

  check(): Promise<AssertionResult> {
    const failures = this.collected.filter((result) => !result.pass);
    const trace = this.lastTrace ?? emptyTrace(this.sessionId);
    if (failures.length === 0) {
      return Promise.resolve({ pass: true, message: "all soft assertions passed", trace });
    }
    const message = failures.map((result) => result.message).join("\n");
    return Promise.reject(new SessionAssertionError(message, trace));
  }

  private async numericRecordBound(field: "latencyMs" | "ttftMs" | "retries", bounds: Bounds): Promise<AssertionResult> {
    return this.evaluate(`expected ${field} bounds`, (trace) => {
      const records = recordsForTrace(trace, this.query);
      const values = records.map((record) => record[field] ?? (field === "retries" ? 0 : undefined));
      const pass = records.length > 0 && values.every((value) => checkBounds(value, bounds));
      return { pass, message: `expected ${field} within ${stringify(bounds)}, saw ${values.join(", ") || "<none>"}` };
    });
  }

  private async textAssertion(
    label: string,
    pattern: string | RegExp,
    getText: (record: CallRecord) => string,
  ): Promise<AssertionResult> {
    return this.evaluate(`expected ${label} to contain ${String(pattern)}`, (trace) => {
      const texts = recordsForTrace(trace, this.query).map(getText);
      const pass = texts.some((text) => matchesText(text, pattern));
      return { pass, message: `expected ${label} to contain ${String(pattern)}, saw ${texts.join("\n---\n") || "<none>"}` };
    });
  }

  private async evaluate(
    defaultMessage: string,
    predicate: (trace: SessionTrace) => { pass: boolean; message?: string } | Promise<{ pass: boolean; message?: string }>,
  ): Promise<AssertionResult> {
    let trace: SessionTrace;
    try {
      trace = await this.control.wait(this.sessionId, this.defaultWait);
    } catch (error) {
      if (error instanceof SessionNotFound || (error instanceof WaitTimeoutError && error.calls === 0)) {
        return this.failZeroCalls(emptyTrace(this.sessionId), defaultMessage);
      }
      throw error;
    }
    const result = await predicate(trace);
    const message = result.message ?? defaultMessage;
    if (result.pass) return this.finish({ pass: true, message, trace });
    if (trace.calls.length === 0) {
      return this.failZeroCalls(trace, message);
    }
    const error = new SessionAssertionError(message, trace);
    if (this.softMode) return this.finish({ pass: false, message, trace, error });
    throw error;
  }

  private async failZeroCalls(trace: SessionTrace, fallback: string): Promise<AssertionResult> {
    const known = await this.knownSessionIds();
    const message = `${formatZeroCallsMessage(this.sessionId, known)}${fallback ? `\n${fallback}` : ""}`;
    const error = new SessionAssertionError(message, trace);
    if (this.softMode) return this.finish({ pass: false, message, trace, error });
    throw error;
  }

  private finish(result: AssertionResult): AssertionResult {
    this.lastTrace = result.trace;
    if (this.softMode) this.collected.push(result);
    return result;
  }

  private async knownSessionIds(): Promise<string[]> {
    if (typeof this.control.listSessions !== "function") return [];
    try {
      return (await this.control.listSessions()).map((session) => session.id);
    } catch {
      return [];
    }
  }
}

export function recordsForTrace(trace: SessionTrace, query: QueryOptions = {}): CallRecord[] {
  const records = trace.calls.filter((record, index) => {
    if (query.since !== undefined && index < query.since) return false;
    if (query.apiType && record.apiType !== query.apiType) return false;
    if (query.model) {
      const requested = stringAt(asObject(record.request), "model");
      if (!matchesModel(record.model, query.model) && !matchesModel(requested, query.model)) return false;
    }
    const offered = offeredToolNames(record);
    if (query.offersTool && !offered.includes(query.offersTool)) return false;
    if (query.withoutTools && offered.length > 0) return false;
    return true;
  });
  if (query.index === undefined) return records;
  const record = records[query.index];
  return record ? [record] : [];
}

export function offeredToolNames(record: CallRecord): string[] {
  const request = asObject(record.request);
  const names: string[] = [];
  const add = (value: JsonValue | undefined): void => {
    const object = asObject(value);
    const name = stringAt(objectAt(object, "function"), "name") ?? stringAt(object, "name");
    if (name) names.push(name);
  };
  for (const tool of asArray(valueAt(request, "tools"))) add(tool);
  for (const fn of asArray(valueAt(request, "functions"))) add(fn);
  return [...new Set(names)];
}

const MODEL_SNAPSHOT_SUFFIX = /^(.+)-\d{4}-\d{2}-\d{2}$/;

/** Aliases match dated snapshots (`gpt-4.1-mini` vs `gpt-4.1-mini-2025-04-14`). */
export function matchesModel(actual: string | undefined, expected: string | RegExp): boolean {
  if (!actual) return false;
  if (expected instanceof RegExp) return expected.test(actual);
  if (actual === expected) return true;
  const actualAlias = actual.match(MODEL_SNAPSHOT_SUFFIX)?.[1];
  const expectedAlias = expected.match(MODEL_SNAPSHOT_SUFFIX)?.[1];
  return actualAlias === expected || expectedAlias === actual;
}

export function toolCallsForTrace(trace: SessionTrace, query: QueryOptions = {}): NormalizedToolCall[] {
  return toolCallsForRecords(recordsForTrace(trace, query));
}

type ToolCallWithoutIndex = Omit<NormalizedToolCall, "index">;

function toolCallsForRecords(records: CallRecord[]): NormalizedToolCall[] {
  const out: ToolCallWithoutIndex[] = [];
  for (const record of records) {
    out.push(...toolCallsForPayload(record.response, record));
    out.push(...toolCallsForPayload(record.request, record));
  }
  return out.map((call, index) => ({ ...call, index }));
}

function toolCallsForPayload(payload: JsonValue | undefined, record: CallRecord): ToolCallWithoutIndex[] {
  const out: ToolCallWithoutIndex[] = [];
  const visit = (value: JsonValue | undefined): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const object = asObject(value);
    const directCalls = asArray(valueAt(object, "tool_calls") ?? valueAt(object, "toolCalls"));
    for (const rawCall of directCalls) {
      const call = normalizeToolCall(rawCall, record);
      if (call) out.push(call);
    }
    const choices = asArray(valueAt(object, "choices"));
    for (const choice of choices) visit(valueAt(asObject(choice), "message") ?? valueAt(asObject(choice), "delta"));
    const output = asArray(valueAt(object, "output"));
    for (const item of output) {
      const itemObject = asObject(item);
      if (stringAt(itemObject, "type") === "function_call") {
        const call = normalizeResponsesFunctionCall(item, record);
        if (call) out.push(call);
      }
      visit(valueAt(itemObject, "content"));
    }
  };
  visit(payload);
  return out;
}

function normalizeToolCall(raw: JsonValue, record: CallRecord): ToolCallWithoutIndex | undefined {
  const object = asObject(raw);
  const fn = objectAt(object, "function") ?? object;
  const name = stringAt(fn, "name") ?? stringAt(object, "name");
  if (!name) return undefined;
  const argsRaw = valueAt(fn, "arguments") ?? valueAt(object, "arguments") ?? valueAt(object, "args") ?? {};
  const id = stringAt(object, "id");
  return {
    ...(id ? { id } : {}),
    name,
    args: parseMaybeJson(argsRaw),
    raw,
    record,
  };
}

function normalizeResponsesFunctionCall(raw: JsonValue, record: CallRecord): ToolCallWithoutIndex | undefined {
  const object = asObject(raw);
  const name = stringAt(object, "name");
  if (!name) return undefined;
  const id = stringAt(object, "call_id") ?? stringAt(object, "id");
  return {
    ...(id ? { id } : {}),
    name,
    args: parseMaybeJson(valueAt(object, "arguments") ?? {}),
    raw,
    record,
  };
}

function filterByArgs(calls: NormalizedToolCall[], options: ToolCallAssertionOptions): NormalizedToolCall[] {
  return calls.filter((call) => {
    if (options.argsSubset !== undefined && !deepContains(call.args, options.argsSubset)) return false;
    if (options.argsMatcher && !options.argsMatcher(call.args, call, call.record)) return false;
    return true;
  });
}

function argsDescription(options: ToolCallAssertionOptions): string {
  if (options.argsSubset !== undefined) return ` with args containing ${stringify(options.argsSubset)}`;
  if (options.argsMatcher) return " with args matching predicate";
  return "";
}

function containsToolResult(value: JsonValue | undefined, toolCallIds: Set<string>): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => containsToolResult(item, toolCallIds));
  if (typeof value !== "object") return false;
  const object = asObject(value);
  const role = stringAt(object, "role");
  const type = stringAt(object, "type");
  const toolCallId = stringAt(object, "tool_call_id") ?? stringAt(object, "toolCallId") ?? stringAt(object, "call_id");
  if ((role === "tool" || type === "function_call_output") && (!toolCallIds.size || (toolCallId && toolCallIds.has(toolCallId)))) {
    return true;
  }
  return Object.values(object).some((child) => containsToolResult(child, toolCallIds));
}

function isMidStreamError(error: JsonValue): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const object = asObject(error);
  return valueAt(object, "mid_stream") === true || valueAt(object, "midStream") === true;
}

function finishReasons(value: JsonValue | undefined): string[] {
  const reasons: string[] = [];
  const visit = (candidate: JsonValue | undefined): void => {
    if (candidate === undefined || candidate === null) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== "object") return;
    const object = asObject(candidate);
    const reason = stringAt(object, "finish_reason") ?? stringAt(object, "finishReason") ?? stringAt(object, "status");
    if (reason) reasons.push(reason);
    for (const value of Object.values(object)) visit(value);
  };
  visit(value);
  return [...new Set(reasons)];
}

function usageNumbers(record: CallRecord): { prompt?: number; completion?: number; total?: number } | undefined {
  const usage = record.usage ?? objectAt(asObject(record.response), "usage");
  if (!usage) return undefined;
  const prompt = numberAt(usage, "prompt_tokens") ?? numberAt(usage, "input_tokens") ?? numberAt(usage, "promptTokens");
  const completion =
    numberAt(usage, "completion_tokens") ?? numberAt(usage, "output_tokens") ?? numberAt(usage, "completionTokens");
  const total = numberAt(usage, "total_tokens") ?? numberAt(usage, "totalTokens");
  return {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(completion !== undefined ? { completion } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

function checkBounds(value: number | undefined, bounds: Bounds | undefined): boolean {
  if (!bounds) return true;
  if (value === undefined) return false;
  if (bounds.min !== undefined && value < bounds.min) return false;
  if (bounds.max !== undefined && value > bounds.max) return false;
  return true;
}

function getPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  const parts = path.split(".");
  let current = value;
  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = valueAt(asObject(current), part);
  }
  return current;
}

function parseMaybeJson(value: JsonValue): JsonValue {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function deepContains(actual: JsonValue | undefined, subset: JsonValue): boolean {
  if (deepEqual(actual, subset)) return true;
  if (Array.isArray(subset)) {
    if (!Array.isArray(actual)) return false;
    return subset.every((subsetItem) => actual.some((actualItem) => deepContains(actualItem, subsetItem)));
  }
  if (subset && typeof subset === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const actualObject = asObject(actual);
    return Object.entries(asObject(subset)).every(([key, value]) => deepContains(actualObject[key], value));
  }
  return false;
}

function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function extractText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  return Object.values(value).map(extractText).filter(Boolean).join("\n");
}

function matchesText(text: string, pattern: string | RegExp): boolean {
  return pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
}

function outputTextsForRecord(record: CallRecord): string[] {
  const texts: string[] = [];
  const add = (value: string | undefined): void => {
    if (value && value.trim()) texts.push(value);
  };
  const response = record.response;
  if (typeof response === "string") add(response);
  const object = asObject(response);
  add(stringAt(object, "output_text"));
  for (const choice of asArray(valueAt(object, "choices"))) {
    const message = objectAt(asObject(choice), "message");
    const content = valueAt(message, "content");
    if (typeof content === "string") add(content);
  }
  for (const item of asArray(valueAt(object, "output"))) {
    const itemObject = asObject(item);
    if (stringAt(itemObject, "type") === "message") {
      for (const part of asArray(valueAt(itemObject, "content"))) {
        if (typeof part === "string") add(part);
        else add(stringAt(asObject(part), "text"));
      }
    }
  }
  return texts;
}

function streamRawText(record: CallRecord): string {
  const response = record.response;
  if (typeof response === "string") return response;
  const rawText = stringAt(asObject(response), "raw_text");
  if (rawText) return rawText;
  const encoded = stringAt(asObject(record.raw), "raw_response");
  if (!encoded) return "";
  const trimmed = encoded.trim();
  if (trimmed.startsWith("data:") || trimmed.startsWith("{")) return trimmed;
  try {
    return Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return trimmed;
  }
}

function ssePayloads(record: CallRecord): JsonObject[] {
  const fromText = ssePayloadsFromText(streamRawText(record));
  if (fromText.length > 0) return fromText;
  const out: JsonObject[] = [];
  for (const event of asArray(valueAt(asObject(record.raw), "sse_events"))) {
    const encoded = stringAt(asObject(event), "data");
    if (!encoded || encoded === "[DONE]") continue;
    const decoded = decodeSseData(encoded);
    if (decoded) out.push(decoded);
  }
  return out;
}

function ssePayloadsFromText(text: string): JsonObject[] {
  const out: JsonObject[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find((candidate) => candidate.startsWith("data:"));
    if (!line) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = decodeSseData(data);
    if (parsed) out.push(parsed);
  }
  return out;
}

function decodeSseData(data: string): JsonObject | undefined {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;
  const candidates = [trimmed];
  try {
    candidates.push(Buffer.from(trimmed, "base64").toString("utf8"));
  } catch {
    // Keep the original payload.
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(candidate) as JsonValue;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next encoding.
    }
  }
  return undefined;
}

function concatenatedDeltasForRecord(record: CallRecord): string {
  let out = "";
  for (const payload of ssePayloads(record)) {
    const type = stringAt(payload, "type");
    const delta = valueAt(payload, "delta");
    if (type === "response.output_text.delta" && typeof delta === "string") {
      out += delta;
      continue;
    }
    for (const choice of asArray(valueAt(payload, "choices"))) {
      const content = valueAt(objectAt(asObject(choice), "delta"), "content");
      if (typeof content === "string") out += content;
    }
  }
  return out;
}

function assembledToolArgDeltas(record: CallRecord): Array<[string, string]> {
  const byKey = new Map<string, { name?: string; args: string }>();
  const entry = (key: string): { name?: string; args: string } => {
    const current = byKey.get(key) ?? { args: "" };
    byKey.set(key, current);
    return current;
  };
  for (const payload of ssePayloads(record)) {
    const type = stringAt(payload, "type");
    const delta = valueAt(payload, "delta");
    if (type === "response.output_item.added") {
      const item = objectAt(payload, "item");
      if (stringAt(item, "type") === "function_call") {
        const key = `r:${numberAt(payload, "output_index") ?? stringAt(item, "id") ?? stringAt(item, "call_id")}`;
        const name = stringAt(item, "name");
        if (name) entry(key).name = name;
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta" && typeof delta === "string") {
      const key = `r:${numberAt(payload, "output_index") ?? stringAt(payload, "item_id")}`;
      entry(key).args += delta;
      continue;
    }
    for (const choice of asArray(valueAt(payload, "choices"))) {
      const choiceIndex = numberAt(asObject(choice), "index") ?? 0;
      for (const toolCall of asArray(valueAt(objectAt(asObject(choice), "delta"), "tool_calls"))) {
        const object = asObject(toolCall);
        const current = entry(`c:${choiceIndex}:${numberAt(object, "index") ?? 0}`);
        const name = stringAt(objectAt(object, "function"), "name") ?? stringAt(object, "name");
        const args = stringAt(objectAt(object, "function"), "arguments") ?? stringAt(object, "arguments");
        if (name) current.name = name;
        if (args) current.args += args;
      }
    }
  }
  return [...byKey.values()].map((current) => [current.name ?? "unknown", current.args]);
}

function usageDetailsForRecord(record: CallRecord): { cachedTokens?: number; reasoningTokens?: number } {
  const usage = record.usage ?? objectAt(asObject(record.response), "usage") ?? {};
  const cachedTokens = firstPositiveOrDefined(
    numberAt(objectAt(usage, "input_tokens_details"), "cached_tokens"),
    numberAt(objectAt(usage, "prompt_tokens_details"), "cached_tokens"),
    numberAt(objectAt(usage, "inputTokensDetails"), "cached_tokens"),
    numberAt(objectAt(usage, "promptTokensDetails"), "cached_tokens"),
    numberAt(usage, "cached_tokens"),
  );
  const reasoningTokens = firstPositiveOrDefined(
    numberAt(objectAt(usage, "output_tokens_details"), "reasoning_tokens"),
    numberAt(objectAt(usage, "completion_tokens_details"), "reasoning_tokens"),
    numberAt(objectAt(usage, "outputTokensDetails"), "reasoning_tokens"),
    numberAt(objectAt(usage, "completionTokensDetails"), "reasoning_tokens"),
    numberAt(usage, "reasoning_tokens"),
  );
  return {
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function httpStatusFromError(value: JsonValue | undefined): number | undefined {
  const object = asObject(value);
  return (
    numberAt(object, "status") ??
    numberAt(object, "http_status") ??
    numberAt(objectAt(object, "error"), "status") ??
    numberAt(objectAt(object, "error"), "http_status")
  );
}

function errorFields(record: CallRecord, key: "type" | "code"): string[] {
  const values: string[] = [];
  const visit = (candidate: JsonValue | undefined): void => {
    if (candidate === undefined || candidate === null) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== "object") return;
    const object = asObject(candidate);
    const value = stringAt(object, key);
    if (value) values.push(value);
    visit(valueAt(object, "error"));
  };
  visit(record.error);
  visit(record.response);
  visit(record.raw);
  return [...new Set(values)];
}

function isIncompleteRecord(record: CallRecord): boolean {
  if (record.error !== undefined) return true;
  const reasons = finishReasons(record.response);
  if (reasons.some((reason) => /incomplete|cancel|abort|error/i.test(reason))) return true;
  const raw = asObject(record.raw);
  if (valueAt(objectAt(raw, "normalized"), "stream_truncated") === true) return true;
  if (record.streamed === true && reasons.length === 0) return true;
  return false;
}

function hasRawPayload(record: CallRecord): boolean {
  const raw = asObject(record.raw);
  return Boolean(stringAt(raw, "raw_request") || stringAt(raw, "raw_response"));
}

export function formatTraceSummary(trace: SessionTrace): string {
  const lines = [`llmentary trace summary for session ${trace.id}: ${trace.calls.length} call(s)`];
  if (trace.summary) lines.push(trace.summary);
  trace.calls.forEach((record, index) => {
    const tools = toolCallsForRecords([record]).map((tool) => tool.name);
    lines.push(
      `${index + 1}. seq=${index} ${record.apiFamily ?? record.apiType ?? "unknown"} model=${record.model ?? "unknown"} tools=${tools.join(",") || "-"} finish=${finishReasons(record.response).join(",") || "-"} error=${record.error ? "yes" : "no"} spec=${specStatusForRecord(record)}`,
    );
  });
  return lines.join("\n");
}

function emptyTrace(sessionId: string): SessionTrace {
  return attachSessionTraceHelpers(sessionId, [], { id: sessionId, calls: [] });
}

function toolResultContents(value: JsonValue | undefined, toolCallIds: Set<string>): string[] {
  const out: string[] = [];
  const visit = (candidate: JsonValue | undefined): void => {
    if (candidate === undefined || candidate === null) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== "object") return;
    const object = asObject(candidate);
    const role = stringAt(object, "role");
    const type = stringAt(object, "type");
    const toolCallId = stringAt(object, "tool_call_id") ?? stringAt(object, "toolCallId") ?? stringAt(object, "call_id");
    const isResult = role === "tool" || type === "function_call_output";
    if (isResult && (!toolCallIds.size || (toolCallId && toolCallIds.has(toolCallId)))) {
      const content = stringAt(object, "content") ?? stringAt(object, "output");
      if (content) out.push(content);
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return out;
}

function evaluateSpecFindings(
  trace: SessionTrace,
  query: QueryOptions,
  options: SpecAssertionOptions,
  kind: "violations" | "ignored",
): { pass: boolean; message: string } {
  const records = selectRecordsForSpec(trace, query, options.calls);
  const findings: string[] = [];
  let anyChecked = false;
  let anyUnchecked = false;
  records.forEach(({ record, index }) => {
    const checked =
      kind === "violations" ? validationWasRun(record) : record.ignoredFields !== undefined || validationWasRun(record);
    if (!checked) {
      anyUnchecked = true;
      return;
    }
    anyChecked = true;
    const items = kind === "violations" ? (record.specViolations ?? []) : (record.ignoredFields ?? []);
    for (const item of items) {
      if (!includeFinding(item, options)) continue;
      findings.push(formatContractFinding(index + 1, record, item));
    }
  });
  if (findings.length > 0) {
    return { pass: false, message: findings.join("\n") };
  }
  if (!anyChecked || anyUnchecked) {
    if (options.allowUnvalidated) {
      return { pass: true, message: "validation was not run" };
    }
    return { pass: false, message: "validation was not run" };
  }
  return {
    pass: true,
    message: kind === "violations" ? "no spec violations" : "no ignored fields",
  };
}

function selectRecordsForSpec(
  trace: SessionTrace,
  query: QueryOptions,
  calls?: Array<number | string>,
): Array<{ record: CallRecord; index: number }> {
  const records = recordsForTrace(trace, query).map((record, index) => ({ record, index }));
  if (!calls?.length) return records;
  return records.filter(
    ({ record, index }) => calls.includes(index) || (record.id !== undefined && calls.includes(record.id)),
  );
}

function includeFinding(item: SpecViolation | IgnoredField, options: SpecAssertionOptions): boolean {
  if (options.side && item.side !== options.side) return false;
  if (options.ignorePaths?.some((path) => findingMatchesPath(item, path))) return false;
  if (options.ignoreKeywords?.some((keyword) => "keyword" in item && item.keyword === keyword)) return false;
  return true;
}

function findingMatchesPath(item: SpecViolation | IgnoredField, ignore: string): boolean {
  const candidates = [item.path, item.pointer].filter((value): value is string => Boolean(value));
  const needle = ignore.replace(/^\/+|\/+$/g, "");
  if (!needle) return false;
  return candidates.some((candidate) => {
    const hay = `/${candidate.replace(/^\/+|\/+$/g, "")}/`;
    return hay.includes(`/${needle}/`);
  });
}

function formatContractFinding(callNumber: number, record: CallRecord, item: SpecViolation | IgnoredField): string {
  const family = record.apiFamily ?? record.apiType ?? "unknown";
  const side = item.side ?? "unknown";
  const path = item.pointer || item.path || "-";
  const message = item.message ?? "";
  const hint = ("keyword" in item && item.keyword) || ("kind" in item && item.kind) || "spec";
  return `${callNumber} ${family} ${side} ${path}: ${message} — ${hint}`;
}
