# Contributing

Thanks for working on `llm-test-lab`. This repository is the TypeScript/JavaScript
client for Vitest and Jest. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
and [SECURITY.md](SECURITY.md) before opening issues or pull requests.

## Requirements

- Node.js 18 or newer. CI runs Node 18, 20, and 22.
- Go 1.26, or a `llmtestlab` binary on `LLMTESTLAB_BIN`, for real-binary tests.
- npm (use `npm ci` after clone).

## Setup

```sh
npm ci
```

## Checks that must stay green

```sh
npm run typecheck
npm run lint
npm run build
```

The package is dual ESM/CJS:

- ESM output: `dist/esm` (`tsconfig.esm.json`)
- CJS output: `dist/cjs` (`tsconfig.cjs.json`), plus `scripts/write-cjs-package.cjs`
- Types are checked with `npm run typecheck` and, in CI, `npm run attw` (`@arethetypeswrong/cli`)
- Packed tarball install is checked in JS and TS consumers (`npm run test:pack`)

## Tests

Unit tests (Vitest, no proxy binary):

```sh
npm run test:unit
```

Jest CJS export tests:

```sh
npm run test:jest:unit
```

Real-proxy tests (require `LLMTESTLAB_BIN` or a Go 1.26 checkout of
`barzoj-co/llm-test-lab`):

```sh
npm run test:proxy
npm run test:jest:proxy
```

Coverage (informational, same Vitest file list as `test:unit` + `test:proxy`):

```sh
npm run test:coverage
```

Live OpenAI e2e (must not skip; needs `OPENAI_API_KEY`):

```sh
npm run test:e2e:openai
```

Never print, log, or commit `OPENAI_API_KEY`, `LLMTESTLAB_REPO_TOKEN`, or any
`Authorization` / `api-key` value.

## Hygiene scripts

```sh
scripts/check-pinned-actions.sh
scripts/check-pinned-actions.sh --self-test
scripts/check-workflow-policy.sh
scripts/check-readme.sh
```

`actionlint` with ShellCheck is run in CI (`Hygiene / actionlint`). To run it
locally, install [actionlint](https://github.com/rhysd/actionlint) and
`shellcheck`, then from the repo root:

```sh
actionlint -color
```

## Pull requests

- Use a conventional-commit PR title (`feat:`, `fix:`, `docs:`, `ci:`, …).
- Renovate opens grouped dependency PRs on a Monday Europe/Amsterdam schedule.
- Coverage uploads are informational and do not fail the PR.
- Release process is documented in [docs/releasing.md](docs/releasing.md).
