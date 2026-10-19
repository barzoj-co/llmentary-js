#!/usr/bin/env bash
# Fail closed unless <ref> is an ancestor of origin/main.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "Usage: $0 [--self-test] [<ref>]" >&2
  exit 2
}

check_ref() {
  local ref="${1:-HEAD}"
  local commit short

  if ! git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
    echo "::error::origin/main not available; checkout needs fetch-depth: 0" >&2
    return 1
  fi

  if ! commit="$(git rev-parse --verify "${ref}^{commit}" 2>/dev/null)"; then
    echo "::error::cannot resolve ${ref} to a commit" >&2
    return 1
  fi
  short="$(git rev-parse --short "$commit")"

  if git merge-base --is-ancestor "$commit" refs/remotes/origin/main; then
    echo "$commit"
    return 0
  fi

  echo "::error::${ref} (${short}) is not on main; refusing to release" >&2
  return 1
}

self_test() {
  local script="$ROOT/scripts/check-ref-on-main.sh"
  local tmp origin work failed=0
  local main_old main_tip doomed out code
  tmp="$(mktemp -d)"
  origin="$tmp/origin.git"
  work="$tmp/work"
  trap 'rm -rf "$tmp"' RETURN

  git -c init.defaultBranch=main init --bare "$origin" >/dev/null 2>&1
  git clone "$origin" "$work" >/dev/null 2>&1
  git -C "$work" config user.email "ci@example.com"
  git -C "$work" config user.name "ci"
  git -C "$work" checkout -B main >/dev/null 2>&1
  echo "a" >"$work/file"
  git -C "$work" add file
  git -C "$work" commit -m "init" >/dev/null
  git -C "$work" push -u origin main >/dev/null 2>&1
  main_old="$(git -C "$work" rev-parse HEAD)"
  echo "b" >>"$work/file"
  git -C "$work" commit -am "on-main" >/dev/null
  git -C "$work" push origin main >/dev/null 2>&1
  main_tip="$(git -C "$work" rev-parse HEAD)"
  git -C "$work" tag -a annotated-main -m "annotated on main" "$main_tip"

  git -C "$work" checkout -b side >/dev/null 2>&1
  echo "c" >>"$work/file"
  git -C "$work" commit -am "side" >/dev/null
  git -C "$work" tag lightweight-side

  git -C "$work" checkout -b doomed >/dev/null 2>&1
  echo "d" >>"$work/file"
  git -C "$work" commit -am "doomed" >/dev/null
  doomed="$(git -C "$work" rev-parse HEAD)"
  git -C "$work" checkout main >/dev/null 2>&1
  git -C "$work" branch -D doomed >/dev/null 2>&1

  run_in_work() {
    local title="$1"
    local expect_code="$2"
    local expect_msg="${3-}"
    shift 3
    code=0
    out="$(
      cd "$work" || exit 1
      bash "$script" "$@" 2>&1
    )" || code=$?
    if [[ "$code" -ne "$expect_code" ]]; then
      echo "self-test: ${title}: expected exit ${expect_code}, got ${code}" >&2
      echo "$out" >&2
      failed=1
      return
    fi
    if [[ "$expect_code" -ne 0 && -n "$expect_msg" ]]; then
      if ! grep -F -q "$expect_msg" <<<"$out"; then
        echo "self-test: ${title}: missing expected message ${expect_msg@Q}" >&2
        echo "$out" >&2
        failed=1
        return
      fi
    fi
    if [[ "$expect_code" -eq 0 ]]; then
      echo "self-test: ${title} → 0 (${out})"
    else
      echo "self-test: ${title} → ${code}"
    fi
  }

  run_in_work "commit on main" 0 "" "$main_old"
  run_in_work "main tip" 0 "" HEAD
  run_in_work "annotated tag on a main commit" 0 "" annotated-main
  run_in_work "lightweight tag on an unmerged side-branch commit" 1 "is not on main; refusing to release" lightweight-side
  git -C "$work" tag origin/main lightweight-side
  run_in_work "origin/main tag collision" 1 "is not on main; refusing to release" lightweight-side
  git -C "$work" tag -d origin/main >/dev/null
  run_in_work "commit only on a deleted branch" 1 "is not on main; refusing to release" "$doomed"

  git -C "$work" update-ref -d refs/remotes/origin/main
  run_in_work "missing origin/main" 1 "origin/main not available; checkout needs fetch-depth: 0" HEAD
  git -C "$work" fetch origin main:refs/remotes/origin/main >/dev/null 2>&1
  run_in_work "nonexistent ref" 1 "" no-such-ref

  if [[ "$failed" -ne 0 ]]; then
    return 1
  fi
  echo "self-test: ok"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

if [[ $# -gt 1 ]]; then
  usage
fi

check_ref "${1:-HEAD}"
