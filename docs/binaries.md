# Proxy binary resolution

This client never downloads binaries during `npm install` or at runtime.

npm installs one optional platform package matching the current OS/CPU when it is published:

- `@llmentary/linux-x64`
- `@llmentary/linux-arm64`
- `@llmentary/darwin-x64`
- `@llmentary/darwin-arm64`
- `@llmentary/win32-x64`

Those packages are version-pinned to the bundled proxy release in `PROXY_VERSION` (currently `v0.4.1`). This client has its own semver; `optionalDependencies` pins the matching platform packages. There is no `postinstall` download.

## Resolution order

1. `LLMENTARY_BIN` (always wins)
2. optional dependency `@llmentary/<os>-<cpu>/bin/llmentary`
3. `llmentary` on `PATH`
4. previously extracted cache under `~/.cache/llmentary`

CI installs the released `PROXY_VERSION` binary from `barzoj-co/llmentary` GitHub Releases (`scripts/install-proxy.sh`): it verifies `checksums.txt` SHA-256 and the Sigstore bundle with cosign identity `goreleaser.yml@refs/heads/main` (not the tag ref). The release workflow copies those same GoReleaser artifacts into the optional packages. See [releasing.md](releasing.md).

## Attach vs start

Use `LLMENTARY_PROXY_URL` (and `LLMENTARY_CONTROL_URL` — control listens on a separate port) to attach to an already-running proxy instead of starting a process. When this client starts the binary it passes `-listen` and `-control`. It passes `-upstream name=url` only when `upstreams`, `upstreamBaseUrl`, `LLMENTARY_UPSTREAMS`, or `LLMENTARY_UPSTREAM_BASE_URL` is set. Otherwise the proxy's own default (`openai=https://api.openai.com/v1`) is used. Upstream URLs are not rewritten; the proxy joins overlapping `/v1` segments. `OPENAI_BASE_URL` is never used as the upstream.
