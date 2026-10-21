import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { llmentary, Session, SessionQuery } from "../src/index.js";

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");

describe("README public API snippets", () => {
  it("documents the llmentary() factory and lm usage", () => {
    expect(readme).toContain('import { llmentary } from "llmentary/vitest"');
    expect(readme).toContain("const lm = llmentary();");
    expect(readme).toContain("lm.expect()");
    expect(readme).toContain('lm.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect()');
    expect(readme).toContain("SessionAssertionError");
    expect(readme).toContain("## Waiting for calls");
    expect(readme).toContain("LLMENTARY_WAIT_TIMEOUT");
    expect(readme).toContain("LLMENTARY_WAIT_QUIET");
    expect(readme).toContain("`30s`");
    expect(readme).toContain("`500ms`");
    expect(readme).toContain("lm.pathBaseURL()");
    expect(readme).toContain("OPENAI_BASE_URL");
    expect(readme).toContain("docs/black-box.md");
    expect(readme).toContain("docs/assertions-guide.md");
    expect(readme).toContain("offersTool");
    expect(readme).toContain("withoutTools");
    expect(readme).toContain("since");
    expect(readme).toContain("callCount");
    expect(readme).toContain("allowEmpty");
    expect(readme).toContain("v0.2.0");
  });

  it("does not document removed factory or handle names", () => {
    const oldFactory = ["l", "ab"].join("");
    const oldCreate = "create" + oldFactory.charAt(0).toUpperCase() + oldFactory.slice(1);
    const oldHandle = ["Llm", "entary"].join("");
    expect(readme).not.toMatch(new RegExp(`\\b${oldFactory}\\b`));
    expect(readme).not.toMatch(new RegExp(`\\b${oldCreate}\\b`));
    expect(readme).not.toMatch(new RegExp(`\\b${oldHandle}\\b`));
    expect(readme).not.toContain("Renamed from");
  });

  it("matches the exported factory and Session types", () => {
    const lm = llmentary({
      proxyUrl: "http://127.0.0.1:9",
      controlUrl: "http://127.0.0.1:9",
      sessionId: "readme-snippet",
    });
    expect(lm).toBeInstanceOf(Session);
    expect(lm.baseURL).toBe("http://127.0.0.1:9/v1");
    expect(lm.openAI().baseURL).toBe("http://127.0.0.1:9/v1");
    expect(lm.query({ apiType: "responses" })).toBeInstanceOf(SessionQuery);
    expect(typeof lm.expect().toolCalled).toBe("function");
    expect(typeof lm.expect().calledTimes).toBe("function");
    expect(lm.pathBaseURL()).toBe("http://127.0.0.1:9/s/readme-snippet/v1");
    expect(typeof lm.mark).toBe("function");
    expect(typeof lm.query({}).offersTool).toBe("function");
    expect(typeof lm.query({}).withoutTools).toBe("function");
    expect(typeof lm.expect().finalResponseMentionsAny).toBe("function");
    expect(typeof lm.expect().toolResultInPrompt).toBe("function");
    expect(typeof lm.expect().soft().check).toBe("function");
  });
});
