# llmentary

[![CI](https://github.com/barzoj-co/llmentary-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/barzoj-co/llmentary-js/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/barzoj-co/llmentary-js/graph/badge.svg)](https://codecov.io/gh/barzoj-co/llmentary-js)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/barzoj-co/llmentary-js/badge)](https://scorecard.dev/viewer/?uri=github.com/barzoj-co/llmentary-js)
[![License: MIT](https://img.shields.io/github/license/barzoj-co/llmentary-js)](LICENSE)
[![npm](https://img.shields.io/npm/v/llmentary)](https://www.npmjs.com/package/llmentary)

TypeScript (Vitest/Jest) client for llmentary: deterministic trace-based integration tests for LLM apps.

Renamed from llm-test-lab (pre-release).

The client starts or attaches to the Go proxy, creates a unique test session per test, routes OpenAI-compatible traffic through the proxy, waits for quiescence, and asserts against the recorded trace. It is deterministic only: there is no LLM judge.

<!-- llmentary-repos:start -->
## llmentary repositories

| Repository | What | License |
|---|---|---|
| [llmentary](https://github.com/barzoj-co/llmentary) | Recording proxy binary (Go) | AGPL-3.0 |
| [llmentary-go](https://github.com/barzoj-co/llmentary-go) | Go client for `go test` | MIT |
| [llmentary-python](https://github.com/barzoj-co/llmentary-python) | Python client and pytest plugin | MIT |
| [llmentary-js](https://github.com/barzoj-co/llmentary-js) | TypeScript/JavaScript client for Vitest and Jest | MIT |
<!-- llmentary-repos:end -->

## Install

```sh
npm install --save-dev llmentary
```

Node 18 or newer is required.

npm installs one optional platform package matching the current OS/CPU when it is published:

- `@llmentary/linux-x64`
- `@llmentary/linux-arm64`
- `@llmentary/darwin-x64`
- `@llmentary/darwin-arm64`
- `@llmentary/win32-x64`

Those packages are version-pinned to the bundled proxy release in `PROXY_VERSION`. This client has its own semver; `optionalDependencies` pins the matching platform packages. There is no `postinstall` download.

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
import { setupVitest } from "llmentary/vitest";

setupVitest();
```

```ts
// example.test.ts
import OpenAI from "openai";
import { lab } from "llmentary/vitest";

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
  globalSetup: "llmentary/jest/globalSetup",
  globalTeardown: "llmentary/jest/globalTeardown",
  setupFilesAfterEnv: ["llmentary/jest/setup"],
};
```

Jest `globalSetup` writes owner-only (`0600`) per-run state in a unique `0700` temp directory and a run-id pointer under `.llmentary/jest-runs/`. Control tokens are not persisted, concurrent Jest runs do not share or kill each other's proxy, and teardown verifies process identity before sending signals.

```js
const OpenAI = require("openai");
const { lab } = require("llmentary/jest");

test("uses the weather tool", async () => {
  const l = lab();
  const openai = new OpenAI(l.openAI());
  // make calls...
  await expect(l.expect()).toHaveToolCalled("lookup_weather");
});
```

## Binary management

Resolution order:

1. `LLMENTARY_BIN` (always wins)
2. optional dependency `@llmentary/<os>-<cpu>/bin/llmentary`
3. `llmentary` on `PATH`
4. previously extracted cache under `~/.cache/llmentary`

This package never downloads binaries during `npm install` or at runtime. CI builds the proxy from `barzoj-co/llmentary` source. The release workflow copies GoReleaser artifacts into the optional packages after verifying `checksums.txt` SHA-256.

Use `LLMENTARY_PROXY_URL` (and `LLMENTARY_CONTROL_URL` — control listens on a separate port) to attach to an already-running proxy instead of starting a process. When this client starts the binary it passes `-listen`, `-control`, and `-upstream name=url`. Trailing `/v1` is stripped from the upstream URL because the Go process prefixes the client path (`/v1/chat/completions`). Empty `LLMENTARY_UPSTREAM_BASE_URL` / `OPENAI_BASE_URL` values fall through to `https://api.openai.com`.

## Release / trusted publishing

Tags matching `v*` run `.github/workflows/release.yml` (also dispatched by release-please after it creates a tag). That workflow:

1. Builds this client
2. Downloads GoReleaser assets for the `PROXY_VERSION` tag from `barzoj-co/llmentary`
3. Verifies each archive against `checksums.txt`
4. Writes the binary into `@llmentary/<platform>`
5. Pins platform package versions and root `optionalDependencies` to `PROXY_VERSION`, leaving the client version unchanged
6. Packs tarballs; publishes only when `vars.NPM_PUBLISH_ENABLED` is `true`

It is prepared for npm trusted publishing (OIDC, `environment: npm`). Provenance is generated automatically by npm trusted publishing once the repo is public. It does **not** publish until the maintainer sets that variable. See [docs/releasing.md](docs/releasing.md).

## Assertions

Use `lab.expect()` or scoped queries:

```ts
await lab.expect().toolCalled("lookup_weather");
await lab.query({ apiType: "responses", model: "gpt-4.1-mini" }).expect().calledTimes("lookup_weather", 1);
```

Supported deterministic assertions include tool calls, call counts, argument subsets/predicates, order, parallel tool-call request params, tool-result feedback, model, request params, finish reason, token/latency/TTFT/retry bounds, usage details, stream/output helpers, errors, prompt/response text, and JSON schema validation. Failures throw `LabAssertionError` with a trace summary. Use `.soft()` or `softExpect()` for non-throwing results.

See [docs/api.md](docs/api.md) for the full API.

## CI secrets

The included CI workflow expects:

- `LLMTESTLAB_REPO_TOKEN`: a GitHub token that can read the private `barzoj-co/llmentary` repo so CI can run `go build ./cmd/llmentary`. Remove this secret/workflow usage once that repo is public.
- `OPENAI_API_KEY`: required for real OpenAI E2E tests on same-repo PRs and pushes. Fork PRs skip private-binary checkout and this E2E step because secrets are unavailable. Prefix-cache hits are required for Chat Completions (up to 3 attempts) and optional for Responses; both always check that recorded `cached_tokens` match the nested value in the raw upstream body. See [docs/api.md](docs/api.md).

## License

Licensed under MIT, see LICENSE
