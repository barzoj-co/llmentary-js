# @llm-test-lab/darwin-x64

Optional macOS x64 package for `llm-test-lab`. npm selects it through `optionalDependencies` + `os`/`cpu` when you install `llm-test-lab` on this platform.

The package metadata and wrapper are MIT licensed; see [LICENSE](LICENSE). The `llmtestlab` binary placed in `bin/` by the release workflow is AGPL-3.0-only and runs as a separate process; see [LICENSE.AGPL-3.0](LICENSE.AGPL-3.0). Corresponding source for that binary is the Git tag matching this package version (for example `v0.1.0` for `0.1.0`) of https://github.com/barzoj-co/llm-test-lab. There is no `postinstall` script; the binary is packed at publish time from checksum-verified GoReleaser artifacts.

Override the binary with `LLMTESTLAB_BIN` if you do not want this package's file.
