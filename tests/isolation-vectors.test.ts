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
  messageFragments: string[];
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
    const calls = value.calls ?? value.records ?? value.requests ?? value.traces;
    const idKey = `${key}_id`;
    const idAlias = raw[idKey];
    const id =
      stringField(value, "id", "session_id", "sessionId") ??
      (typeof idAlias === "string" ? idAlias : key);
    return { id, calls: Array.isArray(calls) ? calls : [] };
  }
  throw new Error(`vector is missing a session side (${keys.join("/")})`);
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function parseVector(name: string, rawValue: JsonValue): IsolationVector {
  const raw = asObject(rawValue);
  const expectObj = asObject(raw.expect);
  const isolatedFlag = raw.isolated ?? expectObj.isolated;
  const want = typeof raw.expect === "string" ? raw.expect : stringField(raw, "want", "expected");
  const expectPass =
    isolatedFlag === true || want === "pass" || want === "ok"
      ? true
      : isolatedFlag === false || want === "fail"
        ? false
        : true;
  const optionsRaw = asObject(raw.options);
  const allowEmpty = raw.allow_empty ?? raw.allowEmpty ?? optionsRaw.allow_empty ?? optionsRaw.allowEmpty;
  const minChars = raw.min_chars ?? raw.minChars ?? optionsRaw.min_chars ?? optionsRaw.minChars;
  const ignoreTexts = raw.ignore_texts ?? raw.ignoreTexts ?? optionsRaw.ignore_texts ?? optionsRaw.ignoreTexts;
  const self = side(raw, "self", "x", "left", "a");
  const other = side(raw, "other", "y", "right", "b");
  const messageFragments = [
    ...stringList(raw.message_contains),
    ...stringList(expectObj.message_contains),
    ...stringList(raw.messageFragments),
  ];
  const single = stringField(raw, "messageFragment", "message_fragment", "err_contains", "want_message");
  if (single) messageFragments.push(single);
  const ignoreList = Array.isArray(ignoreTexts)
    ? ignoreTexts.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    name: stringField(raw, "name") ?? stringField(raw, "id") ?? name.replace(/\.json$/, ""),
    expect: expectPass ? "pass" : "fail",
    messageFragments,
    options: {
      ...(allowEmpty === true ? { allowEmpty: true } : {}),
      ...(typeof minChars === "number" ? { minChars } : {}),
      ...(ignoreList ? { ignoreTexts: ignoreList } : {}),
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
    for (const fragment of vector.messageFragments) {
      expect(result.message).toContain(fragment);
    }
  });
});
