#!/usr/bin/env bash
# Verify GitHub Actions `uses:` pins: owner/repo[/path]@<40 hex> # v...
# Local actions (./...) and docker://...@sha256:<64 hex> are also allowed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF_TEST=0
TARGETS=()

usage() {
  echo "Usage: $0 [--self-test] [path ...]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test) SELF_TEST=1 ;;
    -h|--help) usage ;;
    *) TARGETS+=("$1") ;;
  esac
  shift
done

is_hex() {
  local value="$1" len="$2"
  [[ ${#value} -eq "$len" && "$value" =~ ^[0-9a-fA-F]+$ ]]
}

check_file() {
  local file="$1"
  local line raw rest action ref comment ok
  local lineno=0
  local failed=0

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    lineno=$((lineno + 1))
    # Match workflow / composite action `uses:` entries (skip `uses:` in comments).
    if [[ ! "$raw" =~ ^[[:space:]]+-?[[:space:]]*uses:[[:space:]]+ ]]; then
      continue
    fi
    rest="${raw#*uses:}"
    rest="${rest#"${rest%%[![:space:]]*}"}"
    comment=""
    if [[ "$rest" == *#* ]]; then
      comment="${rest#*#}"
      comment="${comment#"${comment%%[![:space:]]*}"}"
      rest="${rest%%#*}"
    fi
    rest="${rest%"${rest##*[![:space:]]}"}"
    rest="${rest#\'}"
    rest="${rest%\'}"
    rest="${rest#\"}"
    rest="${rest%\"}"

    ok=0
    if [[ "$rest" == ./* || "$rest" == /* ]]; then
      ok=1
    elif [[ "$rest" == docker://* ]]; then
      local digest="${rest##*@}"
      if [[ "$rest" == *@sha256:* ]] && is_hex "${digest#sha256:}" 64; then
        ok=1
      fi
    elif [[ "$rest" == *@* ]]; then
      action="${rest%@*}"
      ref="${rest##*@}"
      if [[ "$action" == */* ]] && is_hex "$ref" 40 && [[ "$comment" == v* ]]; then
        ok=1
      fi
    fi

    if [[ "$ok" -ne 1 ]]; then
      echo "${file}:${lineno}: unpinned or uncommented uses: ${rest}" >&2
      failed=1
    fi
  done < "$file"

  return "$failed"
}

scan_paths() {
  local path files=()
  local status=0
  for path in "$@"; do
    if [[ -d "$path" ]]; then
      while IFS= read -r -d '' file; do
        files+=("$file")
      done < <(find "$path" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 | sort -z)
    elif [[ -f "$path" ]]; then
      files+=("$path")
    else
      echo "missing path: $path" >&2
      status=1
    fi
  done
  local file
  for file in "${files[@]+"${files[@]}"}"; do
    if ! check_file "$file"; then
      status=1
    fi
  done
  return "$status"
}

if [[ "$SELF_TEST" -eq 1 ]]; then
  good="$ROOT/scripts/testdata/pinned-actions/good"
  bad="$ROOT/scripts/testdata/pinned-actions/bad"
  if ! scan_paths "$good"; then
    echo "self-test: expected good fixtures to pass" >&2
    exit 1
  fi
  shopt -s nullglob
  bad_files=("$bad"/*)
  shopt -u nullglob
  if [[ ${#bad_files[@]} -eq 0 ]]; then
    echo "self-test: no bad fixtures" >&2
    exit 1
  fi
  for file in "${bad_files[@]}"; do
    output="$(scan_paths "$file" 2>&1 || true)"
    if [[ -z "$output" ]]; then
      echo "self-test: expected $file to be rejected" >&2
      exit 1
    fi
    if ! grep -Eq "$(basename "$file"):[0-9]+:" <<<"$output" && ! grep -Eq "$file:[0-9]+:" <<<"$output"; then
      echo "self-test: expected file:line in output for $file" >&2
      echo "$output" >&2
      exit 1
    fi
    echo "$output"
  done
  echo "self-test passed (${#bad_files[@]} bad fixtures rejected)"
  exit 0
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=("$ROOT/.github/workflows")
  if [[ -d "$ROOT/.github/actions" ]]; then
    TARGETS+=("$ROOT/.github/actions")
  fi
fi

scan_paths "${TARGETS[@]}"
