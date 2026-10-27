import { describe, expect, it } from "vitest";
import { AssertionScope } from "../src/assertions.js";
import { normalizeSessionTrace } from "../src/normalize.js";
import type { JsonValue, QueryOptions, SessionTrace } from "../src/types.js";

const VENDOR_FIELD_REQUEST_INFO = {
  context: "request",
  pointer: "/vendor",
  kind: "vendor_field",
  severity: "info",
  action: "report_only",
  message: "vendor extra is ignored",
};

const COMPATIBLE_OPTIONAL_RESPONSE_INFO = {
  context: "response",
  pointer: "/compatible_optional",
  kind: "compatible_optional",
  severity: "info",
  action: "report_only",
  message: "compatible-only optional field is ignored",
};

const RESPONSE_SHAPE_RESPONSE_WARNING = {
  context: "response",
  pointer: "/response_shape",
  kind: "response_shape",
  severity: "warning",
  message: "response shape does not match the spec",
};

const NO_SEVERITY_REQUEST = {
  context: "request",
  pointer: "/legacy_drop",
  kind: "legacy_drop",
  message: "field dropped without a severity",
};

const DIRTY = {
  api_family: "openai.chat",
  normalized: {
    validation: { mode: "warn", profile: "relaxed", request_checked: true, response_checked: true },
    spec_violations: [],
    ignored_fields: [
      VENDOR_FIELD_REQUEST_INFO,
      COMPATIBLE_OPTIONAL_RESPONSE_INFO,
      RESPONSE_SHAPE_RESPONSE_WARNING,
      NO_SEVERITY_REQUEST,
    ],
  },
};

const CLEAN_RUN = {
  api_family: "openai.chat",
  normalized: {
    validation: { mode: "warn", profile: "relaxed", request_checked: true, response_checked: true },
    spec_violations: [],
    ignored_fields: [],
  },
};

function traceFor(calls: JsonValue[], id = "s1"): SessionTrace {
  return normalizeSessionTrace(id, { id, calls });
}

