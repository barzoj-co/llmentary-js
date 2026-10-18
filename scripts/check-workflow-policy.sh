#!/usr/bin/env bash
# Enforce workflow least-privilege, timeouts, concurrency, and e2e isolation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT

python3 - <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__import__("os").environ["ROOT"])
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
errors: list[str] = []

ALLOWED_TOP = {("contents", "read")}

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
    "release-build": {("contents", "read")},
    "publish": {("contents", "read"), ("id-token", "write")},
    "label-sync": {("issues", "write")},
    "label-dry": {("contents", "read"), ("issues", "read")},
    "default": {("contents", "read")},
}

PR_CONCURRENCY_GROUP = "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}"
PR_CANCEL = "${{ github.event_name == 'pull_request' }}"


def strip_comment(line: str) -> str:
    in_single = False
    in_double = False
    out = []
    for ch in line:
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            break
        out.append(ch)
    return "".join(out).rstrip()


def parse_indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def parse_mapping_block(lines: list[str], start: int, parent_indent: int) -> tuple[dict[str, str], int]:
    data: dict[str, str] = {}
    i = start
    while i < len(lines):
        raw = lines[i]
        if not raw.strip() or raw.lstrip().startswith("#"):
            i += 1
            continue
        indent = parse_indent(raw)
        if indent <= parent_indent:
            break
        cleaned = strip_comment(raw).strip()
        if cleaned in ("{}",):
            i += 1
            continue
        if ":" not in cleaned:
            i += 1
            continue
        key, _, value = cleaned.partition(":")
        data[key.strip()] = value.strip().strip("'\"")
        i += 1
    return data, i


def parse_on(lines: list[str]) -> set[str]:
    events: set[str] = set()
    i = 0
    while i < len(lines):
        cleaned = strip_comment(lines[i])
        if re.match(r"^on:\s*$", cleaned):
            i += 1
            while i < len(lines):
                row = strip_comment(lines[i])
                if not row.strip():
                    i += 1
                    continue
                if parse_indent(lines[i]) == 0 and row.strip() and not row.lstrip().startswith("#"):
                    break
                m = re.match(r"^\s+([A-Za-z_]+):", row)
                if m:
                    events.add(m.group(1))
                i += 1
            break
        inline = re.match(r"^on:\s*(.+)$", cleaned)
        if inline:
            rest = inline.group(1).strip()
            if rest.startswith("[") and rest.endswith("]"):
                inner = rest[1:-1]
                events.update(part.strip(" '\"") for part in inner.split(",") if part.strip())
            else:
                events.add(rest.strip(" '\""))
            break
        i += 1
    return events


def parse_concurrency(text: str) -> dict[str, str]:
    match = re.search(r"^concurrency:\s*$", text, re.M)
    if not match:
        inline = re.search(r"^concurrency:\s*(.+)$", text, re.M)
        return {"inline": inline.group(1).strip()} if inline else {}
    block = text[match.end() :]
    parsed: dict[str, str] = {}
    for line in block.splitlines():
        if not line.strip():
            continue
        if not line.startswith(" ") and not line.startswith("\t"):
            break
        cleaned = strip_comment(line).strip()
        if ":" in cleaned:
            key, _, value = cleaned.partition(":")
            parsed[key.strip()] = value.strip()
    return parsed


def parse_top_permissions(lines: list[str]) -> dict[str, str] | None:
    for idx, line in enumerate(lines):
        cleaned = strip_comment(line)
        if re.match(r"^permissions:\s*$", cleaned):
            perms, _ = parse_mapping_block(lines, idx + 1, 0)
            return perms
        inline = re.match(r"^permissions:\s*(\{\}|contents:\s*read)\s*$", cleaned)
        if inline:
            if inline.group(1) == "{}":
                return {}
            return {"contents": "read"}
    return None


def iter_jobs(lines: list[str]) -> list[dict]:
    jobs: list[dict] = []
    start = None
    for idx, line in enumerate(lines):
        if re.match(r"^jobs:\s*$", strip_comment(line)):
            start = idx + 1
            break
    if start is None:
        return jobs
    i = start
    while i < len(lines):
        raw = lines[i]
        cleaned = strip_comment(raw)
        if not cleaned.strip():
            i += 1
            continue
        indent = parse_indent(raw)
        if indent == 2 and cleaned.strip().endswith(":"):
            job_id = cleaned.strip().rstrip(":").strip()
            job_lines = [raw]
            i += 1
            while i < len(lines):
                nxt = lines[i]
                nxt_clean = strip_comment(nxt)
                if nxt_clean.strip() and parse_indent(nxt) <= 2 and parse_indent(nxt) == 2 and nxt_clean.strip().endswith(":"):
                    break
                if nxt_clean.strip() and parse_indent(nxt) == 0:
                    break
                job_lines.append(nxt)
                i += 1
            jobs.append({"id": job_id, "lines": job_lines, "text": "".join(job_lines)})
            continue
        i += 1
    return jobs


