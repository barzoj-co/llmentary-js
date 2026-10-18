# llm-test-lab

TypeScript client for [`llm-test-lab`](https://github.com/barzoj-co/llm-test-lab): deterministic trace-based integration tests for LLM apps.

The client starts or attaches to the Go proxy, creates a unique test session per test, routes OpenAI-compatible traffic through the proxy, waits for quiescence, and asserts against the recorded trace. It is deterministic only: there is no LLM judge.

## Install

```sh
npm install --save-dev llm-test-lab
```

Node 18 or newer is required.

## Quickstart with Vitest

```ts
// vitest.setup.ts
import { setupVitest } from "llm-test-lab/vitest";

setupVitest();
```

```ts
// example.test.ts
import OpenAI from "openai";
import { lab } from "llm-test-lab/vitest";

test("uses the weather tool", async () => {
  const l = lab();
  const openai = new OpenAI(l.openAI());

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

  await l.expect().toolCalled("lookup_weather", { argsSubset: { city: "Amsterdam" } });
});
```

## Quickstart with Jest

```js
// jest.config.cjs
module.exports = {
  testEnvironment: "node",
  globalSetup: "llm-test-lab/jest/globalSetup",
  globalTeardown: "llm-test-lab/jest/globalTeardown",
  setupFilesAfterEnv: ["llm-test-lab/jest/setup"],
};
```

```js
const OpenAI = require("openai");
const { lab } = require("llm-test-lab/jest");

test("uses the weather tool", async () => {
  const l = lab();
  const openai = new OpenAI(l.openAI());
  // make calls...
  await expect(l.expect()).toHaveToolCalled("lookup_weather");
});
```

## Binary management

Resolution order:

1. `LLMTESTLAB_BIN`
2. `llmtestlab` or `llm-test-lab` on `PATH`
3. cached release binary under `~/.cache/llm-test-lab`
4. optional GitHub Releases download from `barzoj-co/llm-test-lab`

The upstream proxy repository is private today. If release download receives a 401/403/404, the client fails clearly and asks you to set `LLMTESTLAB_BIN` or provide `LLMTESTLAB_GITHUB_TOKEN`/`GITHUB_TOKEN` with release access. Downloaded archives are checked against a GoReleaser `checksums.txt` asset when present.

Use `LLMTESTLAB_PROXY_URL` to attach to an already-running proxy instead of starting a process.

## Assertions

Use `lab.expect()` or scoped queries:

```ts
await lab.expect().toolCalled("lookup_weather");
await lab.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect().calledTimes("lookup_weather", 1);
```

Supported deterministic assertions include tool calls, call counts, argument subsets/predicates, order, parallel tool-call request params, tool-result feedback, model, request params, finish reason, token/latency/TTFT/retry bounds, errors, prompt/response text, and JSON schema validation. Failures throw `LabAssertionError` with a trace summary. Use `.soft()` or `softExpect()` for non-throwing results.

See [docs/api.md](docs/api.md) for the full API.

## CI secrets

The included CI workflow expects:

- `LLMTESTLAB_REPO_TOKEN`: a GitHub token that can read the private `barzoj-co/llm-test-lab` repo so CI can run `go build ./cmd/llmtestlab`.
- `OPENAI_API_KEY`: required for real OpenAI E2E tests on same-repo PRs and pushes. Fork PRs skip only this E2E step because secrets are unavailable.
- npm release: either `NPM_TOKEN` or trusted publishing configured for provenance on `v*` tags.

## License

This TypeScript client library is MIT licensed; see [LICENSE](LICENSE).

The `llm-test-lab` proxy binary that this client starts or talks to is AGPL-3.0 licensed and runs as a separate process.
