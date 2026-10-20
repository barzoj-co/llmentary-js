# Proxy binary resolution

This client never downloads binaries during `npm install` or at runtime.

npm installs one optional platform package matching the current OS/CPU when it is published:

- `@llmentary/linux-x64`
- `@llmentary/linux-arm64`
- `@llmentary/darwin-x64`
- `@llmentary/darwin-arm64`
- `@llmentary/win32-x64`

Those packages are version-pinned to the bundled proxy release in `PROXY_VERSION`. This client has its own semver; `optionalDependencies` pins the matching platform packages. There is no `postinstall` download.

## Resolution order

1. `LLMENTARY_BIN` (always wins)
2. optional dependency `@llmentary/<os>-<cpu>/bin/llmentary`
3. `llmentary` on `PATH`
4. previously extracted cache under `~/.cache/llmentary`

CI builds the proxy from `barzoj-co/llmentary` source. The release workflow copies GoReleaser artifacts into the optional packages after verifying `checksums.txt` SHA-256. See [releasing.md](releasing.md).

## Attach vs start

Use `LLMENTARY_PROXY_URL` (and `LLMENTARY_CONTROL_URL` — control listens on a separate port) to attach to an already-running proxy instead of starting a process. When this client starts the binary it passes `-listen`, `-control`, and `-upstream name=url`. Trailing `/v1` is stripped from the upstream URL because the Go process prefixes the client path (`/v1/chat/completions`). Empty `LLMENTARY_UPSTREAM_BASE_URL` / `OPENAI_BASE_URL` values fall through to `https://api.openai.com`.
