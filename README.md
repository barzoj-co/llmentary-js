# llmentary

TypeScript (Vitest/Jest) client for llmentary: deterministic trace-based integration tests for LLM apps.

[![CI](https://github.com/barzoj-co/llmentary-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/barzoj-co/llmentary-js/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/barzoj-co/llmentary-js/graph/badge.svg)](https://codecov.io/gh/barzoj-co/llmentary-js)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/barzoj-co/llmentary-js/badge)](https://scorecard.dev/viewer/?uri=github.com/barzoj-co/llmentary-js)
[![License: MIT](https://img.shields.io/github/license/barzoj-co/llmentary-js)](LICENSE)
[![npm](https://img.shields.io/npm/v/llmentary)](https://www.npmjs.com/package/llmentary)

The client starts or attaches to the Go proxy, creates a unique test session per test, and routes OpenAI-compatible traffic through that session. After the proxy goes quiet it asserts against the recorded trace. There is no LLM judge: every check is deterministic.

## Install

```sh
npm install --save-dev llmentary
```

Node 18 or newer is required. npm installs an optional `@llmentary/<platform>` package pinned to proxy **v0.3.0**; set `LLMENTARY_BIN` to use a different binary. See [docs/binaries.md](docs/binaries.md).

## Quickstart

In-process (the test can set headers):

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

```ts
// example.test.ts
import OpenAI from "openai";
import { llmentary } from "llmentary/vitest";

test("uses the weather tool", async () => {
  const lm = llmentary();
  const openai = new OpenAI(lm.openAI());

  await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "Use the tool for Amsterdam weather." }],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "lookup_weather" } },
  });

  await lm.expect().toolCalled("lookup_weather", { argsSubset: { city: "Amsterdam" } });
});
```

Service under test cannot send headers (import-time / `OPENAI_BASE_URL` only). Set the env **before** the app is imported or constructed:

```ts
import { llmentary } from "llmentary";

const lm = llmentary();
process.env.OPENAI_BASE_URL = lm.pathBaseURL();
const { app } = await import("./app.js");
```

Black-box and sidecar recipes: [docs/black-box.md](https://github.com/barzoj-co/llmentary/blob/main/docs/black-box.md). Control API contract: [api/control/openapi.yaml](https://github.com/barzoj-co/llmentary/blob/main/api/control/openapi.yaml). When to assert on the trace vs the model's free text: [docs/assertions-guide.md](https://github.com/barzoj-co/llmentary/blob/main/docs/assertions-guide.md).

## Assertions

Use `lm.expect()` or a scoped query:

```ts
await lm.expect().toolCalled("lookup_weather");
await lm.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect().calledTimes("lookup_weather", 1);
const mark = await lm.mark();
await openai.chat.completions.create({ /* next turn */ });
await lm.expect({ since: mark }).callCount(1);
await lm.expect({ since: mark }).toolCalled("lookup_weather");
await lm.query({}).withoutTools().expect().callCount(1);
await lm.query({}).offersTool("lookup_weather").expect().toolCalled("lookup_weather");
// Empty filters fail noErrors()/notCalled() unless you opt out:
await lm.expect({ since: mark }).allowEmpty().noErrors();
await lm.expect().isolatedFrom(other);
await lm.expectNoCalls();
await lm.expect({ allowEmpty: true }).callCount(0);
```

Supported deterministic assertions include tool calls, call counts, argument subsets/predicates, order, parallel tool-call request params, tool-result feedback, model, request params, finish reason, token/latency/TTFT/retry bounds, usage details, stream/output helpers, errors, prompt/response text, JSON schema validation, spec-validation helpers (`noSpecViolations` / `noIgnoredFields`), offered-tool / turn filters (`offersTool`, `withoutTools`, `mark` / `since`), session isolation (`isolatedFrom`), zero-call helpers (`expectNoCalls`, `expect({ allowEmpty: true })`), and optional answer helpers (`mentionsAny`, `finalResponseMentionsAny`, `toolResultInPrompt`). A filter that matches zero calls fails `noErrors()` / `notCalled()` unless you call `allowEmpty()`; use `callCount(n)` for the turn size. Whole-session `expect()` on a never-created session stays strict unless you opt in. Failures throw `SessionAssertionError` with a trace summary. Use `.soft()` or `softExpect()` for non-throwing results; `await soft.check()` reports every collected failure. `listSessions()` and `proxyVersion()` read the control API. `lm.pathBaseURL()` is the `/s/{session}/v1` base for unmodified SDKs. Per-call `sessionSource` / `upstreamUrl` / `seq` / `sessionId` / `userTexts` read the proxy fields. Call `id`s are process-global; `seq` is 1-based per session. The generated summary prints `#seq (id)`.

See [docs/api.md](docs/api.md) for the full API, including Jest setup.

## Waiting for calls

`wait` (and every assertion) blocks until the session is quiet, then returns the recorded trace. The proxy reads only `timeout` and `quiet` as Go durations. All clients send those names.

| Parameter | Default | Meaning |
|---|---|---|
| `timeout` | `30s` | Give up if the session is still active |
| `quiet` | `500ms` | Return once no new call activity is seen for this long |
| `minCalls` | `0` | Return only after this many finished calls (and quiet) |

| Environment variable | Accepts | Default |
|---|---|---|
| `LLMENTARY_WAIT_TIMEOUT` | Go duration (`45s`) or bare seconds (`45`, `0.2`) | `30s` |
| `LLMENTARY_WAIT_QUIET` | Go duration (`200ms`) or bare seconds (`0.2`) | `500ms` |

A wait timeout is an error:

`wait timed out after 30s on session X (k calls so far, still active: n). Raise LLMENTARY_WAIT_TIMEOUT …`

`wait` on a session that was never created (or was `DELETE`d) is not a 200 empty trace:

| `minCalls` | Never-created session | Client error |
|---|---|---|
| `0` (default) | `404 session_not_found` immediately | `SessionNotFound` (same type as `GET /sessions/{id}`) |
| `>= 1` | wait until `timeout`, then `504 wait_timeout` | `WaitTimeoutError` |

```ts
import { SessionNotFound, WaitTimeoutError } from "llmentary";

try {
  await lm.wait({ minCalls: 0, quiet: "200ms" });
} catch (error) {
  if (error instanceof SessionNotFound) {
    // this session id was never created
  }
}

try {
  await lm.wait({ minCalls: 1, timeout: 3, quiet: "50ms" });
} catch (error) {
  if (error instanceof WaitTimeoutError) {
    // no call arrived in time (the session may still appear later)
  }
}
```

Whole-session `expect()` on a never-created session still fails with `no calls recorded for session …` (DOG-2). That catches a base URL that bypasses the proxy. Opt in with `await lm.expectNoCalls()` (`SessionNotFound` passes; a session with calls fails `expected 0 LLM calls, got N` plus the trace summary) or `await lm.expect({ allowEmpty: true }).callCount(0)`. Bundled proxy **v0.3.0** returns `404 session_not_found` immediately for `min_calls=0` on a never-created session. See [docs/assertions-guide.md](docs/assertions-guide.md).

## Isolating conversations

A path prefix (`lm.pathBaseURL()`) is chosen by whoever builds the SDK client. One process with one env-configured client is one session. For N parallel conversations use one of: (a) one worker process per session; (b) construct the SDK client per conversation with `baseURL=lm.pathBaseURL()`; (c) headers or baggage from the app; (d) run conversations sequentially with `DELETE` between them. A second bus worker needs its own topic or partition; two consumer groups on one topic both get every event.

Prove isolation with the helper, not substring search over request JSON (system prompts and tool names will false-positive):

```ts
const weather = llmentary({ sessionId: "weather" });
const barge = llmentary({ sessionId: "barge" });
const weatherClient = new OpenAI({ apiKey, baseURL: weather.pathBaseURL() });
const bargeClient = new OpenAI({ apiKey, baseURL: barge.pathBaseURL() });
// the same user prompt in both sessions is not a leak
await weather.expect().isolatedFrom(barge);
```

`isolatedFrom` follows the cross-language spec (DOG-29): session ids, overlapping call ids, and **foreign user turns** only (exact match after trim / collapse whitespace / casefold; never substring). Walk calls in `seq` order; inbound history is seen, not introduced. A user text both sessions sent themselves is not a leak. Options: `minChars` (default 8), `ignoreTexts`. System / developer prompts and tool definitions are not compared. An empty **this** session fails unless you call `allowEmpty()`; an empty other session is not a leak. Shared vectors: `testdata/isolation/` (copied from proxy [PR #35](https://github.com/barzoj-co/llmentary/pull/35)). See [docs/isolation-spec.md](https://github.com/barzoj-co/llmentary/blob/cursor/dog-29-isolation-spec-f2b6/docs/isolation-spec.md) and [docs/black-box.md](https://github.com/barzoj-co/llmentary/blob/main/docs/black-box.md).

## Testing interruptions / barge-in

A client cancel is a typed Call field (`clientAborted`, `abortPhase`), not only `normalized.client_aborted`. Older proxies still populate `clientAborted` from that nested alias. `abortPhase` is `before_headers` | `after_headers` and is **omitted** when the call is not aborted (a close after `[DONE]` / a terminal Responses event is not an abort). Bundled proxy 0.3.0 may still omit the top-level phase.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);
await client.chat.completions.create({ stream: true, /* … */ }, { signal: controller.signal }).catch(() => undefined);
const call = (await lm.wait({ minCalls: 1 })).calls[0];
expect(call?.clientAborted).toBe(true);
if (call?.abortPhase !== undefined) {
  expect(["before_headers", "after_headers"]).toContain(call.abortPhase);
}
expect(call?.httpStatus).not.toBe(502);
await lm.expect().aborted();
await lm.expect().finishReason("cancelled");
```

<!-- llmentary-repos:start -->
## llmentary repositories

| Repository | What | License |
|---|---|---|
| [llmentary](https://github.com/barzoj-co/llmentary) | Recording proxy binary (Go) | AGPL-3.0 |
| [llmentary-go](https://github.com/barzoj-co/llmentary-go) | Go client for `go test` | MIT |
| [llmentary-python](https://github.com/barzoj-co/llmentary-python) | Python client and pytest plugin | MIT |
| [llmentary-js](https://github.com/barzoj-co/llmentary-js) | TypeScript/JavaScript client for Vitest and Jest | MIT |
<!-- llmentary-repos:end -->

## License

Licensed under MIT, see LICENSE
