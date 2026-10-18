#!/usr/bin/env python3
"""Enforce workflow hygiene from LTL-HYG-JS §1."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"

PR_GROUP = "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}"
PR_CANCEL = "${{ github.event_name == 'pull_request' }}"

WRITE_PERMS = {"write"}
ID_TOKEN_ALLOWED_KINDS = {"scorecard", "coverage", "publish"}

ALLOWED_JOB_PERMS = {
    "codeql": {("contents", "read"), ("actions", "read"), ("security-events", "write")},
    "scorecard": {
        ("contents", "read"),
        ("actions", "read"),
        ("security-events", "write"),
        ("id-token", "write"),
    },
    "coverage": {("contents", "read"), ("id-token", "write")},
    "release-please": {
        ("contents", "write"),
        ("pull-requests", "write"),
        ("issues", "write"),
        ("actions", "write"),
    },
    "release-please-dry": {("contents", "read"), ("pull-requests", "read")},
    "release-build": {("contents", "read")},
    "publish": {("contents", "read"), ("id-token", "write")},
    "label-sync": {("contents", "read"), ("issues", "write")},
    "label-dry": {("contents", "read"), ("issues", "read")},
    "default": {("contents", "read")},
}


def fail(errors: list[str]) -> int:
    for item in errors:
        print(item, file=sys.stderr)
    return 1


def top_level_blocks(text: str) -> dict[str, str]:
    blocks: dict[str, str] = {}
    matches = list(re.finditer(r"^([A-Za-z0-9_-]+):[ \t]*(.*)$", text, re.M))
    for index, match in enumerate(matches):
        key = match.group(1)
        rest = match.group(2)
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[start:end]
        blocks[key] = rest + ("\n" + body if body else "")
    return blocks


def job_blocks(jobs_text: str) -> dict[str, str]:
    jobs: dict[str, str] = {}
    matches = list(re.finditer(r"^  ([A-Za-z0-9_-]+):[ \t]*$", jobs_text, re.M))
    for index, match in enumerate(matches):
        key = match.group(1)
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(jobs_text)
        jobs[key] = jobs_text[start:end]
    return jobs


def parse_permissions(block: str | None) -> set[tuple[str, str]]:
    if block is None:
        return set()
    stripped = block.strip()
    if stripped in {"write-all", "read-all"}:
        return {("*", stripped)}
    if stripped in {"", "{}", "contents: read"} and "\n" not in stripped:
        if stripped == "{}":
            return set()
        if stripped == "contents: read":
            return {("contents", "read")}
        return set()
    perms: set[tuple[str, str]] = set()
    for raw in block.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        match = re.match(r"^[ \t]+([A-Za-z0-9_-]+):[ \t]*(\S+)[ \t]*$", line)
        if match:
            perms.add((match.group(1), match.group(2).strip("'\"")))
    return perms


def extract_inline_or_block(parent: str, key: str) -> str | None:
    inline = re.search(rf"^[ \t]*{re.escape(key)}:[ \t]*(\S.*)$", parent, re.M)
    if inline:
        value = inline.group(1).strip()
        if value not in {"", "|", ">"}:
            return value
    block = re.search(rf"^[ \t]*{re.escape(key)}:[ \t]*$", parent, re.M)
    if not block:
        return None
    lines = [block.group(0)]
    indent = None
    for raw in parent[block.end() :].splitlines():
        if not raw.strip():
            lines.append(raw)
            continue
        leading = len(raw) - len(raw.lstrip(" "))
        if indent is None:
            indent = leading
        if leading < (indent or 2) and raw.strip():
            break
        lines.append(raw)
    return "\n".join(lines[1:])


def has_pull_request(on_block: str) -> bool:
    return bool(re.search(r"(?m)^\s*pull_request:\s*$", on_block) or re.search(r"\bpull_request\b", on_block))


def job_kind(path: Path, job_id: str, job: str) -> str:
    name_match = re.search(r"^\s+name:\s*(.+)$", job, re.M)
    display = name_match.group(1).strip().strip("'\"") if name_match else job_id
    combined = f"{job_id} {display}".lower()
    if "scorecard" in combined:
        return "scorecard"
    if "codeql" in combined:
        return "codeql"
    if ("release-please" in combined or "release please" in combined) and "dry" in combined:
        return "release-please-dry"
    if "release-please" in combined or "release please" in combined:
        return "release-please"
    if job_id == "publish" or display.lower() == "publish":
        return "publish"
    if path.name == "release.yml" and job_id == "build":
        return "release-build"
    if "label" in combined and "dry" in combined:
        return "label-dry"
    if "label" in combined:
        return "label-sync"
    if "codecov/codecov-action" in job:
        return "coverage"
    return "default"


def check_workflow(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text()
    blocks = top_level_blocks(text)
    if "permissions" not in blocks:
        errors.append(f"{path}: missing top-level permissions")
    else:
        perms = parse_permissions(blocks["permissions"])
        if perms not in (set(), {("contents", "read")}):
            errors.append(f"{path}: top-level permissions are missing or over-broad: {sorted(perms)}")
        if any(value in WRITE_PERMS or value == "write-all" for _, value in perms):
            errors.append(f"{path}: top-level permissions must not grant write")

    on_block = blocks.get("on", "")
    if has_pull_request(on_block):
        concurrency = blocks.get("concurrency", "")
        if PR_GROUP not in concurrency:
            errors.append(f"{path}: missing PR concurrency.group")
        if PR_CANCEL not in concurrency:
            errors.append(f"{path}: missing PR concurrency.cancel-in-progress")

    jobs_text = blocks.get("jobs")
    if not jobs_text:
        errors.append(f"{path}: no jobs")
        return errors

    for job_id, job in job_blocks(jobs_text).items():
        if not re.search(r"^\s+timeout-minutes:\s*\d+\s*$", job, re.M):
            errors.append(f"{path}: job {job_id!r} is missing timeout-minutes")
        kind = job_kind(path, job_id, job)
        perm_block = extract_inline_or_block(job, "permissions")
        job_perms = parse_permissions(perm_block if perm_block is not None else None)
        if perm_block is None:
            job_perms = set()
        allowed = ALLOWED_JOB_PERMS[kind]
        extra = job_perms - allowed
        if extra:
            # A job may use a narrower subset of its allow-list, or inherit top-level.
            if job_perms and not job_perms <= allowed:
                errors.append(
                    f"{path}: job {job_id!r} permissions {sorted(job_perms)} are not listed in §1 for {kind}"
                )
        if any(key == "id-token" and value == "write" for key, value in job_perms):
            if kind not in ID_TOKEN_ALLOWED_KINDS:
                errors.append(
                    f"{path}: job {job_id!r} has id-token: write outside publish/coverage/Scorecard"
                )
        has_matrix = bool(re.search(r"^\s+strategy:\s*$", job, re.M) and re.search(r"\bmatrix:\b", job))
        if has_matrix and "test:e2e:openai" in job:
            errors.append(f"{path}: job {job_id!r} runs test:e2e:openai inside a matrix")
    return errors


def main() -> int:
    if not WORKFLOWS.is_dir():
        print(f"missing {WORKFLOWS}", file=sys.stderr)
        return 1
    errors: list[str] = []
    for path in sorted(WORKFLOWS.glob("*.y*ml")):
        errors.extend(check_workflow(path))
    if errors:
        return fail(errors)
    print("workflow policy: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
