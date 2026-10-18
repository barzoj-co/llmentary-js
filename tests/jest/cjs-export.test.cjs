const { createLab, sessionHeaders } = require("../../dist/cjs/index.js");

describe("CJS export", () => {
  test("creates session headers", () => {
    expect(sessionHeaders("session-1")).toEqual({
      "x-test-session": "session-1",
      baggage: "llmtestlab.session.id=session-1",
    });
  });

  test("creates a lab facade", () => {
    const lab = createLab({
      proxyUrl: "http://127.0.0.1:9999",
      controlUrl: "http://127.0.0.1:9999",
      sessionId: "session-1",
    });
    expect(lab.baseURL).toBe("http://127.0.0.1:9999/v1");
    expect(lab.headers["x-test-session"]).toBe("session-1");
  });
});