describe("noIgnoredFields severity and kind filters", () => {
  it("keeps the default behaviour: every entry is reported", async () => {
    const failed = await scopeFor(traceFor([DIRTY])).soft().noIgnoredFields();
    expect(failed.pass).toBe(false);
    const lines = failed.message.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("1 openai.chat request /vendor: vendor extra is ignored — vendor_field");
    expect(lines[1]).toBe(
      "1 openai.chat response /compatible_optional: compatible-only optional field is ignored — compatible_optional",
    );
    expect(lines[2]).toBe("1 openai.chat response /response_shape: response shape does not match the spec — response_shape");
    expect(lines[3]).toBe("1 openai.chat request /legacy_drop: field dropped without a severity — legacy_drop");
  });

  it("minSeverity warning keeps the warning entry and the entry without severity, drops info entries", async () => {
    const failed = await scopeFor(traceFor([DIRTY])).soft().noIgnoredFields({ minSeverity: "warning" });
    expect(failed.pass).toBe(false);
    const lines = failed.message.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("/response_shape");
    expect(lines[1]).toContain("/legacy_drop");
    expect(failed.message).not.toContain("/vendor");
    expect(failed.message).not.toContain("/compatible_optional");
  });

  it("minSeverity info keeps everything, minSeverity error drops everything but the entry without severity", async () => {
    await expect(scopeFor(traceFor([DIRTY])).noIgnoredFields({ minSeverity: "info" })).rejects.toThrow(/response_shape/);
    const strict = await scopeFor(traceFor([DIRTY])).soft().noIgnoredFields({ minSeverity: "error" });
    expect(strict.pass).toBe(false);
    expect(strict.message.split("\n")).toHaveLength(1);
    expect(strict.message).toContain("/legacy_drop");

    const allInfo = traceFor([
      {
        api_family: "openai.chat",
        normalized: {
          validation: { mode: "warn", request_checked: true, response_checked: true },
          spec_violations: [],
          ignored_fields: [VENDOR_FIELD_REQUEST_INFO, COMPATIBLE_OPTIONAL_RESPONSE_INFO],
        },
      },
    ]);
    await expect(scopeFor(allInfo).noIgnoredFields({ minSeverity: "warning" })).resolves.toMatchObject({
      pass: true,
      message: "no ignored fields",
    });
  });

  it("keeps entries whose severity is unknown (fail closed)", async () => {
    const unknown = traceFor([
      {
        api_family: "openai.chat",
        normalized: {
          validation: { mode: "warn", request_checked: true, response_checked: true },
          spec_violations: [],
          ignored_fields: [{ ...RESPONSE_SHAPE_RESPONSE_WARNING, severity: "critical" }],
        },
      },
    ]);
    const failed = await scopeFor(unknown).soft().noIgnoredFields({ minSeverity: "warning" });
    expect(failed.pass).toBe(false);
    expect(failed.message).toContain("/response_shape");
  });

  it("ignoreKinds behaves exactly like ignoreKeywords, and both combine as a union", async () => {
    const scope = scopeFor(traceFor([DIRTY]));
    const viaKinds = await scope.soft().noIgnoredFields({ ignoreKinds: ["vendor_field"] });
    const viaKeywords = await scope.soft().noIgnoredFields({ ignoreKeywords: ["vendor_field"] });
    expect(viaKinds.pass).toBe(false);
    expect(viaKinds.message).toBe(viaKeywords.message);
    expect(viaKinds.message.split("\n")).toHaveLength(3);
    expect(viaKinds.message).not.toContain("/vendor");

    const union = await scope.soft().noIgnoredFields({
      ignoreKeywords: ["vendor_field"],
      ignoreKinds: ["compatible_optional"],
    });
    expect(union.pass).toBe(false);
    expect(union.message.split("\n")).toHaveLength(2);
    expect(union.message).toContain("/response_shape");
    expect(union.message).toContain("/legacy_drop");

    await expect(
      scope.noIgnoredFields({
        ignoreKinds: ["vendor_field", "compatible_optional", "response_shape", "legacy_drop"],
      }),
    ).resolves.toMatchObject({ pass: true, message: "no ignored fields" });
  });

  it("combines with side", async () => {
    const scope = scopeFor(traceFor([DIRTY]));
    const requestWarnings = await scope.soft().noIgnoredFields({ side: "request", minSeverity: "warning" });
    expect(requestWarnings.pass).toBe(false);
    expect(requestWarnings.message.split("\n")).toHaveLength(1);
    expect(requestWarnings.message).toContain("/legacy_drop");

    const responseWarnings = await scope.soft().noIgnoredFields({ side: "response", minSeverity: "warning" });
    expect(responseWarnings.pass).toBe(false);
    expect(responseWarnings.message.split("\n")).toHaveLength(1);
    expect(responseWarnings.message).toContain("/response_shape");

    await expect(
      scope.noIgnoredFields({ side: "response", ignoreKinds: ["compatible_optional", "response_shape"] }),
    ).resolves.toMatchObject({ pass: true });

    const requestInfo = await scope.soft().noIgnoredFields({ side: "request", ignoreKinds: ["vendor_field"] });
    expect(requestInfo.pass).toBe(false);
    expect(requestInfo.message).toContain("/legacy_drop");
    expect(requestInfo.message).not.toContain("/vendor");
  });

  it("clean traces and other options are unchanged", async () => {
    await expect(scopeFor(traceFor([CLEAN_RUN])).noIgnoredFields()).resolves.toMatchObject({
      pass: true,
      message: "no ignored fields",
    });
    await expect(
      scopeFor(traceFor([DIRTY])).noIgnoredFields({
        ignorePaths: ["/vendor", "/compatible_optional", "/response_shape", "/legacy_drop"],
      }),
    ).resolves.toMatchObject({ pass: true });
    await expect(scopeFor(traceFor([CLEAN_RUN, DIRTY])).noIgnoredFields({ calls: [0] })).resolves.toMatchObject({
      pass: true,
    });
    const failed = await scopeFor(traceFor([CLEAN_RUN, DIRTY])).soft().noIgnoredFields({ calls: [1] });
    expect(failed.pass).toBe(false);
    expect(failed.message).toMatch(/^2 openai\.chat request \/vendor: /);
  });

  it("rejects an invalid minSeverity with a TypeError", async () => {
    const scope = scopeFor(traceFor([DIRTY]));
    await expect(scope.noIgnoredFields({ minSeverity: "critical" as never })).rejects.toBeInstanceOf(TypeError);
    await expect(scope.soft().noIgnoredFields({ minSeverity: "" as never })).rejects.toThrow(/minSeverity/);
    await expect(scopeFor(traceFor([DIRTY])).noSpecViolations({ minSeverity: "warn" as never })).rejects.toBeInstanceOf(
      TypeError,
    );
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
