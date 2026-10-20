#!/usr/bin/env bash
# Assert release.yml / release-please.yml trusted-publishing shape (LTL-REL-JS / LTL-HYG-JS §6).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE="$ROOT/.github/workflows/release.yml"
PLEASE="$ROOT/.github/workflows/release-please.yml"

status=0
fail() {
  echo "$1" >&2
  status=1
}

[[ -f "$RELEASE" ]] || fail "missing $RELEASE"
[[ -f "$PLEASE" ]] || fail "missing $PLEASE"

python3 - "$RELEASE" "$PLEASE" <<'PY' || status=1
import re
import sys
from pathlib import Path

release = Path(sys.argv[1]).read_text()
please = Path(sys.argv[2]).read_text()
errors = []

if not re.search(r"(?m)^  publish:\s*$", release):
    errors.append("release.yml must define a publish job")
if "environment: npm" not in release:
    errors.append("release.yml publish job must use environment: npm")
if "id-token: write" not in release:
    errors.append("release.yml publish job must set id-token: write")
if "vars.NPM_PUBLISH_ENABLED == 'true'" not in release and 'vars.NPM_PUBLISH_ENABLED == "true"' not in release:
    errors.append("release.yml publish job must be gated on vars.NPM_PUBLISH_ENABLED == 'true'")
if not re.search(r"npm publish\b", release):
    errors.append("release.yml must publish with npm publish")
if re.search(r"npm publish\b[^\n]*--provenance", release):
    errors.append("release.yml must not pass --provenance (npm rejects provenance from private repos; OIDC generates it automatically once public)")
if re.search(r"(?m)^\s+registry-url:", release):
    errors.append("release.yml must not set setup-node registry-url (it writes a placeholder NODE_AUTH_TOKEN that breaks OIDC)")
if "NODE_AUTH_TOKEN" in release or "NPM_TOKEN" in release:
    errors.append("release.yml must not set NODE_AUTH_TOKEN or NPM_TOKEN")

on_match = re.search(r"(?ms)^on:\n(.*?)(?=^[a-z])", release)
on_block = on_match.group(1) if on_match else ""
if "workflow_dispatch:" not in on_block:
    errors.append("release.yml must trigger on workflow_dispatch")
if not re.search(r'tags:\s*\n\s*-\s*"v\*"', on_block):
    errors.append("release.yml must trigger only on v* tags (plus workflow_dispatch)")
if re.search(r"(?m)^\s+branches:", on_block):
    errors.append("release.yml must not trigger on branch pushes")

if "gh workflow run release.yml" not in please:
    errors.append("release-please.yml must dispatch release.yml")
if "release_created" not in please:
    errors.append("release-please.yml must dispatch only after release_created")

# Top-level id-token must not be write.
top_perm = re.search(r"(?ms)^permissions:\n(.*?)(?=^[a-z])", release)
if top_perm and re.search(r"(?m)^  id-token:\s*write\s*$", top_perm.group(1)):
    errors.append("release.yml must not grant id-token: write at the top level")

if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
print("release workflow policy: ok")
PY

exit "$status"
