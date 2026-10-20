import { describe, expect, it } from "vitest";
import { AssertionScope, formatTraceSummary } from "../src/assertions.js";
import { normalizeCallRecord, normalizeSessionTrace, specStatusForRecord } from "../src/normalize.js";
import type { QueryOptions, SessionTrace } from "../src/types.js";

/** chatservice live run 1: validation metadata is not a violation. */
const CHATSERVICE_RUN1 = {
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
  it("parses clean, present, absent, and the chatservice run-1 payload", () => {
    const clean = normalizeCallRecord(CHATSERVICE_RUN1);
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

    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [CHATSERVICE_RUN1, VIOLATION_FOO] });
    expect(trace.specViolations()).toHaveLength(1);
    expect(trace.ignoredFields()).toEqual([]);
  });

  it("treats chatservice run-1 as clean, not as a violation", async () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [CHATSERVICE_RUN1] });
    await expect(scopeFor(trace).noSpecViolations()).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(trace).soft().noSpecViolations()).resolves.toMatchObject({ pass: true });
  });

  it("fails noSpecViolations with the contract message and options table", async () => {
    const dirty = normalizeSessionTrace("s1", { id: "s1", calls: [VIOLATION_FOO, CHATSERVICE_RUN1] });
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
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [IGNORED_ENUM, CHATSERVICE_RUN1] });
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
      scopeFor(normalizeSessionTrace("s1", { id: "s1", calls: [CHATSERVICE_RUN1] })).noIgnoredFields(),
    ).resolves.toMatchObject({ pass: true });
  });

  it("includes spec status on the generated trace summary", () => {
    const trace = normalizeSessionTrace("s1", { id: "s1", calls: [CHATSERVICE_RUN1, VIOLATION_FOO, UNCHECKED] });
    const summary = formatTraceSummary(trace);
    expect(summary).toMatch(/spec=clean/);
    expect(summary).toMatch(/spec=1 violation/);
    expect(summary).toMatch(/spec=not checked/);
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
