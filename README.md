# llm-test-lab

TypeScript client for [`llm-test-lab`](https://github.com/barzoj-co/llm-test-lab): deterministic trace-based integration tests for LLM apps.

The client starts or attaches to the Go proxy, creates a unique test session per test, routes OpenAI-compatible traffic through the proxy, waits for quiescence, and asserts against the recorded trace. It is deterministic only: there is no LLM judge.

## Install

```sh
npm install --save-dev llm-test-lab
```

Node 18 or newer is required.

npm installs one optional platform package matching the current OS/CPU when it is published:

- `@llm-test-lab/linux-x64`
- `@llm-test-lab/linux-arm64`
- `@llm-test-lab/darwin-x64`
- `@llm-test-lab/darwin-arm64`
- `@llm-test-lab/win32-x64`

Those packages are version-pinned to the same version as this client and to the GoReleaser-built proxy binary. There is no `postinstall` download.

## Quickstart with Vitest

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

1. `LLMTESTLAB_BIN` (always wins)
2. optional dependency `@llm-test-lab/<os>-<cpu>/bin/llmtestlab`
3. `llmtestlab` or `llm-test-lab` on `PATH`
4. previously extracted cache under `~/.cache/llm-test-lab`

This package never downloads binaries during `npm install` or at runtime. CI builds the proxy from `barzoj-co/llm-test-lab` source. The release workflow copies GoReleaser artifacts into the optional packages after verifying `checksums.txt` SHA-256.

Use `LLMTESTLAB_PROXY_URL` (and `LLMTESTLAB_CONTROL_URL` — control listens on a separate port) to attach to an already-running proxy instead of starting a process. When this client starts the binary it passes `-listen`, `-control`, and `-upstream name=url`. Trailing `/v1` is stripped from the upstream URL because the Go process prefixes the client path (`/v1/chat/completions`). Empty `LLMTESTLAB_UPSTREAM_BASE_URL` / `OPENAI_BASE_URL` values fall through to `https://api.openai.com`.

## Release / trusted publishing

Tags matching `v*` run `.github/workflows/release.yml`. That workflow:

1. Builds this client
2. Downloads GoReleaser assets for the same tag from `barzoj-co/llm-test-lab`
3. Verifies each archive against `checksums.txt`
4. Writes the binary into `@llm-test-lab/<platform>`
5. Pins root and platform `package.json` versions to the tag
6. Dry-runs npm pack/publish with provenance

It is prepared for npm trusted publishing (`id-token: write` + `registry-url`). It does **not** publish yet. When publishing is enabled, publish the five platform packages first, then `llm-test-lab`, all at the Go binary version.

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

- `LLMTESTLAB_REPO_TOKEN`: a GitHub token that can read the private `barzoj-co/llm-test-lab` repo so CI can run `go build ./cmd/llmtestlab`. Remove this secret/workflow usage once that repo is public.
- `OPENAI_API_KEY`: required for real OpenAI E2E tests on same-repo PRs and pushes. Fork PRs skip private-binary checkout and this E2E step because secrets are unavailable.

## License

This TypeScript client library, including the npm package metadata, is MIT licensed; see [LICENSE](LICENSE).

The bundled `llm-test-lab` proxy binary (the optional `@llm-test-lab/<platform>` packages, or a binary you point at with `LLMTESTLAB_BIN`) is AGPL-3.0 licensed and runs as a separate process. Those packages ship [LICENSE.AGPL-3.0](licenses/AGPL-3.0.txt) next to the MIT wrapper license. Corresponding source for a packed binary is the Git tag matching the package version of https://github.com/barzoj-co/llm-test-lab. The MIT client talks to that process over HTTP; it does not statically link it.
