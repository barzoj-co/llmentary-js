#!/usr/bin/env bash
# Gate CI on live e2e success. Exit 0 when E2E_RESULT=success, or when a
# fork PR skipped the live job (no secrets). Same-repo skips still fail.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "Usage: $0 [--self-test]" >&2
  exit 2
}

gate() {
  local result="${E2E_RESULT-}"
  local event="${EVENT_NAME-}"
  local is_fork="${IS_FORK-}"

  if [[ "$result" == "success" ]]; then
    return 0
  fi

  if [[ "$is_fork" == "true" && "$result" == "skipped" ]]; then
    echo "skipped (fork, no secrets)"
    return 0
  fi

  if [[ "$result" == "skipped" ]]; then
    echo "::error::live e2e did not run (event=${event}, result=skipped)"
    return 1
  fi

  echo "::error::live e2e did not succeed (result=${result})"
  return 1
}

self_test() {
  local script="$ROOT/scripts/e2e-gate.sh"
  local failed=0

  run_case() {
    local result="$1"
    local event="$2"
    local fork="$3"
    local expect_code="$4"
    local expect_msg="${5-}"
    local out code=0
    out="$(E2E_RESULT="$result" EVENT_NAME="$event" IS_FORK="$fork" bash "$script" 2>&1)" || code=$?
    if [[ "$code" -ne "$expect_code" ]]; then
      echo "self-test: result=${result@Q} event=${event@Q} fork=${fork@Q}: expected exit ${expect_code}, got ${code}" >&2
      echo "$out" >&2
      failed=1
      return
    fi
    if [[ -n "$expect_msg" ]] && ! grep -F -q "$expect_msg" <<<"$out"; then
      echo "self-test: result=${result@Q} event=${event@Q} fork=${fork@Q}: missing expected message ${expect_msg@Q}" >&2
      echo "$out" >&2
      failed=1
      return
    fi
    if [[ "$expect_code" -ne 0 ]]; then
      echo "self-test: result=${result:-<empty>} event=${event} fork=${fork} → ${code} (${expect_msg})"
    else
      echo "self-test: result=${result} event=${event} fork=${fork} → 0${expect_msg:+ (${expect_msg})}"
    fi
  }

  run_case success pull_request false 0
  run_case success pull_request true 0
  run_case skipped pull_request true 0 "skipped (fork, no secrets)"
  run_case skipped pull_request false 1 "live e2e did not run (event=pull_request, result=skipped)"
  run_case skipped push false 1 "live e2e did not run (event=push, result=skipped)"
  run_case skipped workflow_dispatch false 1 "live e2e did not run (event=workflow_dispatch, result=skipped)"
  run_case skipped workflow_dispatch true 0 "skipped (fork, no secrets)"
  run_case failure pull_request true 1 "live e2e did not succeed (result=failure)"
  run_case failure pull_request false 1 "live e2e did not succeed (result=failure)"
  run_case cancelled pull_request false 1 "live e2e did not succeed (result=cancelled)"
  run_case "" pull_request false 1 "live e2e did not succeed (result=)"
  run_case unknown pull_request false 1 "live e2e did not succeed (result=unknown)"
  run_case skipped "" false 1 "live e2e did not run (event=, result=skipped)"
  run_case skipped pull_request TRUE 1 "live e2e did not run (event=pull_request, result=skipped)"

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

if [[ $# -ne 0 ]]; then
  usage
fi

gate
