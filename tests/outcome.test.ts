import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeCallRecord } from "../src/normalize.js";
import type { CallOutcome, JsonValue } from "../src/types.js";

const VECTOR = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "call_outcomes.json");

interface OutcomeCase {
  name: string;
  outcome: CallOutcome;
  call: JsonValue;
}

function loadCases(): OutcomeCase[] {
  const vector = JSON.parse(readFileSync(VECTOR, "utf8")) as { cases?: OutcomeCase[] };
  if (!Array.isArray(vector.cases)) throw new Error("call_outcomes.json is missing its cases array");
  return vector.cases;
}

describe("CallRecord outcome vectors", () => {
  const cases = loadCases();
  expect(cases).toHaveLength(15);

  it.each(cases)("$name", (testCase) => {
    const record = normalizeCallRecord(testCase.call);
    expect(record.outcome, testCase.name).toBe(testCase.outcome);
  });

  it("leaves outcome undefined for in-flight calls", () => {
    const record = normalizeCallRecord({
      id: "call_inflight",
      seq: 16,
      started_at: "2026-10-26T10:00:00Z",
      stream: true,
      http_status: 200,
      client_aborted: false,
      normalized: {},
    });
    expect(record.finishedAt).toBeUndefined();
    expect(record.outcome).toBeUndefined();
  });
});
