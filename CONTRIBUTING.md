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

## CI secrets and the e2e gate

Live OpenAI e2e runs in a dedicated `e2e-openai` job (`OpenAI E2E`). That job
holds every `secrets.OPENAI_API_KEY` reference in `ci.yml`. Secrets reach only
the steps that need them: the proxy checkout `token:` for
`LLMTESTLAB_REPO_TOKEN`, and the `OpenAI E2E` step env for `OPENAI_API_KEY`.
Presence checks use the boolean form (`secrets.X != ''`) so the raw value
never enters those processes. `npm ci` and the rest of the `test` job run
with no secret in env.

`e2e-gate` always runs and is green only when `e2e-openai` succeeded. Fork
PRs skip the live job (no secrets), so the gate fails. That is intended:
GitHub would otherwise treat a skipped required check as passing.

**Known limitation:** on `pull_request`, GitHub runs the workflow and scripts
from the PR's own merge commit, so a PR that edits `ci.yml` or
`scripts/e2e-gate.sh` can make the gate pass. The gate catches the normal
fork case (e2e skipped, nobody tampered with CI). Tampering is caught by
review of every `.github/**` and `scripts/**` diff. Never "fix" this with
`pull_request_target`.

A `workflow_dispatch` of CI on a non-main ref skips `e2e-openai` by design;
`e2e-gate` is red there.

### Maintainer: run live e2e for a fork PR

1. Review the fork diff.
2. Push the same commits to a same-repo branch (or open a same-repo PR).
3. CI on that branch runs `OpenAI E2E` with repo secrets.
4. Never use `pull_request_target`.

### Optional maintainer approval (`environment: openai-e2e`)

To require maintainer approval for live e2e, add one line on the
`e2e-openai` job, directly above `runs-on:`:

```yaml
environment: openai-e2e
```

after Denis creates that environment with its protection rules and moves
`OPENAI_API_KEY` into it. Do not add `environment:` before that: referencing
an environment auto-creates it unprotected. If the environment is enabled
later and an approval is rejected or times out, `e2e-gate` goes red. That is
intended.

## Hygiene scripts

```sh
scripts/check-pinned-actions.sh
scripts/check-pinned-actions.sh --self-test
scripts/check-workflow-policy.sh
scripts/check-secret-scope.sh --e2e-job e2e-openai
scripts/check-secret-scope.sh --self-test
scripts/check-pr-oidc.sh
scripts/check-pr-oidc.sh --self-test
scripts/e2e-gate.sh --self-test
scripts/check-ref-on-main.sh --self-test
scripts/check-gitleaks-config.sh --self-test
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
