const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { llmentary, Session, sessionHeaders, contractPath } = require("../../dist/cjs/index.js");

const PACKAGE_ROOT = join(__dirname, "../..");

describe("CJS export", () => {
  test("creates session headers", () => {
    expect(sessionHeaders("session-1")).toEqual({
      "x-test-session": "session-1",
      baggage: "llmentary.session.id=session-1",
    });
  });

  test("creates a Session facade", () => {
    const lm = llmentary({
      proxyUrl: "http://127.0.0.1:9999",
      controlUrl: "http://127.0.0.1:9999",
      sessionId: "session-1",
    });
    expect(lm).toBeInstanceOf(Session);
    expect(lm.baseURL).toBe("http://127.0.0.1:9999/v1");
    expect(lm.pathBaseURL()).toBe("http://127.0.0.1:9999/s/session-1/v1");
    expect(lm.headers["x-test-session"]).toBe("session-1");
  });

  test("contractPath finds the package contract from CJS when cwd is empty", () => {
    const cwd = mkdtempSync(join(tmpdir(), "llmentary-cjs-contract-"));
    const packaged = join(PACKAGE_ROOT, "openapi.yaml");
    const prevCwd = process.cwd();
    const prevPath = process.env.LLMENTARY_OPENAPI_PATH;
    const prevBin = process.env.LLMENTARY_BIN;
    try {
      writeFileSync(packaged, "from-package: true\n");
      delete process.env.LLMENTARY_OPENAPI_PATH;
      delete process.env.LLMENTARY_BIN;
      process.chdir(cwd);
      expect(contractPath()).toBe(packaged);
    } finally {
      process.chdir(prevCwd);
      if (prevPath === undefined) delete process.env.LLMENTARY_OPENAPI_PATH;
      else process.env.LLMENTARY_OPENAPI_PATH = prevPath;
      if (prevBin === undefined) delete process.env.LLMENTARY_BIN;
      else process.env.LLMENTARY_BIN = prevBin;
      rmSync(packaged, { force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
