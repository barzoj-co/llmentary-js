import { firstNonEmpty } from "./env.js";
import type { WaitOptions } from "./types.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_WAIT_QUIET_MS = 500;
export const WAIT_HTTP_PADDING_MS = 5_000;

export const WAIT_TIMEOUT_ENV = "LLMENTARY_WAIT_TIMEOUT";
export const WAIT_QUIET_ENV = "LLMENTARY_WAIT_QUIET";
export const WAIT_TIMEOUT_MS_ENV = "LLMENTARY_WAIT_TIMEOUT_MS";
export const WAIT_IDLE_MS_ENV = "LLMENTARY_WAIT_IDLE_MS";

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 0.001,
  "µs": 0.001,
  "μs": 0.001,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

const warnedDeprecated = new Set<string>();

export interface ResolvedWait {
  timeout: string;
  quiet: string;
  timeoutMs: number;
  quietMs: number;
}

export function resetWaitEnvDeprecationWarnings(): void {
  warnedDeprecated.clear();
}

export function parseWaitDuration(raw: string, envName: string): number {
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) {
      throw invalidWaitDuration(raw, envName);
    }
    return Math.round(seconds * 1_000);
  }
  const ms = parseGoDuration(trimmed);
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    throw invalidWaitDuration(raw, envName);
  }
  return Math.round(ms);
}

/** Deprecated `*_MS` env values are milliseconds when the value is a bare number. */
export function parseWaitDurationMs(raw: string, envName: string): number {
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed);
    if (!Number.isFinite(ms) || ms < 0) {
      throw invalidWaitDuration(raw, envName);
    }
    return Math.round(ms);
  }
  return parseWaitDuration(raw, envName);
}

export function formatGoDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`cannot format wait duration ${String(ms)}`);
  }
  const rounded = Math.round(ms);
  if (rounded % 1_000 === 0) return `${rounded / 1_000}s`;
  return `${rounded}ms`;
}

export function resolveWait(options: WaitOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedWait {
  const timeoutMs = resolveWaitField({
    explicit: options.timeout,
    explicitMs: options.timeoutMs,
    envValue: firstNonEmpty(env[WAIT_TIMEOUT_ENV]),
    envName: WAIT_TIMEOUT_ENV,
    deprecatedMs: firstNonEmpty(env[WAIT_TIMEOUT_MS_ENV]),
    deprecatedName: WAIT_TIMEOUT_MS_ENV,
    replacementName: WAIT_TIMEOUT_ENV,
    defaultMs: DEFAULT_WAIT_TIMEOUT_MS,
  });
  const quietMs = resolveWaitField({
    explicit: options.quiet,
    explicitMs: options.idleMs,
    envValue: firstNonEmpty(env[WAIT_QUIET_ENV]),
    envName: WAIT_QUIET_ENV,
    deprecatedMs: firstNonEmpty(env[WAIT_IDLE_MS_ENV]),
    deprecatedName: WAIT_IDLE_MS_ENV,
    replacementName: WAIT_QUIET_ENV,
    defaultMs: DEFAULT_WAIT_QUIET_MS,
  });
  return {
    timeout: formatGoDurationMs(timeoutMs),
    quiet: formatGoDurationMs(quietMs),
    timeoutMs,
    quietMs,
  };
}

export function resolvedWaitToOptions(resolved: ResolvedWait): WaitOptions {
  return {
    timeout: resolved.timeout,
    quiet: resolved.quiet,
    timeoutMs: resolved.timeoutMs,
    idleMs: resolved.quietMs,
  };
}

export function mergeWaitOptions(base: WaitOptions, override: WaitOptions = {}): WaitOptions {
  const merged: WaitOptions = { ...base };
  if (override.timeout !== undefined || override.timeoutMs !== undefined) {
    delete merged.timeout;
    delete merged.timeoutMs;
    if (override.timeout !== undefined) merged.timeout = override.timeout;
    if (override.timeoutMs !== undefined) merged.timeoutMs = override.timeoutMs;
  }
  if (override.quiet !== undefined || override.idleMs !== undefined) {
    delete merged.quiet;
    delete merged.idleMs;
    if (override.quiet !== undefined) merged.quiet = override.quiet;
    if (override.idleMs !== undefined) merged.idleMs = override.idleMs;
  }
  if (override.signal !== undefined) merged.signal = override.signal;
  return merged;
}

export function formatWaitTimeoutError(
  sessionId: string,
  timeout: string,
  calls: number,
  stillActive: number,
): string {
  return `wait timed out after ${timeout} on session ${sessionId} (${calls} calls so far, still active: ${stillActive}). Raise LLMENTARY_WAIT_TIMEOUT if the graph needs more time.`;
}

function resolveWaitField(input: {
  explicit: number | string | undefined;
  explicitMs: number | undefined;
  envValue: string | undefined;
  envName: string;
  deprecatedMs: string | undefined;
  deprecatedName: string;
  replacementName: string;
  defaultMs: number;
}): number {
  if (input.explicit !== undefined) {
    return typeof input.explicit === "number"
      ? millisecondsFromSeconds(input.explicit, input.envName)
      : parseWaitDuration(input.explicit, input.envName);
  }
  if (input.explicitMs !== undefined) {
    if (!Number.isFinite(input.explicitMs) || input.explicitMs < 0) {
      throw invalidWaitDuration(String(input.explicitMs), input.envName);
    }
    return Math.round(input.explicitMs);
  }
  if (input.envValue !== undefined) {
    return parseWaitDuration(input.envValue, input.envName);
  }
  if (input.deprecatedMs !== undefined) {
    warnDeprecatedWaitEnv(input.deprecatedName, input.replacementName);
    return parseWaitDurationMs(input.deprecatedMs, input.deprecatedName);
  }
  return input.defaultMs;
}

function millisecondsFromSeconds(seconds: number, envName: string): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw invalidWaitDuration(String(seconds), envName);
  }
  return Math.round(seconds * 1_000);
}

function parseGoDuration(input: string): number | undefined {
  if (!input) return undefined;
  const re = /([0-9]*\.?[0-9]+)(ns|us|µs|μs|ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match.index !== consumed) return undefined;
    const value = Number(match[1]);
    const factor = UNIT_MS[match[2] ?? ""];
    if (!Number.isFinite(value) || factor === undefined) return undefined;
    total += value * factor;
    consumed = re.lastIndex;
  }
  if (consumed === 0 || consumed !== input.length) return undefined;
  return total;
}

function invalidWaitDuration(raw: string, envName: string): Error {
  return new Error(
    `invalid ${envName} value ${JSON.stringify(raw)}: expected a Go duration (45s, 200ms) or bare seconds (45, 0.2)`,
  );
}

function warnDeprecatedWaitEnv(name: string, replacement: string): void {
  if (warnedDeprecated.has(name)) return;
  warnedDeprecated.add(name);
  process.emitWarning(
    `${name} is deprecated; use ${replacement} (Go duration or seconds).`,
    "DeprecationWarning",
  );
}
