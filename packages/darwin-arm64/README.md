# @llm-test-lab/darwin-arm64

Optional macOS arm64 package for `llm-test-lab`. npm selects it through `optionalDependencies` + `os`/`cpu` when you install `llm-test-lab` on this platform.

There is no `postinstall` script; the binary is packed at publish time from checksum-verified GoReleaser artifacts.

Override the binary with `LLMTESTLAB_BIN` if you do not want this package's file.

Licensed under AGPL-3.0, see LICENSE.AGPL-3.0
