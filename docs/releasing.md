# Releasing

This repository uses **Option B**: the npm package `llm-test-lab` has its own semver (release-please). The bundled proxy binary version is pinned in the committed [`PROXY_VERSION`](../PROXY_VERSION) file and is independent of the client version.

## Day-to-day

1. Merge conventional-commit PRs to `main`.
2. `release-please.yml` opens or updates a Release PR that bumps root `package.json` / `package-lock.json` and `CHANGELOG.md` only. `packages/*` are not release-please packages.
3. The first client release is `0.1.0` (`release-as` in `release-please-config.json`). Remove `release-as` after that tag exists.
4. Merging the Release PR creates tag `v<version>`. Tags created with `GITHUB_TOKEN` do **not** trigger `on: push: tags`, so the release-please job runs `gh workflow run release.yml --ref "<tag_name>"`.
5. `release.yml` runs only when `github.ref` starts with `refs/tags/v`:
   - **build** asserts the tag (without `v`) equals root `package.json` version, reads `PROXY_VERSION`, packs platform binaries via `scripts/pack-platform-binaries.mjs` with `LLMTESTLAB_TAG` from that file and `LLMTESTLAB_ROOT_VERSION` set so the root version is left unchanged, then `npm pack`s the root and each platform package.
   - **publish** runs only when repository variable `NPM_PUBLISH_ENABLED` is `true`. It publishes each missing platform tarball, then the root tarball, with `npm publish --provenance --access public` using npm trusted publishing (OIDC). There is no `NODE_AUTH_TOKEN` / `NPM_TOKEN`.

Until the maintainer sets `NPM_PUBLISH_ENABLED=true` and configures npm, the publish job is skipped and the workflow stays green.

## PROXY_VERSION

`PROXY_VERSION` holds a `barzoj-co/llm-test-lab` GitHub release tag (for example `v0.1.0`). Renovate has a regex manager on that file (`datasource: github-releases`, no automerge). Review those PRs: a new proxy tag must exist and its GoReleaser assets must match what `scripts/pack-platform-binaries.mjs` expects.

When `LLMTESTLAB_ROOT_VERSION` is unset, the pack script keeps the old lockstep behavior (root version, optionalDependencies, and platform package versions all follow the tag). Release automation always sets `LLMTESTLAB_ROOT_VERSION`.

## One-time manual setup (maintainer)

Do not run this from CI. The workflow is gated so a missing npm configuration cannot publish.

1. On npmjs.com, create the `@llm-test-lab` org/scope. Confirm that the name `llm-test-lab` is available.
2. npm trusted publishing is configured per package and (at the time of writing; verify) requires the package to exist. The very first publish of all six packages is done once by hand (or with a short-lived granular token that is then deleted), from the same tarballs built by `release.yml`.
3. For each of the six packages (`llm-test-lab` and `@llm-test-lab/{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64}`): npmjs.com → package → Settings → Trusted publisher → GitHub Actions: organization `barzoj-co`, repository `llm-test-lab-js`, workflow `release.yml`, environment `npm`. Then set "Require two-factor authentication and disallow tokens".
4. GitHub → repo → Environments → `npm`: deployments only from tags `v*`; optionally require Denis as reviewer.
5. GitHub → repo → Variables → `NPM_PUBLISH_ENABLED=true`.

Repository and org settings (rulesets, required checks, secret scanning, and so on) are applied by the maintainer, not by this repository's workflows.
