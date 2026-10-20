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

Node 18 or newer is required. npm installs an optional `@llmentary/<platform>` package with the matching proxy binary; set `LLMENTARY_BIN` to use a different binary. See [docs/binaries.md](docs/binaries.md).

## Quickstart

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

## Assertions

Use `lm.expect()` or a scoped query:

```ts
await lm.expect().toolCalled("lookup_weather");
await lm.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect().calledTimes("lookup_weather", 1);
```

Supported deterministic assertions include tool calls, call counts, argument subsets/predicates, order, parallel tool-call request params, tool-result feedback, model, request params, finish reason, token/latency/TTFT/retry bounds, usage details, stream/output helpers, errors, prompt/response text, and JSON schema validation. Failures throw `SessionAssertionError` with a trace summary. Use `.soft()` or `softExpect()` for non-throwing results.

See [docs/api.md](docs/api.md) for the full API, including Jest setup.

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
