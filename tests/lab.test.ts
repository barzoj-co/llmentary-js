import { afterEach, describe, expect, it } from "vitest";
import { createLab } from "../src/lab.js";

describe("createLab env fallbacks", () => {
  const keys = [
    "LLMTESTLAB_PROXY_URL",
    "LLMTESTLAB_CONTROL_URL",
    "LLMTESTLAB_BEARER_TOKEN",
    "LLMTESTLAB_CONTROL_TOKEN",
  ] as const;
  const previous: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
      delete previous[key];
    }
  });

  function stash(key: (typeof keys)[number], value: string | undefined): void {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("falls through an empty bearer token to LLMTESTLAB_CONTROL_TOKEN", () => {
    stash("LLMTESTLAB_BEARER_TOKEN", "  ");
    stash("LLMTESTLAB_CONTROL_TOKEN", "control-secret");
    const lab = createLab({ proxyUrl: "http://127.0.0.1:4010" });
    expect(lab.bearerToken).toBe("control-secret");
  });
});
