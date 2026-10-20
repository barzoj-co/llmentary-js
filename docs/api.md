# llmentary TypeScript API

## Core concepts

- A **proxy** is the separate `llmentary` Go binary. It accepts OpenAI-compatible traffic, forwards to an upstream, and records calls in memory.
- A **session** is selected with `X-Test-Session` or W3C `baggage` key `llmentary.session.id`.
- The **control API** is read through `/sessions/{id}`, `/sessions/{id}/wait`, `DELETE /sessions/{id}`, `/sessions/{id}/otlp`, and `/healthz`.
- A **Session** is a per-test handle containing the session id, proxy base URL, headers, fetch helper, query scopes, cleanup, and assertions.

## Creating a session

```ts
import { llmentary } from "llmentary";

const lm = llmentary({
  proxyUrl: "http://127.0.0.1:4010",
  controlUrl: "http://127.0.0.1:4011",
  sessionId: "optional-fixed-id",
});
```

`llmentary()` returns a `Session`. `lm.query(...)` returns a `SessionQuery`. Defaults come from `LLMENTARY_PROXY_URL`, `LLMENTARY_CONTROL_URL`, and `LLMENTARY_BEARER_TOKEN` when present. Otherwise `proxyUrl` defaults to `http://127.0.0.1:4010`. Options use `SessionOptions`.

Important properties:

- `lm.sessionId`
- `lm.proxyUrl`
- `lm.controlUrl`
- `lm.baseURL` (`${proxyUrl}/v1`) for `openai-node`
- `lm.headers` with `x-test-session` and `baggage`
- `lm.fetch(input, init)` which injects the session headers
- `lm.openAI()` config for `new OpenAI(...)`
- `lm.vercelAI()` base URL/header config for Vercel AI SDK adapters

## Proxy lifecycle

```ts
import { startProxy } from "llmentary";

const proxy = await startProxy({
  upstreamBaseUrl: "https://api.openai.com/v1",
});

try {
  // run tests
} finally {
  await proxy.stop();
}
```

`startProxy()` attaches when `LLMENTARY_PROXY_URL` is set (`LLMENTARY_CONTROL_URL` for the separate control port). Control auth is `LLMENTARY_CONTROL_TOKEN` or `LLMENTARY_BEARER_TOKEN`. Empty env values are treated as unset. If no upstream is given, it defaults to `openai=https://api.openai.com` (or `OPENAI_BASE_URL` with a trailing `/v1` stripped). The Go binary prefixes the client request path (`/v1/chat/completions`, `/v1/responses`), so passing `https://api.openai.com/v1` would otherwise become `/v1/v1/...`.

When it starts a process, the binary is resolved as described in [binaries.md](binaries.md). The Go proxy CLI is:

```
llmentary -listen 127.0.0.1:7777 -control 127.0.0.1:7778 -upstream openai=https://api.openai.com
```

Equivalent env: `LLMENTARY_LISTEN`, `LLMENTARY_CONTROL_LISTEN`, `LLMENTARY_UPSTREAMS`, optional `LLMENTARY_CONTROL_TOKEN`. `/healthz` is on the control listener, not the proxy listener. OpenAI-compatible clients use `${proxyUrl}/v1`. Override with `args` or `LLMENTARY_PROXY_START_ARGS` if needed.

## Queries

```ts
lm.expect();
lm.query({ apiType: "chat_completions" }).expect();
lm.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect();
lm.query({ index: 1 }).expect();
```

`apiType` values mirror the Go client scoping:

- `chat_completions`
- `responses`

Other strings are accepted for passthrough/future API types. `index` is 0-based into the filtered call list (use it to assert on the second cached-token call rather than `some()` over the session).

OpenAI prefix caching is not guaranteed even for identical ≥1024-token prompts. The e2e suite therefore always asserts that the proxy’s recorded `cached_tokens` on call index 1 equals `usage.input_tokens_details.cached_tokens` (Chat Completions: `usage.prompt_tokens_details.cached_tokens`) in the raw upstream body. Chat Completions still requires a cache hit on a later call (up to 3 attempts). Responses retries the second call up to 3 times with a stable `prompt_cache_key`; if OpenAI returns no hit, the suite logs a warning / GitHub `::notice::` and does not fail.

## Assertions

All assertion methods wait for quiescence through `/sessions/{id}/wait` before evaluating.

```ts
await lm.expect().toolCalled("lookup_weather");
await lm.expect().notCalled("delete_user");
await lm.expect().calledTimes("lookup_weather", 1);
await lm.expect().argsSubset("lookup_weather", { city: "Amsterdam" });
await lm.expect().argsMatcher("lookup_weather", (args) => Boolean(args));
await lm.expect().order(["lookup_weather", "summarize_weather"]);
await lm.expect().parallelToolCalls(true);
await lm.expect().toolResultFedBack("lookup_weather");
await lm.expect().model("gpt-4.1-mini");
await lm.expect().requestParam("temperature", 0);
await lm.expect().finishReason("tool_calls");
await lm.expect().tokenBounds({ total: { min: 1, max: 200 } });
await lm.expect().latency({ max: 1_000 });
await lm.expect().ttft({ max: 500 });
await lm.expect().retries({ max: 1 });
await lm.expect().noRetries();
await lm.expect().noErrors();
await lm.expect().hasError(/rate limit/i);
await lm.expect().midStreamError();
await lm.expect().promptContains("weather");
await lm.expect().responseContains(/rain|sun/i);
await lm.expect().responseJsonValid({ schema: { type: "object" } });
await lm.expect().callCount(2);
await lm.expect().streamed(true);
await lm.expect().outputText();
await lm.expect().outputMatchesDeltas();
await lm.expect().streamedToolArgsJson("lookup_weather");
await lm.expect().outputJsonValid({ type: "object", required: ["city"] });
await lm.expect().usageDetails({ cachedTokens: { min: 0 }, reasoningTokens: { min: 0 } });
await lm.expect().errorStatus(400);
await lm.expect().errorType(/invalid_request/i);
await lm.expect().errorCode(/model/i);
await lm.expect().incomplete();
await lm.expect().rawRecorded();
```

