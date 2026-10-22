import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AssertionScope, findingSide, formatTraceSummary } from "../src/assertions.js";
import { normalizeCallRecord, normalizeSessionTrace, specStatusForRecord } from "../src/normalize.js";
import type { JsonValue, QueryOptions, SessionTrace } from "../src/types.js";

const CONTEXT_ONLY = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "testdata/spec/ignored-fields-context-only.json"), "utf8"),
) as JsonValue;

/** Sample live run: validation metadata is not a violation. */
const SAMPLE_CLEAN_RUN = {
  api_family: "openai.chat",
  normalized: {
    validation: {
      mode: "warn",
      profile: "relaxed",
      spec_sha: "f88d2f78aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schema_subset_retrieved: "2026-10-18",
      request_checked: true,
      response_checked: true,
      skipped_reason: null,
      duration_us: 400,
    },
    spec_violations: [],
  },
};

const VIOLATION_FOO = {
  api_family: "openai.chat",
  normalized: {
    validation: { mode: "warn", profile: "relaxed", request_checked: true, response_checked: true },
    spec_violations: [
      {
        side: "request",
        source: "schema",
        path: "foo",
        pointer: "/foo",
        keyword: "unevaluatedProperties",
        message: "additional property 'foo' is not allowed",
      },
    ],
  },
};

const IGNORED_ENUM = {
  api_family: "openai.chat",
  normalized: {
    validation: { mode: "warn", request_checked: true, response_checked: true },
    spec_violations: [],
    ignored_fields: [
      {
        side: "request",
        path: "tools/0/function/parameters/properties/city/enumDescriptions",
        pointer: "/tools/0/function/parameters/properties/city/enumDescriptions",
        kind: "enumDescriptions",
        severity: "warning",
        message: "vendor extension is ignored",
      },
    ],
  },
};

const UNCHECKED = {
  api_family: "openai.chat",
  normalized: { output_text: "hi" },
};

