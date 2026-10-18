#!/usr/bin/env bash
# Self-test .gitleaks.toml: placeholders pass, realistic keys fail, including under allowlisted paths.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"

usage() {
  echo "Usage: $0 [--self-test]" >&2
  exit 2
}

rand_alnum() {
  local n="$1"
  python3 -c "import secrets,string; a=string.ascii_letters+string.digits; print(''.join(secrets.choice(a) for _ in range($n)))"
}

scan_dir() {
  local dir="$1"
  gitleaks dir --config "$CONFIG" --redact --no-banner --exit-code 1 "$dir" 2>&1
}

self_test() {
  if ! command -v gitleaks >/dev/null 2>&1; then
    echo "gitleaks is required on PATH" >&2
    exit 1
  fi
  if [[ ! -f "$CONFIG" ]]; then
    echo "missing $CONFIG" >&2
    exit 1
  fi

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  mkdir -p "$tmp/clean/tests/e2e"
  printf 'const k = "sk-invalid-key-for-401-test";\n' >"$tmp/clean/tests/e2e/openai.test.ts"
  printf 'Set OPENAI_API_KEY to sk-... in the environment.\n' >"$tmp/clean/README.md"
  local clean_out clean_code=0
  clean_out="$(scan_dir "$tmp/clean")" || clean_code=$?
  if [[ "$clean_code" -ne 0 ]]; then
    echo "self-test: placeholders should not be reported as leaks" >&2
    echo "$clean_out" >&2
    return 1
  fi
  echo "self-test: placeholders (sk-... / sk-invalid-key-for-401-test) → 0"

  # Realistic OpenAI user keys contain the OpenAI marker; PAT is ghp_ + 36.
  local openai_key github_pat
  openai_key="sk-$(rand_alnum 20)T3BlbkFJ$(rand_alnum 20)"
  github_pat="ghp_$(rand_alnum 36)"

  mkdir -p "$tmp/openai/tests/e2e"
  printf 'const k = "%s";\n' "$openai_key" >"$tmp/openai/tests/e2e/openai.test.ts"
  local openai_out openai_code=0
  openai_out="$(scan_dir "$tmp/openai")" || openai_code=$?
  if [[ "$openai_code" -eq 0 ]]; then
    echo "self-test: realistic OpenAI key under tests/e2e/ should fail" >&2
    echo "$openai_out" >&2
    return 1
  fi
  if grep -F -q "$openai_key" <<<"$openai_out"; then
    echo "self-test: OpenAI key was not redacted" >&2
    return 1
  fi
  echo "self-test: realistic OpenAI key under tests/e2e/ → ${openai_code} (redacted)"

  mkdir -p "$tmp/pat"
  printf '{ "note": "%s" }\n' "$github_pat" >"$tmp/pat/package-lock.json"
  printf 'const t = "%s";\n' "$github_pat" >"$tmp/pat/from-lock.ts"
  local pat_out pat_code=0
  pat_out="$(scan_dir "$tmp/pat")" || pat_code=$?
  if [[ "$pat_code" -eq 0 ]]; then
    echo "self-test: realistic GitHub PAT should fail (including under package-lock.json / sibling path)" >&2
    echo "$pat_out" >&2
    return 1
  fi
  if grep -F -q "$github_pat" <<<"$pat_out"; then
    echo "self-test: GitHub PAT was not redacted" >&2
    return 1
  fi
  echo "self-test: realistic GitHub PAT under package-lock.json (and sibling) → ${pat_code} (redacted)"
  echo "self-test: ok"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

if [[ "${1:-}" != "--self-test" || $# -ne 1 ]]; then
  usage
fi

self_test
