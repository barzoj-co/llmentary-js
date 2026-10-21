import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolationCheck } from "../src/assertions.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { IsolatedFromOptions, JsonObject, JsonValue } from "../src/types.js";

const VECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "isolation");

interface IsolationVector {
  name: string;
  expect: "pass" | "fail";
  messageFragment?: string | null;
  options?: IsolatedFromOptions;
  self: { id: string; calls: JsonValue[] };
  other: { id: string; calls: JsonValue[] };
}

function asObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringField(object: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function side(raw: JsonObject, ...keys: string[]): { id: string; calls: JsonValue[] } {
  for (const key of keys) {
    const value = asObject(raw[key]);
    if (Object.keys(value).length === 0) continue;
    const calls = value.calls;
    const idKey = `${key}_id`;
    const idAlias = raw[idKey];
    const id =
      stringField(value, "id", "session_id", "sessionId") ??
      (typeof idAlias === "string" ? idAlias : key);
    return { id, calls: Array.isArray(calls) ? calls : [] };
  }
  throw new Error(`vector is missing a session side (${keys.join("/")})`);
}

function parseVector(name: string, rawValue: JsonValue): IsolationVector {
  const raw = asObject(rawValue);
  const want = stringField(raw, "expect", "want", "expected");
  const isolated = raw.isolated;
  const expectPass =
    want === "pass" ||
    want === "ok" ||
    isolated === true ||
    (want !== "fail" && isolated !== false && raw.expect !== "fail");
  const optionsRaw = asObject(raw.options);
  const allowEmpty = raw.allow_empty ?? raw.allowEmpty ?? optionsRaw.allow_empty ?? optionsRaw.allowEmpty;
  const minChars = raw.min_chars ?? raw.minChars ?? optionsRaw.min_chars ?? optionsRaw.minChars;
  const ignoreTexts = raw.ignore_texts ?? raw.ignoreTexts ?? optionsRaw.ignore_texts ?? optionsRaw.ignoreTexts;
  const self = side(raw, "self", "x", "left", "a");
  const other = side(raw, "other", "y", "right", "b");
  return {
    name: stringField(raw, "name") ?? name.replace(/\.json$/, ""),
    expect: expectPass ? "pass" : "fail",
    messageFragment: stringField(raw, "messageFragment", "message_fragment", "err_contains", "want_message"),
    options: {
      ...(allowEmpty === true ? { allowEmpty: true } : {}),
      ...(typeof minChars === "number" ? { minChars } : {}),
      ...(Array.isArray(ignoreTexts) ? { ignoreTexts: ignoreTexts.filter((item): item is string => typeof item === "string") } : {}),
    },
    self,
    other,
  };
}

function loadVectors(): IsolationVector[] {
  return readdirSync(VECTOR_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parseVector(name, JSON.parse(readFileSync(join(VECTOR_DIR, name), "utf8")) as JsonValue));
}

describe("isolation vectors (DOG-29)", () => {
  const vectors = loadVectors();
  expect(vectors.length).toBeGreaterThanOrEqual(8);

  it.each(vectors)("$name", (vector) => {
    const self = normalizeSessionTrace(vector.self.id, vector.self);
    const other = normalizeSessionTrace(vector.other.id, vector.other);
    const result = isolationCheck(self, vector.self.id, other, vector.other.id, vector.options ?? {});
    expect(result.pass, result.message).toBe(vector.expect === "pass");
    if (vector.messageFragment) {
      expect(result.message).toContain(vector.messageFragment);
    }
  });
});
