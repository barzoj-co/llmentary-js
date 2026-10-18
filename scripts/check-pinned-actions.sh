#!/usr/bin/env bash
# Verify GitHub Actions `uses:` pins (SHA + version comment, local path, or digest).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCANNER="${BASH_SOURCE[0]}"

SHA40='[0-9a-fA-F]{40}'
SHA256='[0-9a-fA-F]{64}'
ACTION_REF='[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*'

usage() {
  echo "Usage: $0 [--self-test] [dir ...]" >&2
  exit 2
}

is_comment_or_empty() {
  local trimmed="${1-}"
  trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"
  [[ -z "$trimmed" || "$trimmed" == \#* ]]
}

check_file() {
  local file="$1"
  local line lineno uses value
  local status=0
  lineno=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    if is_comment_or_empty "$line"; then
      continue
    fi
    if [[ ! "$line" =~ uses:[[:space:]]*(.+) ]]; then
      continue
    fi
    uses="${BASH_REMATCH[1]}"
    uses="${uses%"${uses##*[![:space:]]}"}"
    uses="${uses#"${uses%%[![:space:]]*}"}"
    if [[ "$uses" == \'.* || "$uses" == \"* ]]; then
      echo "$file:$lineno: quoted uses: values are not supported: $uses" >&2
      status=1
      continue
    fi
    if [[ "$uses" == ./* ]]; then
      continue
    fi
    if [[ "$uses" == docker://* ]]; then
      if [[ "$uses" =~ ^docker://[^[:space:]]+@sha256:$SHA256$ ]]; then
        continue
      fi
      echo "$file:$lineno: docker image must be pinned with @sha256:<64 hex>: $uses" >&2
      status=1
      continue
    fi
    if [[ "$uses" =~ ^${ACTION_REF}@${SHA40}[[:space:]]+#[[:space:]]*v[^[:space:]]+ ]]; then
      continue
    fi
    echo "$file:$lineno: action must be owner/repo[/path]@<40 hex> # v... : $uses" >&2
    status=1
  done < "$file"
  return "$status"
}

scan_dirs() {
  local dir file status=0
  local files=()
  for dir in "$@"; do
    if [[ ! -e "$dir" ]]; then
      continue
    fi
    while IFS= read -r -d '' file; do
      files+=("$file")
    done < <(find "$dir" \( -name '*.yml' -o -name '*.yaml' \) -type f -print0 | sort -z)
  done
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "no workflow files found in: $*" >&2
    return 1
  fi
  for file in "${files[@]}"; do
    if ! check_file "$file"; then
      status=1
    fi
  done
  return "$status"
}

self_test() {
  local good="$ROOT/scripts/testdata/pinned-actions/good"
  local bad="$ROOT/scripts/testdata/pinned-actions/bad"
  local out status

  if ! out="$(scan_dirs "$good" 2>&1)"; then
    echo "self-test: expected good fixtures to pass" >&2
    echo "$out" >&2
    return 1
  fi

  status=0
  out="$(scan_dirs "$bad" 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    echo "self-test: expected bad fixtures to fail" >&2
    return 1
  fi

  local required=(
    "unpinned-tag.yml:2"
    "floating-branch.yml:2"
    "short-sha.yml:2"
    "sha-without-comment.yml:2"
    "docker-tag.yml:2"
  )
  local item
  for item in "${required[@]}"; do
    if ! grep -q "$item" <<<"$out"; then
      echo "self-test: missing rejection for $item" >&2
      echo "$out" >&2
      return 1
    fi
  done
  echo "self-test: good fixtures passed, bad fixtures rejected with file:line"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

if [[ $# -eq 0 ]]; then
  set -- "$ROOT/.github/workflows" "$ROOT/.github/actions"
fi

scan_dirs "$@"
