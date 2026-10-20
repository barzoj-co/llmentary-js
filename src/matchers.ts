import type { AssertionScope } from "./assertions.js";
import type { JsonValue, SpecAssertionOptions, ToolCallAssertionOptions } from "./types.js";

export interface MatcherResult {
  pass: boolean;
  message(): string;
}

export async function toHaveToolCalled(
  scope: AssertionScope,
  name: string,
  options: ToolCallAssertionOptions = {},
): Promise<MatcherResult> {
  const result = await scope.soft().toolCalled(name, options);
  return {
    pass: result.pass,
    message: () => result.error?.message ?? result.message,
  };
}

export async function toHaveToolCalledTimes(
  scope: AssertionScope,
  name: string,
  count: number,
  options: ToolCallAssertionOptions = {},
): Promise<MatcherResult> {
  const result = await scope.soft().calledTimes(name, count, options);
  return {
    pass: result.pass,
    message: () => result.error?.message ?? result.message,
  };
}

export async function toHaveRequestParam(
  scope: AssertionScope,
  path: string,
  expected: JsonValue,
): Promise<MatcherResult> {
  const result = await scope.soft().requestParam(path, expected);
  return {
    pass: result.pass,
    message: () => result.error?.message ?? result.message,
  };
}

export async function toHaveNoSpecViolations(
  scope: AssertionScope,
  options: SpecAssertionOptions = {},
): Promise<MatcherResult> {
  const result = await scope.soft().noSpecViolations(options);
  return {
    pass: result.pass,
    message: () => result.error?.message ?? result.message,
  };
}

export async function toHaveNoIgnoredFields(
  scope: AssertionScope,
  options: SpecAssertionOptions = {},
): Promise<MatcherResult> {
  const result = await scope.soft().noIgnoredFields(options);
  return {
    pass: result.pass,
    message: () => result.error?.message ?? result.message,
  };
}
