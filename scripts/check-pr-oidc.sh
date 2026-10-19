#!/usr/bin/env bash
# Forbid id-token: write on pull_request / pull_request_target workflows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "Usage: $0 [--self-test] [path ...]" >&2
  exit 2
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

if ! python3 -c 'import yaml' 2>/dev/null; then
  echo "PyYAML is required (python3 -c 'import yaml')" >&2
  exit 1
fi

python3 - "$ROOT" "$@" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(sys.argv[1])
ARGV = sys.argv[2:]
ALLOWED_IF = "github.repository == 'barzoj-co/llm-test-lab-js'"
PR_TRIGGERS = {"pull_request", "pull_request_target"}
FILE_LINE_RE = re.compile(r"[^:\s]+:\d+:")


class LineDict(dict):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._line = 1


class LineList(list):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._line = 1


class LineStr(str):
    def __new__(cls, value: str, line: int = 1):
        obj = str.__new__(cls, value)
        obj._line = line
        return obj


class LineLoader(yaml.SafeLoader):
    pass


def construct_mapping(loader: LineLoader, node: yaml.nodes.MappingNode):
    loader.flatten_mapping(node)
    pairs = []
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=True)
        value = loader.construct_object(value_node, deep=True)
        pairs.append((key, value))
    result = LineDict(pairs)
    result._line = node.start_mark.line + 1
    return result


def construct_sequence(loader: LineLoader, node: yaml.nodes.SequenceNode):
    items = [loader.construct_object(child, deep=True) for child in node.value]
    result = LineList(items)
    result._line = node.start_mark.line + 1
    return result


def construct_str(loader: LineLoader, node: yaml.nodes.ScalarNode):
    return LineStr(node.value, node.start_mark.line + 1)


def construct_bool(loader: LineLoader, node: yaml.nodes.ScalarNode):
    return yaml.SafeLoader.construct_yaml_bool(loader, node)


def construct_int(loader: LineLoader, node: yaml.nodes.ScalarNode):
    return yaml.SafeLoader.construct_yaml_int(loader, node)


def construct_float(loader: LineLoader, node: yaml.nodes.ScalarNode):
    return yaml.SafeLoader.construct_yaml_float(loader, node)


def construct_null(loader: LineLoader, node: yaml.nodes.ScalarNode):
    return yaml.SafeLoader.construct_yaml_null(loader, node)


LineLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)
LineLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_SEQUENCE_TAG, construct_sequence)
LineLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_SCALAR_TAG, construct_str)
LineLoader.add_constructor("tag:yaml.org,2002:str", construct_str)
LineLoader.add_constructor("tag:yaml.org,2002:bool", construct_bool)
LineLoader.add_constructor("tag:yaml.org,2002:int", construct_int)
LineLoader.add_constructor("tag:yaml.org,2002:float", construct_float)
LineLoader.add_constructor("tag:yaml.org,2002:null", construct_null)


def lineno(obj, default: int = 1) -> int:
    line = getattr(obj, "_line", None)
    return int(line) if isinstance(line, int) else default


def load_yaml(path: Path):
    return yaml.load(path.read_text(), Loader=LineLoader)


def workflow_on(data):
    if not isinstance(data, dict):
        return None
    if "on" in data:
        return data["on"]
    # PyYAML 1.1: unquoted `on` is a boolean key.
    if True in data:
        return data[True]
    return None


def trigger_names(on) -> list[tuple[str, int]]:
    found: list[tuple[str, int]] = []
    if isinstance(on, str):
        found.append((str(on), lineno(on)))
    elif isinstance(on, list):
        for item in on:
            found.append((str(item), lineno(item, lineno(on))))
    elif isinstance(on, dict):
        for key in on:
            found.append((str(key), lineno(key, lineno(on))))
    return found


def permission_write_all(perms) -> bool:
    return isinstance(perms, str) and str(perms) == "write-all"


def permission_id_token_write(perms) -> bool:
    if not isinstance(perms, dict):
        return False
    return str(perms.get("id-token") or "") == "write"


def id_token_perm_line(perms, default: int) -> int:
    if isinstance(perms, dict):
        for key in perms:
            if str(key) == "id-token":
                return lineno(key, lineno(perms, default))
        return lineno(perms, default)
    return lineno(perms, default)


def normalize_if(value) -> str:
    return " ".join(str(value or "").split())


