#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
README="$ROOT/README.md"

required=(
  '[![CI](https://github.com/barzoj-co/llm-test-lab-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/barzoj-co/llm-test-lab-js/actions/workflows/ci.yml)'
  '[![codecov](https://codecov.io/gh/barzoj-co/llm-test-lab-js/graph/badge.svg)](https://codecov.io/gh/barzoj-co/llm-test-lab-js)'
  '[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/barzoj-co/llm-test-lab-js/badge)](https://scorecard.dev/viewer/?uri=github.com/barzoj-co/llm-test-lab-js)'
  '[![License: MIT](https://img.shields.io/github/license/barzoj-co/llm-test-lab-js)](LICENSE)'
  '[![npm](https://img.shields.io/npm/v/llm-test-lab)](https://www.npmjs.com/package/llm-test-lab)'
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
import sys

readme = Path(sys.argv[1]).read_text()
block = """<!-- ltl-repos:start -->
## llm-test-lab repositories

| Repository | What | License |
|---|---|---|
| [llm-test-lab](https://github.com/barzoj-co/llm-test-lab) | Recording proxy binary (Go) | AGPL-3.0 |
| [llm-test-lab-go](https://github.com/barzoj-co/llm-test-lab-go) | Go client for `go test` | MIT |
| [llm-test-lab-python](https://github.com/barzoj-co/llm-test-lab-python) | Python client and pytest plugin | MIT |
| [llm-test-lab-js](https://github.com/barzoj-co/llm-test-lab-js) | TypeScript/JavaScript client for Vitest and Jest | MIT |
<!-- ltl-repos:end -->
"""
if block not in readme:
    sys.stderr.write("README.md is missing the canonical ltl-repos block or it was altered\n")
    sys.exit(1)
PY

exit "$status"
