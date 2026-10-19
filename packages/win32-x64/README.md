# @llmentary/win32-x64

Optional Windows x64 package for `llmentary`. npm selects it through `optionalDependencies` + `os`/`cpu` when you install `llmentary` on this platform.

There is no `postinstall` script; the binary is packed at publish time from checksum-verified GoReleaser artifacts.

Override the binary with `LLMENTARY_BIN` if you do not want this package's file.

Licensed under AGPL-3.0, see LICENSE.AGPL-3.0
