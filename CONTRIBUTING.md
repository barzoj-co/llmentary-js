# Contributing

Thanks for helping with `llm-test-lab`. By participating you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports go through [SECURITY.md](SECURITY.md), never a public issue.

Release mechanics live in [docs/releasing.md](docs/releasing.md).

## Prerequisites

- Node.js 18 or newer (CI runs 18, 20, and 22)
- npm (use the lockfile: `npm ci`)
- For real-binary / proxy tests: Go 1.26 to build `llmtestlab` from [`barzoj-co/llm-test-lab`](https://github.com/barzoj-co/llm-test-lab), **or** set `LLMTESTLAB_BIN` to an existing binary
- For the live OpenAI suite: `OPENAI_API_KEY` (tests must run, not skip)

## Setup

```sh
npm ci
```

## Checks that must pass

```sh
npm run typecheck
npm run lint
npm run build
npm run test:unit
npm run test:jest:unit
```

Real proxy tests (need `LLMTESTLAB_BIN` or a local Go build of the proxy):

```sh
npm run test:proxy
npm run test:jest:proxy
```

Live OpenAI e2e (same-repo CI only; must not skip):

```sh
export OPENAI_API_KEY
export LLMTESTLAB_BIN   # or let CI build it
npm run test:e2e:openai
```

Dual package shape (ESM + CJS, including `.d.ts` / `.d.cts` via `exports`):

```sh
npm run attw
npm run test:pack
```

`npm run build` compiles `tsconfig.esm.json` and `tsconfig.cjs.json`, then `scripts/write-cjs-package.cjs` writes `dist/cjs/package.json` with `"type": "commonjs"`. `attw` checks the published export map. `test:pack` installs the packed tarball into JS and TS consumers.

Coverage is informational (`npm run test:coverage` on the Node 22 CI leg). There are no coverage thresholds; a coverage miss does not fail the PR.

## Hygiene scripts

```sh
./scripts/check-pinned-actions.sh
./scripts/check-pinned-actions.sh --self-test
./scripts/check-workflow-policy.sh
./scripts/check-readme.sh
```

`actionlint` (with ShellCheck) runs in CI. Locally, after installing [actionlint](https://github.com/rhysd/actionlint) and `shellcheck`:

```sh
actionlint
```

## Pull requests

- Use a [Conventional Commit](https://www.conventionalcommits.org/) PR title (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`, …).
- Document only behavior that exists in the branch.
- Do not print, log, or commit secrets (`OPENAI_API_KEY`, `LLMTESTLAB_REPO_TOKEN`, `Authorization` / `api-key` values).
- Do not weaken, skip, or delete tests to make CI pass.

Renovate opens grouped dependency PRs (Monday mornings, Europe/Amsterdam) and automerges safe patch/digest updates. `peerDependencies`, `engines.node`, and `@llm-test-lab/*` optional platform packages are ignored. `PROXY_VERSION` is bumped from `barzoj-co/llm-test-lab` GitHub releases and is never automerged.
