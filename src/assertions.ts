import { Ajv2020 } from "ajv/dist/2020.js";
import { ControlClient } from "./control.js";
import {
  asArray,
  asObject,
  numberAt,
  objectAt,
  stringAt,
  valueAt,
} from "./normalize.js";
import type {
  AssertionResult,
  Bounds,
  CallRecord,
  JsonObject,
  JsonSchemaAssertionOptions,
  JsonValue,
  NormalizedToolCall,
  QueryOptions,
  SessionTrace,
  TokenBounds,
  ToolCallAssertionOptions,
  WaitOptions,
} from "./types.js";

export class LabAssertionError extends Error {
  readonly trace: SessionTrace;

  constructor(message: string, trace: SessionTrace) {
    super(`${message}\n\n${formatTraceSummary(trace)}`);
    this.name = "LabAssertionError";
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
    return this.check(`expected tool "${name}" to be called`, (trace) => {
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
    return this.check(`expected tool "${name}" not to be called`, (trace) => {
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
    return this.check(`expected tool "${name}" to be called ${count} time(s)`, (trace) => {
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
    return this.check(`expected tool order ${expectedToolNames.join(" -> ")}`, (trace) => {
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
    return this.check("expected tool result to be fed back", (trace) => {
      const records = recordsForTrace(trace, this.query);
      const toolCallIds = new Set(
        toolCallsForRecords(records)
          .filter((call) => (name ? call.name === name : true))
          .map((call) => call.id)
          .filter((id): id is string => Boolean(id)),
      );
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
    return this.check(`expected model ${String(expected)}`, (trace) => {
      const records = recordsForTrace(trace, this.query);
      const models = records.map((record) => record.model).filter(Boolean) as string[];
      const pass = models.some((model) => (expected instanceof RegExp ? expected.test(model) : model === expected));
      return { pass, message: `expected model ${String(expected)}, saw ${models.join(", ") || "<none>"}` };
    });
  }

  async requestParam(path: string, expected: JsonValue | ((value: JsonValue | undefined) => boolean)): Promise<AssertionResult> {
    return this.check(`expected request param ${path}`, (trace) => {
      const records = recordsForTrace(trace, this.query);
      const values = records.map((record) => getPath(record.request, path));
      const pass = values.some((value) => (typeof expected === "function" ? expected(value) : deepEqual(value, expected)));
      return { pass, message: `expected request param ${path} to match, saw ${values.map(stringify).join(", ")}` };
    });
  }

  async finishReason(expected: string | RegExp): Promise<AssertionResult> {
    return this.check(`expected finish reason ${String(expected)}`, (trace) => {
      const reasons = recordsForTrace(trace, this.query).flatMap((record) => finishReasons(record.response));
      const pass = reasons.some((reason) => (expected instanceof RegExp ? expected.test(reason) : reason === expected));
      return { pass, message: `expected finish reason ${String(expected)}, saw ${reasons.join(", ") || "<none>"}` };
    });
  }

  async tokenBounds(bounds: TokenBounds): Promise<AssertionResult> {
    return this.check("expected token usage bounds", (trace) => {
      const usages = recordsForTrace(trace, this.query).map((record) => usageNumbers(record)).filter(Boolean);
      const pass = usages.some((usage) => {
        if (!usage) return false;
        return (
          checkBounds(usage.prompt, bounds.prompt) &&
          checkBounds(usage.completion, bounds.completion) &&
          checkBounds(usage.total, bounds.total)
        );
      });
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
    return this.check("expected no errors", (trace) => {
      const errors = recordsForTrace(trace, this.query).filter((record) => record.error !== undefined);
      return { pass: errors.length === 0, message: `expected no errors, saw ${errors.length}` };
    });
  }

  async hasError(pattern?: string | RegExp): Promise<AssertionResult> {
    return this.check("expected an error", (trace) => {
      const errors = recordsForTrace(trace, this.query).map((record) => record.error).filter((value) => value !== undefined);
      const pass = pattern
        ? errors.some((error) => matchesText(extractText(error), pattern))
        : errors.length > 0;
      return { pass, message: `expected an error${pattern ? ` matching ${String(pattern)}` : ""}, saw ${stringify(errors)}` };
    });
  }

  async midStreamError(pattern?: string | RegExp): Promise<AssertionResult> {
    return this.hasError(pattern);
  }

  async promptContains(textOrPattern: string | RegExp): Promise<AssertionResult> {
    return this.textAssertion("prompt", textOrPattern, (record) => extractText(record.request));
  }

  async responseContains(textOrPattern: string | RegExp): Promise<AssertionResult> {
    return this.textAssertion("response", textOrPattern, (record) => extractText(record.response));
  }

  async responseJsonValid(options: JsonSchemaAssertionOptions): Promise<AssertionResult> {
    return this.check("expected response JSON schema to be valid", (trace) => {
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

  private async numericRecordBound(field: "latencyMs" | "ttftMs" | "retries", bounds: Bounds): Promise<AssertionResult> {
    return this.check(`expected ${field} bounds`, (trace) => {
      const values = recordsForTrace(trace, this.query)
        .map((record) => record[field])
        .filter((value): value is number => typeof value === "number");
      const pass = values.some((value) => checkBounds(value, bounds));
      return { pass, message: `expected ${field} within ${stringify(bounds)}, saw ${values.join(", ") || "<none>"}` };
    });
  }

  private async textAssertion(
    label: string,
    pattern: string | RegExp,
    getText: (record: CallRecord) => string,
  ): Promise<AssertionResult> {
    return this.check(`expected ${label} to contain ${String(pattern)}`, (trace) => {
      const texts = recordsForTrace(trace, this.query).map(getText);
      const pass = texts.some((text) => matchesText(text, pattern));
      return { pass, message: `expected ${label} to contain ${String(pattern)}, saw ${texts.join("\n---\n") || "<none>"}` };
    });
  }

  private async check(
    defaultMessage: string,
    predicate: (trace: SessionTrace) => { pass: boolean; message?: string } | Promise<{ pass: boolean; message?: string }>,
  ): Promise<AssertionResult> {
    const trace = await this.control.wait(this.sessionId, this.defaultWait);
    const result = await predicate(trace);
    const message = result.message ?? defaultMessage;
    if (result.pass) return { pass: true, message, trace };
    const error = new LabAssertionError(message, trace);
    if (this.softMode) return { pass: false, message, trace, error };
    throw error;
  }
}

export function recordsForTrace(trace: SessionTrace, query: QueryOptions = {}): CallRecord[] {
  return trace.calls.filter((record) => {
    if (query.apiType && record.apiType !== query.apiType) return false;
    if (query.model) {
      if (!record.model) return false;
      if (query.model instanceof RegExp) {
        if (!query.model.test(record.model)) return false;
      } else if (record.model !== query.model) {
        return false;
      }
    }
    return true;
  });
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

export function formatTraceSummary(trace: SessionTrace): string {
  if (trace.summary) return trace.summary;
  const lines = [`llm-test-lab trace summary for session ${trace.id}: ${trace.calls.length} call(s)`];
  trace.calls.forEach((record, index) => {
    const tools = toolCallsForRecords([record]).map((tool) => tool.name);
    lines.push(
      `${index + 1}. ${record.apiType ?? "unknown"} model=${record.model ?? "unknown"} tools=${tools.join(",") || "-"} finish=${finishReasons(record.response).join(",") || "-"} error=${record.error ? "yes" : "no"}`,
    );
  });
  return lines.join("\n");
}
