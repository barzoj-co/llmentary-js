# Contributing

Thanks for working on `llmentary`. This repository is the TypeScript/JavaScript
client for Vitest and Jest. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
and [SECURITY.md](SECURITY.md) before opening issues or pull requests.

## Requirements

- Node.js 18 or newer. CI runs Node 18, 20, and 22.
- A `llmentary` binary on `LLMENTARY_BIN` for real-binary tests (CI installs the `PROXY_VERSION` GitHub Release). A local Go 1.26 checkout of `barzoj-co/llmentary` is optional.
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

Real-proxy tests (require `LLMENTARY_BIN`, which CI sets by installing
`PROXY_VERSION` from GitHub Releases):

```sh
npm run test:proxy
npm run test:jest:proxy
```

Coverage is enforced by `vitest` `coverage.thresholds` in the existing
required **Node 22** job (`npm run test:coverage` when `LLMENTARY_BIN` is
set, otherwise `npm run test:unit -- --coverage`). Job names stay
`Node 18` / `Node 20` / `Node 22`. Codecov uploads stay informational
and do not gate the PR.

Adapter files (`src/jest.ts`, `src/vitest.ts`, `src/matchers.ts`,
`src/jest/setup.ts`, `src/jest/globalSetup.ts`, `src/jest/globalTeardown.ts`)
are covered from Vitest (`tests/adapters.test.ts`) so they land in the
same `coverage/lcov.info` as the rest of `src/**`. Do not run Jest
coverage as a second report.

Thresholds start at the floored Node 22 numbers from main @ 353f9e5
(77% lines/statements, 81% branches, 82% functions) and ratchet up as
real tests land. Release-please PRs (`release-please--*` head ref, or
`COVERAGE_RELEASE_PLEASE=1`) require **≥90%** lines, statements, and
functions (and branches). Denis requires ≥90% before a release.

```sh
npm run test:coverage
COVERAGE_RELEASE_PLEASE=1 npm run test:coverage
```

Live OpenAI e2e (must not skip; needs `OPENAI_API_KEY`):

```sh
npm run test:e2e:openai
```

Never print, log, or commit `OPENAI_API_KEY`, `LLMTESTLAB_REPO_TOKEN`, or any
`Authorization` / `api-key` value.

## Binary resolution and releasing

How the client finds the proxy binary, optional platform packages, and attach-vs-start
environment variables is documented in [docs/binaries.md](docs/binaries.md).
Trusted publishing, provenance, and the `NPM_PUBLISH_ENABLED` gate are in
[docs/releasing.md](docs/releasing.md).

## CI secrets and the e2e gate

The included CI workflow expects:

- `LLMTESTLAB_REPO_TOKEN`: a GitHub token that can read the private
  `barzoj-co/llmentary` repo so CI can download the `PROXY_VERSION` GitHub
  Release (`scripts/install-proxy.sh`). Remove this secret/workflow usage
  once that repo is public. Keep the secret name as-is; it is an existing
  org secret.
- `OPENAI_API_KEY`: required for real OpenAI E2E tests on same-repo PRs and
  pushes. Fork PRs skip the released-binary install and this E2E step because
  secrets are unavailable.

Prefix-cache hits are required for Chat Completions (up to 3 attempts) and
optional for Responses; both always check that recorded `cached_tokens` match
the nested value in the raw upstream body. See [docs/api.md](docs/api.md).

Live OpenAI e2e runs in a dedicated `e2e-openai` job (`OpenAI E2E`). That job
holds every `secrets.OPENAI_API_KEY` reference in `ci.yml`. Secrets reach only
the steps that need them: `GH_TOKEN` on `Install released proxy` for
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
3. Approve the `openai-e2e` environment deployment on that run.
4. Never use `pull_request_target`.

### Maintainer approval (`environment: openai-e2e`)

The live `e2e-openai` job sets `environment: openai-e2e`. Maintainers approve
that GitHub Environment deployment on each PR (and on `push` to `main`)
before the job can use `OPENAI_API_KEY`. The `test` matrix (unit, proxy,
coverage) and `pack` jobs do not reference this environment, so they run
without approval.

If approval is rejected or times out, `e2e-openai` does not succeed and
`e2e-gate` goes red. That is intended.

## Hygiene scripts

```sh
scripts/check-pinned-actions.sh
scripts/check-pinned-actions.sh --self-test
scripts/check-workflow-policy.sh
scripts/check-secret-scope.sh --e2e-job e2e-openai --e2e-environment openai-e2e
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
- Vitest `coverage.thresholds` fail the required Node 22 job when the
  report is below the floors (90% on release-please PRs). Codecov
  uploads stay informational.
- Release process is documented in [docs/releasing.md](docs/releasing.md).
