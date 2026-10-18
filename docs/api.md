# llm-test-lab TypeScript API

## Core concepts

- A **proxy** is the separate `llmtestlab` Go binary. It accepts OpenAI-compatible traffic, forwards to an upstream, and records calls in memory.
- A **session** is selected with `X-Test-Session` or W3C `baggage` key `llmtestlab.session.id`.
- The **control API** is read through `/sessions/{id}`, `/sessions/{id}/wait`, `DELETE /sessions/{id}`, `/sessions/{id}/otlp`, and `/healthz`.
- A **lab** is a per-test facade containing the session id, proxy base URL, headers, fetch helper, query scopes, cleanup, and assertions.

## Creating a lab

```ts
import { createLab } from "llm-test-lab";

const lab = createLab({
  proxyUrl: "http://127.0.0.1:4010",
  controlUrl: "http://127.0.0.1:4010",
  sessionId: "optional-fixed-id",
});
```

`createLab()` defaults to `LLMTESTLAB_PROXY_URL`, `LLMTESTLAB_CONTROL_URL`, and `LLMTESTLAB_BEARER_TOKEN` when present. Otherwise `proxyUrl` defaults to `http://127.0.0.1:4010`.

Important properties:

- `lab.sessionId`
- `lab.proxyUrl`
- `lab.controlUrl`
- `lab.baseURL` (`${proxyUrl}/v1`) for `openai-node`
- `lab.headers` with `x-test-session` and `baggage`
- `lab.fetch(input, init)` which injects the session headers
- `lab.openAI()` config for `new OpenAI(...)`
- `lab.vercelAI()` base URL/header config for Vercel AI SDK adapters

## Proxy lifecycle

```ts
import { startProxy } from "llm-test-lab";

const proxy = await startProxy({
  upstreamBaseUrl: "https://api.openai.com/v1",
});

try {
  // run tests
} finally {
  await proxy.stop();
}
```

`startProxy()` attaches when `LLMTESTLAB_PROXY_URL` is set. Otherwise it resolves a binary from:

1. `LLMTESTLAB_BIN`
2. `PATH`
3. cache
4. GitHub Releases download

If the Go binary changes its CLI flags, pass `args` or set `LLMTESTLAB_PROXY_START_ARGS`. The default launcher tries common forms (`serve --listen`, `--listen`, `serve --proxy-addr`) and always health-checks `/healthz`.

## Queries

```ts
lab.expect();
lab.query({ apiType: "chat_completions" }).expect();
lab.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect();
```

`apiType` values mirror the Go client scoping:

- `chat_completions`
- `responses`

Other strings are accepted for passthrough/future API types.

## Assertions

All assertion methods wait for quiescence through `/sessions/{id}/wait` before evaluating.

```ts
await lab.expect().toolCalled("lookup_weather");
await lab.expect().notCalled("delete_user");
await lab.expect().calledTimes("lookup_weather", 1);
await lab.expect().argsSubset("lookup_weather", { city: "Amsterdam" });
await lab.expect().argsMatcher("lookup_weather", (args) => Boolean(args));
await lab.expect().order(["lookup_weather", "summarize_weather"]);
await lab.expect().parallelToolCalls(true);
await lab.expect().toolResultFedBack("lookup_weather");
await lab.expect().model("gpt-4.1-mini");
await lab.expect().requestParam("temperature", 0);
await lab.expect().finishReason("tool_calls");
await lab.expect().tokenBounds({ total: { min: 1, max: 200 } });
await lab.expect().latency({ max: 1_000 });
await lab.expect().ttft({ max: 500 });
await lab.expect().retries({ max: 1 });
await lab.expect().noRetries();
await lab.expect().noErrors();
await lab.expect().hasError(/rate limit/i);
await lab.expect().midStreamError();
await lab.expect().promptContains("weather");
await lab.expect().responseContains(/rain|sun/i);
await lab.expect().responseJsonValid({ schema: { type: "object" } });
```

Failures throw `LabAssertionError`; its message appends the proxy trace summary when present, or a generated summary with call count, API type, model, tools, finish reasons, and error markers.

### Soft assertions

```ts
const result = await lab.expect().soft().toolCalled("lookup_weather");
if (!result.pass) {
  console.error(result.error?.message);
}
```

`lab.softExpect()` is equivalent to `lab.expect().soft()`.

## Runner integrations

### Vitest

```ts
import { setupVitest, lab } from "llm-test-lab/vitest";

setupVitest();
```

`setupVitest()` starts one proxy for the worker process, creates a fresh lab before each test, and deletes the session after each test. It also registers custom matchers:

```ts
await expect(lab().expect()).toHaveToolCalled("lookup_weather");
await expect(lab().expect()).toHaveToolCalledTimes("lookup_weather", 1);
await expect(lab().expect()).toHaveRequestParam("temperature", 0);
```

### Jest

```js
module.exports = {
  testEnvironment: "node",
  globalSetup: "llm-test-lab/jest/globalSetup",
  globalTeardown: "llm-test-lab/jest/globalTeardown",
  setupFilesAfterEnv: ["llm-test-lab/jest/setup"],
};
```

Jest global setup persists proxy state in `.llm-test-lab/jest-state.json` so setup files and global teardown can share the proxy URL/PID.

## Control API client

```ts
import { ControlClient } from "llm-test-lab";

const control = new ControlClient({ controlUrl: "http://127.0.0.1:4010" });
await control.health();
await control.wait("session-id", { timeoutMs: 5_000, idleMs: 100 });
await control.getSession("session-id");
await control.getOtlp("session-id");
await control.deleteSession("session-id");
```

The raw JSON returned by the proxy is preserved on `SessionTrace.raw` and `CallRecord.raw`. The client normalizes common snake_case/camelCase envelopes for assertion convenience without mutating the raw shape.
