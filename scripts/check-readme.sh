#!/usr/bin/env bash
# Fail if required README badges or the canonical repo table are missing or altered.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
README="$ROOT/README.md"

if [[ ! -f "$README" ]]; then
  echo "missing README.md" >&2
  exit 1
fi

required=(
  '[![CI](https://github.com/barzoj-co/llmentary-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/barzoj-co/llmentary-js/actions/workflows/ci.yml)'
  '[![codecov](https://codecov.io/gh/barzoj-co/llmentary-js/graph/badge.svg)](https://codecov.io/gh/barzoj-co/llmentary-js)'
  '[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/barzoj-co/llmentary-js/badge)](https://scorecard.dev/viewer/?uri=github.com/barzoj-co/llmentary-js)'
  '[![License: MIT](https://img.shields.io/github/license/barzoj-co/llmentary-js)](LICENSE)'
  '[![npm](https://img.shields.io/npm/v/llmentary)](https://www.npmjs.com/package/llmentary)'
)

status=0
for needle in "${required[@]}"; do
  if ! grep -Fqx "$needle" "$README"; then
    echo "README.md is missing required badge line:" >&2
    echo "  $needle" >&2
    status=1
  fi
done

python3 - "$README" <<'PY'
from pathlib import Path
import re
import sys

canonical = """<!-- llmentary-repos:start -->
## llmentary repositories

| Repository | What | License |
|---|---|---|
| [llmentary](https://github.com/barzoj-co/llmentary) | Recording proxy binary (Go) | AGPL-3.0 |
| [llmentary-go](https://github.com/barzoj-co/llmentary-go) | Go client for `go test` | MIT |
| [llmentary-python](https://github.com/barzoj-co/llmentary-python) | Python client and pytest plugin | MIT |
| [llmentary-js](https://github.com/barzoj-co/llmentary-js) | TypeScript/JavaScript client for Vitest and Jest | MIT |
<!-- llmentary-repos:end -->"""

text = Path(sys.argv[1]).read_text()
if canonical not in text:
    print("README.md is missing or altered the canonical llmentary-repos block", file=sys.stderr)
    raise SystemExit(1)
if "Renamed from" in text:
    print("README.md must not mention the pre-release rename", file=sys.stderr)
    raise SystemExit(1)
old = "l" + "ab"
if re.search(rf"\b{old}\b", text):
    print("README.md still contains a removed factory name", file=sys.stderr)
    raise SystemExit(1)
PY

exit "$status"
