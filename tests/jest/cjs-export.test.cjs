const { llmentary, Session, sessionHeaders } = require("../../dist/cjs/index.js");

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
});