describe("spec validation accessors", () => {
  it("parses clean, present, absent, and a sample clean-run payload", () => {
    const clean = normalizeCallRecord(SAMPLE_CLEAN_RUN);
    expect(clean.validation).toMatchObject({
      mode: "warn",
      profile: "relaxed",
      specSha: "f88d2f78aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requestChecked: true,
      responseChecked: true,
    });
    expect(clean.specViolations).toEqual([]);
    expect(specStatusForRecord(clean)).toBe("clean");

    const dirty = normalizeCallRecord(VIOLATION_FOO);
    expect(dirty.specViolations).toHaveLength(1);
    expect(dirty.specViolations?.[0]).toMatchObject({
      side: "request",
      pointer: "/foo",
      keyword: "unevaluatedProperties",
    });
    expect(specStatusForRecord(dirty)).toBe("1 violation");

    const unchecked = normalizeCallRecord(UNCHECKED);
    expect(unchecked.specViolations).toBeUndefined();
    expect(unchecked.validation).toBeUndefined();
    expect(specStatusForRecord(unchecked)).toBe("not checked");

    const ignored = normalizeCallRecord(IGNORED_ENUM);
    expect(ignored.ignoredFields).toHaveLength(1);
    expect(ignored.ignoredFields?.[0]).toMatchObject({ kind: "enumDescriptions", severity: "warning" });

    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [SAMPLE_CLEAN_RUN, VIOLATION_FOO] });
    expect(trace.specViolations()).toHaveLength(1);
    expect(trace.ignoredFields()).toEqual([]);

    const pascal = normalizeSessionTrace("s1", {
      Id: "s1",
      Calls: [
        {
          api_family: "openai.chat",
          SpecViolations: [{ side: "request", path: "foo", message: "no" }],
          IgnoredFields: [{ kind: "enumDescriptions" }],
        },
      ],
    });
    expect(pascal.calls).toHaveLength(1);
    expect(pascal.specViolations()).toHaveLength(1);
    expect(pascal.specViolations()[0]).toMatchObject({ side: "request", path: "foo" });
    expect(pascal.ignoredFields()).toHaveLength(1);
    expect(pascal.ignoredFields()[0]).toMatchObject({ kind: "enumDescriptions" });
  });

  it("falls through null spec lists and keeps an empty array as clean", () => {
    const fromTopLevel = normalizeCallRecord({
      api_family: "openai.chat",
      SpecViolations: [{ side: "request", path: "foo", message: "no" }],
      IgnoredFields: [{ kind: "enumDescriptions" }],
      normalized: {
        spec_violations: null,
        ignored_fields: null,
      },
    });
    expect(fromTopLevel.specViolations).toHaveLength(1);
    expect(fromTopLevel.specViolations?.[0]).toMatchObject({ side: "request", path: "foo" });
    expect(fromTopLevel.ignoredFields).toHaveLength(1);
    expect(fromTopLevel.ignoredFields?.[0]).toMatchObject({ kind: "enumDescriptions" });

    const emptyKeepsClean = normalizeCallRecord({
      api_family: "openai.chat",
      SpecViolations: [{ side: "request", path: "foo", message: "no" }],
      IgnoredFields: [{ kind: "enumDescriptions" }],
      normalized: {
        spec_violations: [],
        ignored_fields: [],
      },
    });
    expect(emptyKeepsClean.specViolations).toEqual([]);
    expect(emptyKeepsClean.ignoredFields).toEqual([]);

    const absent = normalizeCallRecord({
      api_family: "openai.chat",
      normalized: { output_text: "hi" },
    });
    expect(absent.specViolations).toBeUndefined();
    expect(absent.ignoredFields).toBeUndefined();
  });

  it("treats a sample clean run as clean, not as a violation", async () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [SAMPLE_CLEAN_RUN] });
    await expect(scopeFor(trace).noSpecViolations()).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).soft().noSpecViolations()).resolves.toMatchObject({ pass: true });
  });

  it("fails noSpecViolations with the contract message and options table", async () => {
    const dirty = normalizeSessionTrace("s1", { id: "s1", calls: [VIOLATION_FOO, SAMPLE_CLEAN_RUN] });
    const failed = await scopeFor(dirty).soft().noSpecViolations();
    expect(failed.pass).toBe(false);
    expect(failed.message).toBe(
      "1 openai.chat request /foo: additional property 'foo' is not allowed — unevaluatedProperties",
    );

    await expect(scopeFor(dirty).noSpecViolations({ side: "response" })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(dirty).noSpecViolations({ ignorePaths: ["/foo"] })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(dirty).soft().noSpecViolations({ ignorePaths: ["/fo"] })).resolves.toMatchObject({ pass: false });
    await expect(scopeFor(dirty).noSpecViolations({ ignoreKeywords: ["unevaluatedProperties"] })).resolves.toMatchObject({
      pass: true,
    });
    await expect(scopeFor(dirty).noSpecViolations({ calls: [1] })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(dirty).soft().noSpecViolations({ calls: [0] })).resolves.toMatchObject({ pass: false });
    await expect(scopeFor(dirty).soft().noSpecViolations({ side: "request" })).resolves.toMatchObject({ pass: false });
  });

  it("fails when validation was not run unless allowUnvalidated", async () => {
    const off = normalizeSessionTrace("s1", { id: "s1", calls: [UNCHECKED] });
    await expect(scopeFor(off).soft().noSpecViolations()).resolves.toMatchObject({
      pass: false,
      message: "validation was not run",
    });
    await expect(scopeFor(off).noSpecViolations({ allowUnvalidated: true })).resolves.toMatchObject({ pass: true });
  });

  it("asserts noIgnoredFields with the same option table", async () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [IGNORED_ENUM, SAMPLE_CLEAN_RUN] });
    const failed = await scopeFor(trace).soft().noIgnoredFields();
    expect(failed.pass).toBe(false);
    expect(failed.message).toMatch(/^1 openai.chat request .*enumDescriptions.* — enumDescriptions$/);

    await expect(scopeFor(trace).noIgnoredFields({ side: "response" })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).noIgnoredFields({ ignorePaths: ["enumDescriptions"] })).resolves.toMatchObject({
      pass: true,
    });
    await expect(scopeFor(trace).noIgnoredFields({ calls: [1] })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(normalizeSessionTrace("s1", { id: "s1", calls: [UNCHECKED] })).soft().noIgnoredFields()).resolves.toMatchObject({
      pass: false,
      message: "validation was not run",
    });
    await expect(
      scopeFor(normalizeSessionTrace("s1", { id: "s1", calls: [SAMPLE_CLEAN_RUN] })).noIgnoredFields(),
    ).resolves.toMatchObject({ pass: true });
  });

  it("fails request-side noIgnoredFields when the proxy writes context instead of side (DOG-45)", async () => {
    const contextOnly = normalizeSessionTrace("dog-45-context-only", CONTEXT_ONLY);
    expect(contextOnly.ignoredFields()[0]?.side).toBe("request");
    expect(findingSide(contextOnly.ignoredFields()[0]!)).toBe("request");

    const failed = await scopeFor(contextOnly).soft().noIgnoredFields({ side: "request" });
    expect(failed.pass).toBe(false);
    expect(failed.message).toMatch(/^1 openai.chat request \/provider: vendor extra — vendor_field$/);

    await expect(scopeFor(contextOnly).noIgnoredFields({ side: "response" })).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(contextOnly).soft().noIgnoredFields()).resolves.toMatchObject({ pass: false });
  });

  it("filters ignored fields and spec violations by context, side, or both (DOG-45)", async () => {
    const variants = {
      "side only": { side: "request", path: "foo", pointer: "/foo", kind: "vendor_field", message: "extra" },
      "context only": { context: "request", path: "foo", pointer: "/foo", kind: "vendor_field", message: "extra" },
      both: {
        side: "request",
        context: "request",
        path: "foo",
        pointer: "/foo",
        kind: "vendor_field",
        message: "extra",
      },
      neither: { path: "foo", pointer: "/foo", kind: "vendor_field", message: "extra" },
    } as const;

    for (const [label, field] of Object.entries(variants)) {
      const ignored = normalizeSessionTrace("s1", {
        id: "s1",
        calls: [
          {
            api_family: "openai.chat",
            normalized: {
              validation: { mode: "warn", request_checked: true, response_checked: true },
              spec_violations: [],
              ignored_fields: [field],
            },
          },
        ],
      });
      const request = await scopeFor(ignored).soft().noIgnoredFields({ side: "request" });
      expect(request.pass, label).toBe(false);
      expect(request.message, label).toMatch(label === "neither" ? / unknown / : / request /);
      const response = await scopeFor(ignored).soft().noIgnoredFields({ side: "response" });
      expect(response.pass, `${label} response`).toBe(label !== "neither");

      const violation = normalizeSessionTrace("s1", {
        id: "s1",
        calls: [
          {
            api_family: "openai.chat",
            normalized: {
              validation: { mode: "warn", request_checked: true, response_checked: true },
              spec_violations: [{ ...field, keyword: "unevaluatedProperties" }],
            },
          },
        ],
      });
      const specRequest = await scopeFor(violation).soft().noSpecViolations({ side: "request" });
      expect(specRequest.pass, `violation ${label}`).toBe(false);
      expect(specRequest.message, `violation ${label}`).toMatch(label === "neither" ? / unknown / : / request /);
    }
  });

  it("includes spec status on the generated trace summary", () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [SAMPLE_CLEAN_RUN, VIOLATION_FOO, UNCHECKED] });
    const summary = formatTraceSummary(trace);
    expect(summary).toMatch(/spec=clean/);
    expect(summary).toMatch(/spec=1 violation/);
    expect(summary).toMatch(/spec=not checked/);
  });

  it("labels request-only validation and omits http=0 from abort summaries", () => {
    const requestOnly = normalizeCallRecord({
      id: "call_1",
      api_family: "openai.chat",
      http_status: 401,
      request: { model: "gpt-4.1-mini" },
      normalized: {
        validation: { request_checked: true, response_checked: false },
        spec_violations: [],
      },
    });
    expect(specStatusForRecord(requestOnly)).toBe("request_only");
    expect(requestOnly.httpStatus).toBe(401);

    const both = normalizeCallRecord({
      normalized: {
        validation: { request_checked: true, response_checked: true },
        spec_violations: [],
      },
    });
    expect(specStatusForRecord(both)).toBe("clean");

    const skipped = normalizeCallRecord({
      normalized: { validation: { skipped_reason: "no_spec" } },
    });
    expect(specStatusForRecord(skipped)).toBe("skipped:no_spec");

    const abort = normalizeCallRecord({
      id: "call_a",
      api_family: "openai.chat",
      http_status: 0,
      client_aborted: true,
      request: { model: "gpt-4.1-mini" },
      normalized: {
        finish_reason: "cancelled",
        validation: { request_checked: true, response_checked: false },
        spec_violations: [],
      },
    });
    expect(abort.httpStatus).toBeUndefined();
    expect(specStatusForRecord(abort)).toBe("request_only");
    const summary = formatTraceSummary(normalizeSessionTrace("s1", { id: "s1", calls: [requestOnly.raw, abort.raw] }));
    expect(summary).toMatch(/spec=request_only/);
    expect(summary).toMatch(/http=401/);
    expect(summary).not.toMatch(/http=0/);

    const zeroThen401 = normalizeCallRecord({
      id: "call_z",
      api_family: "openai.chat",
      http_status: 0,
      error: { status: 401, type: "invalid_request_error" },
      request: { model: "gpt-4.1-mini" },
    });
    expect(zeroThen401.httpStatus).toBe(401);
    expect(formatTraceSummary(normalizeSessionTrace("s2", { id: "s2", calls: [zeroThen401.raw] }))).toMatch(/http=401/);
  });
});

function scopeFor(trace: SessionTrace, query?: QueryOptions): AssertionScope {
  return new AssertionScope({
    control: {
      wait: async () => trace,
    } as never,
    sessionId: trace.id,
    ...(query ? { query } : {}),
  });
}
