const { createLlmentary, llmentary, sessionHeaders } = require("../../dist/cjs/index.js");

describe("CJS export", () => {
  test("creates session headers", () => {
    expect(sessionHeaders("session-1")).toEqual({
      "x-test-session": "session-1",
      baggage: "llmentary.session.id=session-1",
    });
  });

  test("creates an llmentary facade", () => {
    const lm = createLlmentary({
      proxyUrl: "http://127.0.0.1:9999",
      controlUrl: "http://127.0.0.1:9999",
      sessionId: "session-1",
    });
    expect(lm.baseURL).toBe("http://127.0.0.1:9999/v1");
    expect(lm.headers["x-test-session"]).toBe("session-1");
    expect(llmentary).toBe(createLlmentary);
  });
});
