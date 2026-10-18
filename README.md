# llm-test-lab

[![CI](https://github.com/barzoj-co/llm-test-lab-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/barzoj-co/llm-test-lab-js/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/barzoj-co/llm-test-lab-js/graph/badge.svg)](https://codecov.io/gh/barzoj-co/llm-test-lab-js)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/barzoj-co/llm-test-lab-js/badge)](https://scorecard.dev/viewer/?uri=github.com/barzoj-co/llm-test-lab-js)
[![License: MIT](https://img.shields.io/github/license/barzoj-co/llm-test-lab-js)](LICENSE)
[![npm](https://img.shields.io/npm/v/llm-test-lab)](https://www.npmjs.com/package/llm-test-lab)

TypeScript client for [`llm-test-lab`](https://github.com/barzoj-co/llm-test-lab): deterministic trace-based integration tests for LLM apps.

<!-- ltl-repos:start -->
## llm-test-lab repositories

| Repository | What | License |
|---|---|---|
| [llm-test-lab](https://github.com/barzoj-co/llm-test-lab) | Recording proxy binary (Go) | AGPL-3.0 |
| [llm-test-lab-go](https://github.com/barzoj-co/llm-test-lab-go) | Go client for `go test` | MIT |
| [llm-test-lab-python](https://github.com/barzoj-co/llm-test-lab-python) | Python client and pytest plugin | MIT |
| [llm-test-lab-js](https://github.com/barzoj-co/llm-test-lab-js) | TypeScript/JavaScript client for Vitest and Jest | MIT |
<!-- ltl-repos:end -->

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

Those packages are pinned to the bundled proxy version in [`PROXY_VERSION`](PROXY_VERSION), independently of this client's semver. There is no `postinstall` download.

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

Jest `globalSetup` writes owner-only (`0600`) per-run state in a unique `0700` temp directory and a run-id pointer under `.llm-test-lab/jest-runs/`. Control tokens are not persisted, concurrent Jest runs do not share or kill each other's proxy, and teardown verifies process identity before sending signals.

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

This client has its own semver. The bundled proxy version is the tag in [`PROXY_VERSION`](PROXY_VERSION). See [docs/releasing.md](docs/releasing.md).

`release-please` tags `v*` on `main`. That dispatch runs `.github/workflows/release.yml`, which:

1. Builds this client
2. Downloads GoReleaser assets for `PROXY_VERSION` from `barzoj-co/llm-test-lab`
3. Verifies each archive against `checksums.txt`
4. Writes the binary into `@llm-test-lab/<platform>`
5. Pins platform package versions and root `optionalDependencies` to the proxy version, leaving the root version unchanged
6. Packs tarballs and, when `NPM_PUBLISH_ENABLED` is set, publishes with npm trusted publishing (`id-token: write`, `--provenance`, no npm token)

It does **not** publish until the maintainer configures npm and sets that variable.

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

- `LLMTESTLAB_REPO_TOKEN`: a GitHub token that can read the private `barzoj-co/llm-test-lab` repo so CI can run `go build ./cmd/llmtestlab`. Remove this secret/workflow usage once that repo is public.
- `OPENAI_API_KEY`: required for real OpenAI E2E tests on same-repo PRs and pushes. Fork PRs skip private-binary checkout and this E2E step because secrets are unavailable. Prefix-cache hits are required for Chat Completions (up to 3 attempts) and optional for Responses; both always check that recorded `cached_tokens` match the nested value in the raw upstream body. See [docs/api.md](docs/api.md).

## License

This TypeScript client library, including the npm package metadata, is MIT licensed; see [LICENSE](LICENSE).

The bundled `llm-test-lab` proxy binary (the optional `@llm-test-lab/<platform>` packages, or a binary you point at with `LLMTESTLAB_BIN`) is AGPL-3.0 licensed and runs as a separate process. Those packages ship [LICENSE.AGPL-3.0](licenses/AGPL-3.0.txt) next to the MIT wrapper license. Corresponding source for a packed binary is the Git tag matching the package version of https://github.com/barzoj-co/llm-test-lab. That repository is currently private, so the platform packages must not be published until that source (or another public source archive) is reachable by recipients. The MIT client talks to that process over HTTP; it does not statically link it.
