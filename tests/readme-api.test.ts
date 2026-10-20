import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLlmentary, llmentary, Llmentary, LlmentaryQuery } from "../src/index.js";

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");

describe("README public API snippets", () => {
  it("documents the llmentary() factory and lm usage", () => {
    expect(readme).toContain('import { llmentary } from "llmentary/vitest"');
    expect(readme).toContain("const lm = llmentary();");
    expect(readme).toContain("lm.expect()");
    expect(readme).toContain("lm.query({ apiType: \"responses\", model: \"gpt-4.1-mini\" }).expect()");
    expect(readme).toContain("LlmentaryAssertionError");
  });

  it("does not document the removed pre-1.0 factory names", () => {
    const oldFactory = ["l", "ab"].join("");
    expect(readme).not.toMatch(new RegExp(`\\b${oldFactory}\\b`));
    expect(readme).not.toMatch(new RegExp(`\\bcreate${oldFactory[0].toUpperCase()}${oldFactory.slice(1)}\\b`));
    expect(readme).not.toContain("Renamed from");
  });

  it("matches the exported factory and facade types", () => {
    const lm = llmentary({
      proxyUrl: "http://127.0.0.1:9",
      controlUrl: "http://127.0.0.1:9",
      sessionId: "readme-snippet",
    });
    expect(lm).toBeInstanceOf(Llmentary);
    expect(createLlmentary).toBe(llmentary);
    expect(lm.baseURL).toBe("http://127.0.0.1:9/v1");
    expect(lm.openAI().baseURL).toBe("http://127.0.0.1:9/v1");
    expect(lm.query({ apiType: "responses" })).toBeInstanceOf(LlmentaryQuery);
    expect(typeof lm.expect().toolCalled).toBe("function");
    expect(typeof lm.expect().calledTimes).toBe("function");
  });
});
