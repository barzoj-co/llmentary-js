import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { llmentary, Session, SessionQuery } from "../src/index.js";

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
const apiDoc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "api.md"), "utf8");

describe("README public API snippets", () => {
  it("keeps the README to the essentials", () => {
    expect(readme).toContain('import { llmentary } from "llmentary/vitest"');
    expect(readme).toContain("const lm = llmentary();");
    expect(readme).toContain("SessionAssertionError");
    expect(readme).toContain("testdata/isolation");
    expect(readme).toContain("v0.5.3");
    expect(readme).toContain("docs/api.md");
    expect(readme).toContain("https://barzoj-co.github.io/llmentary/");
  });

  it("documents the public API in docs/api.md", () => {
    expect(apiDoc).toContain("lm.expect()");
    expect(apiDoc).toContain('lm.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect()');
    expect(apiDoc).toContain("SessionAssertionError");
    expect(apiDoc).toContain("LLMENTARY_WAIT_TIMEOUT");
    expect(apiDoc).toContain("LLMENTARY_WAIT_QUIET");
    expect(apiDoc).toContain("`30s`");
    expect(apiDoc).toContain("`500ms`");
    expect(apiDoc).toContain("lm.pathBaseURL()");
    expect(apiDoc).toContain("OPENAI_BASE_URL");
    expect(apiDoc).toContain("docs/black-box.md");
    expect(apiDoc).toContain("offersTool");
    expect(apiDoc).toContain("withoutTools");
    expect(apiDoc).toContain("since");
    expect(apiDoc).toContain("callCount");
    expect(apiDoc).toContain("committed");
    expect(apiDoc).toContain("excludeAborted");
    expect(apiDoc).toContain("allowEmpty");
    expect(apiDoc).toContain("isolatedFrom");
    expect(apiDoc).toContain("expectNoCalls");
    expect(apiDoc).toContain("isolated_from needs calls on both sides");
    expect(apiDoc).toContain("later calls introduce");
    expect(apiDoc).not.toMatch(/isolatedFrom\(\s*unused\s*\)/);
    expect(apiDoc).toContain("clientAborted");
    expect(apiDoc).toContain("abortPhase");
    expect(apiDoc).toContain("noCancelled");
    expect(apiDoc).toContain("before_headers");
    expect(apiDoc).toContain("SessionNotFound");
    expect(apiDoc).toContain("WaitTimeoutError");
    expect(apiDoc).toContain("in_flight");
    expect(apiDoc).toContain("awaiting_headers");
    expect(apiDoc).toContain("openapi.yaml");
    expect(apiDoc).toContain("GET /openapi.yaml");
    expect(apiDoc).toContain("contractPath");
    expect(apiDoc).toContain("packagedMatchesServed");
    expect(apiDoc).not.toContain("github.com/barzoj-co/llmentary/blob/main/api/control/openapi.yaml");
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
    expect(typeof lm.query({}).allowEmpty).toBe("function");
    expect(typeof lm.query({}).committed).toBe("function");
    expect(typeof lm.query({}).aborted).toBe("function");
    expect(typeof lm.expect().allowEmpty).toBe("function");
    expect(typeof lm.expect().isolatedFrom).toBe("function");
    expect(typeof lm.expect().expectNoCalls).toBe("function");
    expect(typeof lm.expectNoCalls).toBe("function");
    expect(typeof lm.expect().aborted).toBe("function");
    expect(typeof lm.expect().noCancelled).toBe("function");
    expect(typeof lm.openapi).toBe("function");
    expect(typeof lm.control.openapi).toBe("function");
    expect(typeof lm.expect().finalResponseMentionsAny).toBe("function");
    expect(typeof lm.expect().toolResultInPrompt).toBe("function");
    expect(typeof lm.expect().soft().check).toBe("function");
  });
});
