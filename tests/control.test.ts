import { describe, expect, it } from "vitest";
import { parseControlBody } from "../src/control.js";

describe("parseControlBody", () => {
  it("accepts the Go proxy plain-text healthz body", () => {
    expect(parseControlBody("ok\n")).toBe("ok");
  });

  it("parses JSON session payloads", () => {
    expect(parseControlBody('{"id":"s1","calls":[]}')).toEqual({ id: "s1", calls: [] });
  });
});