def check_file(path: Path) -> list[str]:
    errors: list[str] = []
    rel = path.as_posix()
    try:
        data = load_yaml(path)
    except yaml.YAMLError as exc:
        return [f"{rel}:1: yaml parse error: {exc}"]
    if not isinstance(data, dict):
        return [f"{rel}:1: workflow must be a mapping"]

    triggers = trigger_names(workflow_on(data))
    trigger_set = {name for name, _ in triggers}
    pr_triggered = bool(trigger_set & PR_TRIGGERS)
    is_workflow_call = "workflow_call" in trigger_set

    top_perms = data.get("permissions")
    if pr_triggered:
        if permission_write_all(top_perms):
            errors.append(
                f"{rel}:{lineno(top_perms)}: permissions: write-all grants id-token: write on a pull_request-triggered workflow"
            )
        if permission_id_token_write(top_perms):
            errors.append(
                f"{rel}:{id_token_perm_line(top_perms, lineno(top_perms))}: id-token: write is forbidden on pull_request-triggered workflows"
            )

    jobs = data.get("jobs")
    if not isinstance(jobs, dict):
        return errors

    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            continue
        job_line = lineno(job)
        perms = job.get("permissions")
        has_id_token = permission_id_token_write(perms) or permission_write_all(perms)
        if pr_triggered and permission_write_all(perms):
            errors.append(
                f"{rel}:{lineno(perms, job_line)}: job {job_id}: permissions: write-all grants id-token: write on a pull_request-triggered workflow"
            )
        elif pr_triggered and permission_id_token_write(perms):
            errors.append(
                f"{rel}:{id_token_perm_line(perms, job_line)}: job {job_id}: id-token: write is forbidden on pull_request-triggered workflows"
            )
        if is_workflow_call and has_id_token and not pr_triggered:
            if normalize_if(job.get("if")) != ALLOWED_IF:
                errors.append(
                    f"{rel}:{id_token_perm_line(perms, job_line)}: job {job_id}: id-token: write on a workflow_call job must be restricted with if: {ALLOWED_IF}"
                )
    return errors


def collect_files(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    if not paths:
        files.extend(sorted((ROOT / ".github" / "workflows").glob("*.y*ml")))
        return files
    for raw in paths:
        path = Path(raw)
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
        if path.is_dir():
            files.extend(sorted(path.rglob("*.yml")))
            files.extend(sorted(path.rglob("*.yaml")))
        else:
            files.append(path)
    seen: set[Path] = set()
    unique: list[Path] = []
    for file in files:
        if file in seen:
            continue
        seen.add(file)
        unique.append(file)
    return unique


def expect_of(path: Path) -> str | None:
    first = path.read_text().splitlines()[:1]
    if not first:
        return None
    match = re.match(r"^#\s*expect:\s*(.+)$", first[0])
    return match.group(1).strip() if match else None


def self_test() -> int:
    good = ROOT / "scripts" / "testdata" / "pr-oidc" / "good"
    bad = ROOT / "scripts" / "testdata" / "pr-oidc" / "bad"
    status = 0
    for path in sorted(good.rglob("*.y*ml")):
        errors = check_file(path)
        if errors:
            print(f"self-test: expected {path} to pass", file=sys.stderr)
            print("\n".join(errors), file=sys.stderr)
            status = 1
        else:
            print(f"self-test: good {path.relative_to(ROOT)}")
    for path in sorted(bad.rglob("*.y*ml")):
        errors = check_file(path)
        expect = expect_of(path) or "id-token: write"
        joined = "\n".join(errors)
        if not errors:
            print(f"self-test: expected {path} to fail", file=sys.stderr)
            status = 1
            continue
        if not FILE_LINE_RE.search(joined):
            print(f"self-test: {path} missing file:line:", file=sys.stderr)
            print(joined, file=sys.stderr)
            status = 1
            continue
        if "id-token: write" not in joined:
            print(f"self-test: {path} missing 'id-token: write'", file=sys.stderr)
            print(joined, file=sys.stderr)
            status = 1
            continue
        if expect not in joined:
            print(f"self-test: {path} missing expected reason {expect!r}", file=sys.stderr)
            print(joined, file=sys.stderr)
            status = 1
            continue
        print(f"self-test: bad {path.relative_to(ROOT)} → {errors[0]}")
    if status == 0:
        print("self-test: ok")
    return status


def main() -> int:
    self = False
    paths: list[str] = []
    for arg in ARGV:
        if arg == "--self-test":
            self = True
        elif arg.startswith("-"):
            print(f"unknown option: {arg}", file=sys.stderr)
            return 2
        else:
            paths.append(arg)
    if self:
        return self_test()
    files = collect_files(paths)
    if not files:
        print("no workflow files found", file=sys.stderr)
        return 1
    errors: list[str] = []
    for path in files:
        errors.extend(check_file(path))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("pr-oidc policy: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
