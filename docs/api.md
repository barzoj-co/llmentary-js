# llmentary TypeScript API

## Core concepts

- A **proxy** is the separate `llmentary` Go binary. It accepts OpenAI-compatible traffic, forwards to an upstream, and records calls in memory.
- A **session** is selected with `X-Test-Session`, W3C `baggage` key `llmentary.session.id`, or the path prefix `/s/{session}/` (see `lm.pathBaseURL()`).
- The **control API** is read through `/sessions`, `/sessions/{id}`, `/sessions/{id}/wait`, `DELETE /sessions/{id}`, `/sessions/{id}/otlp`, `/healthz`, and `/config`. Machine-readable contract: [api/control/openapi.yaml](https://github.com/barzoj-co/llmentary/blob/main/api/control/openapi.yaml) (also `GET /openapi.yaml` on the control listener in proxy releases that serve it).
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
- `lm.pathBaseURL()` (`${proxyUrl}/s/{session}/v1`) and `lm.pathBaseURL("openrouter")` (`${proxyUrl}/s/{session}/u/openrouter`) for unmodified / import-time clients
- `lm.headers` with `x-test-session` and `baggage`
- `lm.fetch(input, init)` which injects the session headers
- `lm.openAI()` config for `new OpenAI(...)`
- `lm.vercelAI()` base URL/header config for Vercel AI SDK adapters
- Per-call `clientAborted` / `abortPhase` (`before_headers` | `after_headers`) for barge-in. Top-level fields win; older proxies fall back to `normalized.client_aborted`. `await lm.expect().aborted()` asserts at least one call was cancelled.

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

`startProxy()` attaches when `LLMENTARY_PROXY_URL` is set (`LLMENTARY_CONTROL_URL` for the separate control port). Control auth is `LLMENTARY_CONTROL_TOKEN` or `LLMENTARY_BEARER_TOKEN`. Empty env values are treated as unset. If no upstream is given, the client omits `-upstream` and the proxy defaults to `openai=https://api.openai.com/v1`. Upstream URLs are passed through unchanged: the proxy owns the overlap join so `/v1` + `/v1/chat/completions` does not become `/v1/v1`. `OPENAI_BASE_URL` is not used as the upstream (it is the app's client base, often the proxy itself). Set `LLMENTARY_UPSTREAM_BASE_URL` or `upstreams` / `upstreamBaseUrl` when you need a non-default provider. If `OPENAI_BASE_URL` points at a llmentary proxy, the client warns.

When it starts a process, the binary is resolved as described in [binaries.md](binaries.md). The Go proxy CLI is:

```
llmentary -listen 127.0.0.1:7777 -control 127.0.0.1:7778
# optional: -upstream openai=https://api.openai.com/v1
```

Equivalent env: `LLMENTARY_LISTEN`, `LLMENTARY_CONTROL_LISTEN`, `LLMENTARY_UPSTREAMS`, optional `LLMENTARY_CONTROL_TOKEN`. `/healthz` is on the control listener, not the proxy listener. OpenAI-compatible clients use `${proxyUrl}/v1`. Override with `args` or `LLMENTARY_PROXY_START_ARGS` if needed.

## Queries

```ts
lm.expect();
lm.query({ apiType: "chat_completions" }).expect();
lm.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect();
lm.query({ index: 1 }).expect();
lm.query({}).offersTool("lookup_weather").expect();
lm.query({}).withoutTools().expect();
const mark = await lm.mark();
lm.expect({ since: mark });
lm.query({}).since(mark).expect();
```

`offersTool(name)` keeps calls whose **request** offered that tool. `withoutTools()` keeps calls that offered none (structured-output routers). `await lm.mark()` is the current call count. `since: mark` keeps calls with `seq >= mark` (`mark()` is 0-based into the session list; wire `seq` is 1-based). Call `id`s (`call_3`) are unique within one proxy process and are **not** per-session order. Use `CallRecord.seq` for "nth call of this session". The generated summary prints `#seq (id)` (for example `#1 (call_3)`). Per-call `promptText` / `responseText` fill the same role as Python `prompt_text` / `response_text`. `sessionSource`, `upstreamUrl`, `sessionId`, and `userTexts` are typed accessors for the proxy's `session_source`, `upstream.url`, `session_id`, and joined text for each user-role message (absent when the proxy omitted them).

### Filters and empty traces

A filtered or `since` expectation that matches **zero** calls fails `noErrors()` / `notCalled()` with `no calls matched query (withoutTools, since=3)` plus the trace summary. That stops "the router had no errors" from going green when the router never ran. Opt out with `allowEmpty()` (Go `AllowEmpty()`):

```ts
lm.query({}).since(mark).allowEmpty().expect().noErrors();
lm.expect({ since: mark }).allowEmpty().notCalled("lookup_weather");
```

Unfiltered `expect()` on a session with zero calls still fails with `no calls recorded for session …` (DOG-2), including `callCount(0)`. Opt in with `expect({ allowEmpty: true })`, `allowEmpty()`, or `expectNoCalls()`. A filtered `callCount(0)` still states an explicit empty count and does not need the opt-out.

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
await lm.expectNoCalls();
await lm.expect({ allowEmpty: true }).callCount(0);
await lm.expect().isolatedFrom(other);
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
await lm.expect().noSpecViolations();
await lm.expect().noIgnoredFields({ ignorePaths: ["/foo"] });
await lm.expect().finalResponseMentionsAny(["20", "sunny"]);
await lm.expect().toolResultInPrompt("lookup_weather");
```

`mentionsAny(text, candidates, { normalizeNumbers, casefold })` is a plain function for answers that come from the app API rather than the trace. Numeric candidates match as whole numbers (`20` does not match `2025`). `finalResponseMentionsAny` runs the same check on the last recorded assistant `output_text` (honours `since`); it does not scan response metadata. `toolResultInPrompt(name, expected?)` requires the **next** request after that tool call to include that call's result content (matching `id`). Pass `expected` (string or `RegExp`) to match the result text. Stronger than `toolResultFedBack`, which only checks that some later request has a tool-role / `function_call_output` message with a matching id.

`noSpecViolations` / `noIgnoredFields` read `normalized.validation`, `normalized.spec_violations`, and `normalized.ignored_fields`. An empty `[]` is clean; a missing field means validation was not run (failure unless `allowUnvalidated: true`). Options: `side`, `calls` (0-based indices or call ids), `ignorePaths`, `ignoreKeywords`. Failure lines look like `<call#> <api_family> <side> <path>: <message> — <hint>`. Vitest/Jest matchers: `toHaveNoSpecViolations()`, `toHaveNoIgnoredFields()`. Per-call accessors are `call.validation`, `call.specViolations`, `call.ignoredFields`; the trace has `trace.specViolations()` / `trace.ignoredFields()`. Each line of the generated summary includes `spec=clean` (0 findings after validation ran; this is not a guarantee that both request and response were checked), `spec=request_only` (request checked and response not checked), `spec=N violation(s)`, `spec=not checked`, or `spec=skipped:<reason>` (singular `spec=1 violation`). `http=` is omitted when the status is 0 or absent (before-headers abort). `call.httpStatus` is `undefined` for 0.

| Field | Meaning |
|---|---|
| `validation` | Metadata: was the call checked, which profile/mode, spec SHA. Not a finding. |
| `spec_violations` | Findings. `[]` is clean; omitted means not checked. |
| `ignored_fields` | Vendor extensions / dropped fields with `severity:"warning"`. Same empty-vs-absent rule. |

Expect helpers on a session with zero calls fail with `no calls recorded for session <id>; known sessions: …` plus the trace summary (`known sessions:` appears at most once; the proxy 404 hint is `list sessions with GET /sessions`). `GET /sessions/{id}` 404 raises `SessionNotFound`. `wait` on a never-created session with `minCalls=0` also raises `SessionNotFound` (`404 session_not_found`). `wait` with `minCalls>=1` on a session that never appears raises `WaitTimeoutError` (`504 wait_timeout`) after `timeout`. `expectNoCalls()` treats that `SessionNotFound` as success. `expect({ allowEmpty: true }).callCount(0)` does the same. Whole-session `expect().callCount(0)` without the opt-in still fails (DOG-2). `isolatedFrom(neverCreated)` raises an assertion error (`no calls recorded for session <id>`), not `SessionNotFound`; `allowEmpty()` lets it pass.

```ts
import { SessionNotFound, WaitTimeoutError } from "llmentary";

try {
  await lm.wait({ minCalls: 0, quiet: "200ms" });
} catch (error) {
  if (error instanceof SessionNotFound) {
    // never created (or DELETE'd)
  }
}
try {
  await lm.wait({ minCalls: 1, timeout: 3, quiet: "50ms" });
} catch (error) {
  if (error instanceof WaitTimeoutError) {
    // no call arrived in time
  }
}
```

`isolatedFrom(other)` (`other`: a `Session` or session id) follows the DOG-29 spec: every call has `sessionId == lm.sessionId`, no call id appears in both sessions, and no **foreign** user-role turn appears (a user message this session never introduced — last user-role message of each call — but the other session did). Comparison is exact after trim / collapse whitespace / casefold; never substring. The same canned question on both sides passes. Options: `minChars` (default 8), `ignoreTexts`, `{ requirePathSource: true }`. System / developer prompts, instructions, and tool definitions are not compared. Empty sessions fail unless `allowEmpty()` (or `{ allowEmpty: true }`). `allowEmpty()` also hides a mistyped `other` session id (wait then sees zero calls). Per-call user texts are `call.userTexts`. Shared vectors live in `testdata/isolation/`. A path prefix isolates client processes, not conversations: one env-configured SDK client is one session. For N conversations, use one process per session, construct a client with `lm.pathBaseURL()`, set headers/baggage, or `DELETE` between sequential runs. See [docs/black-box.md](https://github.com/barzoj-co/llmentary/blob/main/docs/black-box.md).

Failures throw `SessionAssertionError`; its message appends the proxy trace summary when present, or a generated summary with call count, API type, model, tools, optional `finish=` (omitted when there is no finish reason), optional `src=` / `tokens=`, and error markers. Unparsed calls (no request and no response) print `unparsed call, keys=[…]` instead of a key dump on every plain answer.

### Soft assertions

```ts
const result = await lm.expect().soft().toolCalled("lookup_weather");
if (!result.pass) {
  console.error(result.error?.message);
}
```

`lm.softExpect()` is equivalent to `lm.expect().soft()`. Soft results stay non-throwing; `await soft.check()` throws one `SessionAssertionError` that lists every collected failure, then appends the trace summary **once**.

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
await control.getConfig(); // includes proxy version
await control.listSessions();
await control.wait("session-id", { timeout: 30, quiet: 0.5, minCalls: 2 });
// timeoutMs / idleMs still work (deprecated aliases of timeout / quiet)
await control.wait("session-id", { timeoutMs: 5_000, idleMs: 100 });
await control.getSession("session-id"); // SessionNotFound on 404
await control.wait("ghost", { minCalls: 0 }); // SessionNotFound on 404
await control.wait("ghost", { minCalls: 1, timeout: 3 }); // WaitTimeoutError on 504
await control.getOtlp("session-id");
await control.deleteSession("session-id");
```

`lm.listSessions()`, `lm.config()`, and `lm.proxyVersion()` are the same control calls on a `Session`.

The raw JSON returned by the proxy is preserved on `SessionTrace.raw` and `CallRecord.raw`. The client maps the Go control schema (`api_family`, base64 `raw_request`/`raw_response`, `normalized.model` / `tool_calls` / `output_text` / `usage` / `error.mid_stream`) plus common snake_case/camelCase envelopes for assertion convenience without mutating the raw shape.

`wait` always sends `timeout` and `quiet` as Go duration strings (`30s`, `500ms`). `minCalls` is sent as `min_calls` when set. Numbers on `timeout` / `quiet` are seconds. The deprecated `timeoutMs` / `idleMs` option names still work (milliseconds). Defaults and env names match the other clients: `30s` / `500ms`, `LLMENTARY_WAIT_TIMEOUT`, `LLMENTARY_WAIT_QUIET` (Go duration or bare seconds). The previous JS env names `LLMENTARY_WAIT_TIMEOUT_MS` / `LLMENTARY_WAIT_IDLE_MS` remain as deprecated aliases (milliseconds) and emit a one-time `DeprecationWarning`. A proxy 504 becomes `WaitTimeoutError`: `wait timed out after 30s on session X (k calls so far, still active: n). Raise LLMENTARY_WAIT_TIMEOUT …`. A proxy 404 on `/sessions/{id}` or `/sessions/{id}/wait` becomes `SessionNotFound` (`session_not_found`). The client HTTP abort is `timeout + quiet + 5s` so it cannot fire before the proxy answers.
