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
  controlUrl: "http://127.0.0.1:4011",
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

`startProxy()` attaches when `LLMTESTLAB_PROXY_URL` is set (`LLMTESTLAB_CONTROL_URL` for the separate control port). Control auth is `LLMTESTLAB_CONTROL_TOKEN` or `LLMTESTLAB_BEARER_TOKEN`. Empty env values are treated as unset. If no upstream is given, it defaults to `openai=https://api.openai.com` (or `OPENAI_BASE_URL` with a trailing `/v1` stripped). The Go binary prefixes the client request path (`/v1/chat/completions`, `/v1/responses`), so passing `https://api.openai.com/v1` would otherwise become `/v1/v1/...`.

When it starts a process, the binary is resolved from:

1. `LLMTESTLAB_BIN`
2. optional dependency `@llm-test-lab/<os>-<cpu>`
3. `PATH`
4. cache

There is no install-time or runtime GitHub download. The Go proxy CLI is:

```
llmtestlab -listen 127.0.0.1:7777 -control 127.0.0.1:7778 -upstream openai=https://api.openai.com
```

Equivalent env: `LLMTESTLAB_LISTEN`, `LLMTESTLAB_CONTROL_LISTEN`, `LLMTESTLAB_UPSTREAMS`, optional `LLMTESTLAB_CONTROL_TOKEN`. `/healthz` is on the control listener, not the proxy listener. OpenAI-compatible clients use `${proxyUrl}/v1`. Override with `args` or `LLMTESTLAB_PROXY_START_ARGS` if needed.

## Queries

```ts
lab.expect();
lab.query({ apiType: "chat_completions" }).expect();
lab.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect();
lab.query({ index: 1 }).expect();
```

`apiType` values mirror the Go client scoping:

- `chat_completions`
- `responses`

Other strings are accepted for passthrough/future API types. `index` is 0-based into the filtered call list (use it to assert on the second cached-token call rather than `some()` over the session).

OpenAI prefix caching is not guaranteed even for identical ≥1024-token prompts. The e2e suite therefore always asserts that the proxy’s recorded `cached_tokens` on call index 1 equals `usage.input_tokens_details.cached_tokens` (Chat Completions: `usage.prompt_tokens_details.cached_tokens`) in the raw upstream body. Chat Completions still requires a cache hit on a later call (up to 3 attempts). Responses retries the second call up to 3 times with a stable `prompt_cache_key`; if OpenAI returns no hit, the suite logs a warning / GitHub `::notice::` and does not fail.

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
await lab.expect().callCount(2);
await lab.expect().streamed(true);
await lab.expect().outputText();
await lab.expect().outputMatchesDeltas();
await lab.expect().streamedToolArgsJson("lookup_weather");
await lab.expect().outputJsonValid({ type: "object", required: ["city"] });
await lab.expect().usageDetails({ cachedTokens: { min: 0 }, reasoningTokens: { min: 0 } });
await lab.expect().errorStatus(400);
await lab.expect().errorType(/invalid_request/i);
await lab.expect().errorCode(/model/i);
await lab.expect().incomplete();
await lab.expect().rawRecorded();
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

Point Vitest `test.setupFiles` at a file that calls `setupVitest()`. Do not set `test.globalSetup` to `llm-test-lab/vitest`: that config runs in a separate process, does not honor `beforeAll` / `expect.extend`, and would not pass proxy URLs to test workers.

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
import { setupVitest } from "llm-test-lab/vitest";

setupVitest();
```

`setupVitest()` starts a proxy for the test file unless `LLMTESTLAB_PROXY_URL` is already set, stops that owned proxy in `afterAll`, creates a fresh lab before each test, and deletes the session after each test. The named `globalSetup()` export is a same-process helper that returns a teardown callback; it is not a Vitest `globalSetup` module. It also registers custom matchers:

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

Jest `globalSetup` runs in a separate process, so workers cannot inherit its environment. The client writes a unique per-run state file under `os.tmpdir()/llm-test-lab/jest/<runId>/state.json` with mode `0600` (owner-only) inside a `0700` directory, and a pointer at `.llm-test-lab/jest-runs/<jestMainPid>` that contains only the run id. Control tokens are never written to disk. Concurrent Jest runs in the same directory get different run ids and must not attach to or kill each other's proxy. Teardown sends SIGTERM/SIGKILL only after verifying process identity (`LLMTESTLAB_INSTANCE_ID` plus a start-time sidecar), so a recycled PID is left alone.

## Control API client

```ts
import { ControlClient } from "llm-test-lab";

const control = new ControlClient({ controlUrl: "http://127.0.0.1:4011" });
await control.health();
await control.wait("session-id", { timeoutMs: 5_000, idleMs: 100 });
await control.getSession("session-id");
await control.getOtlp("session-id");
await control.deleteSession("session-id");
```

The raw JSON returned by the proxy is preserved on `SessionTrace.raw` and `CallRecord.raw`. The client maps the Go control schema (`api_family`, base64 `raw_request`/`raw_response`, `normalized.model` / `tool_calls` / `output_text` / `usage` / `error.mid_stream`) plus common snake_case/camelCase envelopes for assertion convenience without mutating the raw shape.