Failures throw `SessionAssertionError`; its message appends the proxy trace summary when present, or a generated summary with call count, API type, model, tools, finish reasons, and error markers.

### Soft assertions

```ts
const result = await lm.expect().soft().toolCalled("lookup_weather");
if (!result.pass) {
  console.error(result.error?.message);
}
```

`lm.softExpect()` is equivalent to `lm.expect().soft()`.

## Runner integrations

### Vitest

Point Vitest `test.setupFiles` at a file that calls `setupVitest()`. Do not set `test.globalSetup` to `llmentary/vitest`: that config runs in a separate process, does not honor `beforeAll` / `expect.extend`, and would not pass proxy URLs to test workers.

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

```ts
// vitest.setup.ts
import { setupVitest } from "llmentary/vitest";

setupVitest();
```

`setupVitest()` starts a proxy for the test file unless `LLMENTARY_PROXY_URL` is already set, stops that owned proxy in `afterAll`, creates a fresh client before each test, and deletes the session after each test. The named `globalSetup()` export is a same-process helper that returns a teardown callback; it is not a Vitest `globalSetup` module. It also registers custom matchers:

```ts
import { llmentary } from "llmentary/vitest";

await expect(llmentary().expect()).toHaveToolCalled("lookup_weather");
await expect(llmentary().expect()).toHaveToolCalledTimes("lookup_weather", 1);
await expect(llmentary().expect()).toHaveRequestParam("temperature", 0);
```

### Jest

```js
module.exports = {
  testEnvironment: "node",
  globalSetup: "llmentary/jest/globalSetup",
  globalTeardown: "llmentary/jest/globalTeardown",
  setupFilesAfterEnv: ["llmentary/jest/setup"],
};
```

```js
const OpenAI = require("openai");
const { llmentary } = require("llmentary/jest");

test("uses the weather tool", async () => {
  const lm = llmentary();
  const openai = new OpenAI(lm.openAI());
  // make calls...
  await expect(lm.expect()).toHaveToolCalled("lookup_weather");
});
```

Jest `globalSetup` runs in a separate process, so workers cannot inherit its environment. The client writes a unique per-run state file under `os.tmpdir()/llmentary/jest/<runId>/state.json` with mode `0600` (owner-only) inside a `0700` directory, and a pointer at `.llmentary/jest-runs/<jestMainPid>` that contains only the run id. Control tokens are never written to disk. Concurrent Jest runs in the same directory get different run ids and must not attach to or kill each other's proxy. Teardown sends SIGTERM/SIGKILL only after verifying process identity (`LLMENTARY_INSTANCE_ID` plus a start-time sidecar), so a recycled PID is left alone.

## Control API client

```ts
import { ControlClient } from "llmentary";

const control = new ControlClient({ controlUrl: "http://127.0.0.1:4011" });
await control.health();
await control.wait("session-id", { timeout: 30, quiet: 0.5 });
// timeoutMs / idleMs still work (deprecated aliases of timeout / quiet)
await control.wait("session-id", { timeoutMs: 5_000, idleMs: 100 });
await control.getSession("session-id");
await control.getOtlp("session-id");
await control.deleteSession("session-id");
```

The raw JSON returned by the proxy is preserved on `SessionTrace.raw` and `CallRecord.raw`. The client maps the Go control schema (`api_family`, base64 `raw_request`/`raw_response`, `normalized.model` / `tool_calls` / `output_text` / `usage` / `error.mid_stream`) plus common snake_case/camelCase envelopes for assertion convenience without mutating the raw shape.

`wait` always sends `timeout` and `quiet` as Go duration strings (`30s`, `500ms`). Numbers on `timeout` / `quiet` are seconds. The deprecated `timeoutMs` / `idleMs` option names still work (milliseconds). Defaults and env names match the other clients: `30s` / `500ms`, `LLMENTARY_WAIT_TIMEOUT`, `LLMENTARY_WAIT_QUIET` (Go duration or bare seconds). The previous JS env names `LLMENTARY_WAIT_TIMEOUT_MS` / `LLMENTARY_WAIT_IDLE_MS` remain as deprecated aliases (milliseconds) and emit a one-time `DeprecationWarning`. A proxy 504 becomes `wait timed out after 30s on session X (k calls so far, still active: n). Raise LLMENTARY_WAIT_TIMEOUT …`. The client HTTP abort is `timeout + quiet + 5s` so it cannot fire before the proxy answers.
