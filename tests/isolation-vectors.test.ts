import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolationCheck } from "../src/assertions.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { IsolatedFromOptions, JsonValue } from "../src/types.js";

const VECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "isolation");

interface IsolationVector {
  name: string;
  expect: "pass" | "fail";
  messageFragment?: string | null;
  options?: IsolatedFromOptions;
  self: { id: string; calls: JsonValue[] };
  other: { id: string; calls: JsonValue[] };
}

function loadVectors(): IsolationVector[] {
  return readdirSync(VECTOR_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(VECTOR_DIR, name), "utf8")) as IsolationVector);
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
