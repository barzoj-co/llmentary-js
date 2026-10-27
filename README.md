# llmentary for JavaScript and TypeScript

[![CI](https://github.com/barzoj-co/llmentary-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/barzoj-co/llmentary-js/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/barzoj-co/llmentary-js/graph/badge.svg)](https://codecov.io/gh/barzoj-co/llmentary-js)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/barzoj-co/llmentary-js/badge)](https://scorecard.dev/viewer/?uri=github.com/barzoj-co/llmentary-js)
[![License: MIT](https://img.shields.io/github/license/barzoj-co/llmentary-js)](LICENSE)
[![npm](https://img.shields.io/npm/v/llmentary)](https://www.npmjs.com/package/llmentary)

Vitest and Jest client for [llmentary](https://github.com/barzoj-co/llmentary),
a recording proxy for testing LLM applications. Your test sends OpenAI SDK
requests through the proxy to the real provider, then asserts on what was
recorded: tools called and their arguments, call count, tokens, latency, errors.

Documentation: **https://barzoj-co.github.io/llmentary/**

## Install

```bash
npm install --save-dev llmentary openai vitest
```

llmentary runs on Node.js 18 or newer. The current `openai` package (v7)
requires Node.js 22; on an older Node.js, install `openai@6`.

Bundled proxy **v0.5.3** comes in an optional `@llmentary/<platform>` package
that npm installs for your platform. Set `LLMENTARY_BIN` to use another binary.

## Quickstart

Register the setup file in `vitest.config.ts`
(`test: { setupFiles: ["./vitest.setup.ts"] }`):

```ts
// vitest.setup.ts
import { setupVitest } from "llmentary/vitest";

setupVitest();
```

```ts
// weather.test.ts
import { test } from "vitest";
import OpenAI from "openai";
import { llmentary } from "llmentary/vitest";

test("the model calls the weather tool", async () => {
  const lm = llmentary();
  const openai = new OpenAI({ ...lm.openAI(), maxRetries: 0 });

  await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "What's the weather in Paris?" }],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    }],
    tool_choice: "required",
  });

  const check = lm.expect();
  await check.callCount(1);
  await check.toolCalled("get_weather", { argsSubset: { city: "Paris" } });
  await check.noErrors();
  await check.tokenBounds({ total: { max: 1000 } });
});
```

```console
$ OPENAI_API_KEY=sk-... npx vitest run
      Tests  1 passed (1)
```

`const lm = llmentary();` gives the test its own session. `lm.openAI()` returns
the base URL, session header and API key for the `OpenAI` constructor. A failed
check throws `SessionAssertionError` with the recorded calls. Jest setup is in
the [TypeScript getting-started guide](https://barzoj-co.github.io/llmentary/getting-started/typescript/#jest).

## What you can assert

- Tools: `toolCalled`, `notCalled`, `argsSubset`, `order`, `toolResultInPrompt`.
- Requests: `model`, `requestParam`, `promptContains`.
- Reliability: `callCount`, `noRetries`, `noErrors`, `aborted`.
- Budgets: `tokenBounds`, `latency`, `ttft`.
- Isolation between sessions: `isolatedFrom`
  ([rules](https://github.com/barzoj-co/llmentary/blob/main/docs/isolation-spec.md),
  [test vectors](testdata/isolation/)).

All assertions: [reference](https://barzoj-co.github.io/llmentary/reference/assertions/).
TypeScript API: [docs/api.md](docs/api.md).

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
