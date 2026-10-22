# Releasing

This client has its own semver. The bundled proxy binary is pinned separately
in the committed `PROXY_VERSION` file (Option B). release-please bumps the
root `package.json` / `package-lock.json` and writes `CHANGELOG.md`. It does
not treat `packages/*` as release-please packages.

## Proxy pin

Renovate watches GitHub releases of `barzoj-co/llmentary` and opens a PR
that updates `PROXY_VERSION`. Those PRs do not automerge. After merge, the
next client release packs platform packages at that proxy tag. The current
pin is `v0.4.1`.

## Automatic flow

1. Conventional commits land on `main`.
2. `release-please.yml` opens or updates a release PR (first release is
   `0.1.0`).
3. Merging that PR tags `v<client version>`.
4. Because `GITHUB_TOKEN` tags do not trigger `on: push: tags`, the
   release-please job then runs `gh workflow run release.yml --ref "<tag>"`.
5. `release.yml` only runs on refs that start with `refs/tags/v`.
6. The **build** job checks out the tag, asserts the tag (without `v`) equals
   the root `package.json` version, reads `PROXY_VERSION`, and runs
   `scripts/pack-platform-binaries.mjs` with `LLMENTARY_TAG` set to that pin
   and `LLMENTARY_ROOT_VERSION` set so the root version is left alone while
   platform versions and root `optionalDependencies` follow the proxy pin.
7. It typechecks, lints, builds, and `npm pack`s the root and each platform
   package into `dist/`.
8. The **publish** job runs only when `vars.NPM_PUBLISH_ENABLED == 'true'`.
   It uses the `npm` GitHub Environment and OIDC (`id-token: write`). There is
   no `NODE_AUTH_TOKEN` / `NPM_TOKEN`. Until the variable is set, the job is
   skipped and the workflow is green.

Publish order: each `@llmentary/<platform>` tarball (skip if that proxy
version already exists on the registry), then the root `llmentary` tarball,
all with `--access public`. Each `npm publish` must pass an explicit local
path (`./dist/*.tgz` or `$(realpath ...)`); npm 11 treats a bare `dist/*.tgz`
as a GitHub shorthand. Provenance is generated automatically by npm
trusted publishing.

## One-time manual setup

1. On npm, create the `llmentary` org (claims `@llmentary`). Check that the
   `llmentary` package name is available.
2. npm trusted publishing is configured per package and (at the time of
   writing; verify) requires the package to exist. The very first publish of
   all six packages is done once by Denis by hand (or with a short-lived
   granular token that is then deleted), from the same tarballs built by
   `release.yml`.
3. For each of the six packages: npmjs.com → package → Settings → Trusted
   publisher → GitHub Actions: organization `barzoj-co`, repository
   `llmentary-js`, workflow `release.yml`, environment `npm`. Then set
   "Require two-factor authentication and disallow tokens".
4. GitHub → repo → Environments → `npm`: deployments only from tags `v*`;
   optionally require Denis as reviewer.
5. GitHub → repo → Variables → `NPM_PUBLISH_ENABLED=true`.