def job_name(job: dict) -> str:
    match = re.search(r"^\s+name:\s*(.+)$", job["text"], re.M)
    if not match:
        return job["id"]
    return strip_comment(match.group(1)).strip().strip("'\"")


def job_timeout(job: dict) -> bool:
    return re.search(r"^\s+timeout-minutes:\s*\d+\s*$", job["text"], re.M) is not None


def job_has_matrix(job: dict) -> bool:
    return re.search(r"^\s+matrix:\s*$", job["text"], re.M) is not None or re.search(
        r"^\s+matrix:\s*\{", job["text"], re.M
    ) is not None


def job_permissions(job: dict) -> dict[str, str] | None:
    lines = job["lines"]
    for idx, line in enumerate(lines):
        cleaned = strip_comment(line)
        if re.match(r"^\s+permissions:\s*$", cleaned):
            perms, _ = parse_mapping_block(lines, idx + 1, parse_indent(line))
            return perms
        inline = re.match(r"^\s+permissions:\s*(\{\}|contents:\s*read)\s*$", cleaned)
        if inline:
            return {} if inline.group(1) == "{}" else {"contents": "read"}
    return None


def classify(job: dict, workflow: Path) -> str:
    name = job_name(job)
    text = job["text"]
    if name.startswith("CodeQL"):
        return "codeql"
    if name == "Scorecard":
        return "scorecard"
    if name == "publish":
        return "publish"
    if name == "labels (dry run)":
        return "label-dry"
    if workflow.name == "labels.yml" and job["id"] in {"labeler", "labels"}:
        return "label-sync"
    if "release-please" in name.lower() and "dry" not in name.lower():
        return "release-please"
    if workflow.name == "release-please.yml":
        return "release-please"
    if workflow.name == "release.yml" and job["id"] == "build":
        return "release-build"
    if "codecov/codecov-action" in text or name.lower().startswith("node "):
        if "codecov/codecov-action" in text:
            return "coverage"
    return "default"


def as_pairs(perms: dict[str, str]) -> set[tuple[str, str]]:
    return {(k, v) for k, v in perms.items()}


for path in WORKFLOWS:
    text = path.read_text()
    lines = text.splitlines(keepends=True)
    events = parse_on(lines)
    top = parse_top_permissions(lines)
    if top is None:
        errors.append(f"{path.name}: missing top-level permissions")
    else:
        pairs = as_pairs(top)
        if pairs and not pairs <= ALLOWED_TOP:
            errors.append(f"{path.name}: over-broad top-level permissions {top}")

    if "pull_request" in events:
        conc = parse_concurrency(text)
        if conc.get("group") != PR_CONCURRENCY_GROUP:
            errors.append(f"{path.name}: missing PR concurrency group")
        if conc.get("cancel-in-progress") != PR_CANCEL:
            errors.append(f"{path.name}: missing PR cancel-in-progress expression")

    jobs = iter_jobs(lines)
    if not jobs:
        errors.append(f"{path.name}: no jobs parsed")
    for job in jobs:
        name = job_name(job)
        if not job_timeout(job):
            errors.append(f"{path.name}: job {job['id']!r} ({name}) missing timeout-minutes")
        perms = job_permissions(job)
        category = classify(job, path)
        if perms is not None:
            pairs = as_pairs(perms)
            allowed = ALLOWED_JOB_PERMS[category]
            if not pairs <= allowed:
                errors.append(
                    f"{path.name}: job {job['id']!r} ({name}) permissions {perms} not allowed for {category}"
                )
        if perms and perms.get("id-token") == "write":
            if category not in {"publish", "coverage", "scorecard"}:
                errors.append(f"{path.name}: job {job['id']!r} has id-token: write outside publish/coverage/Scorecard")
        if "test:e2e:openai" in job["text"] and job_has_matrix(job):
            errors.append(f"{path.name}: job {job['id']!r} runs test:e2e:openai inside a matrix")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"workflow policy ok ({len(WORKFLOWS)} workflows)")
PY
