#!/usr/bin/env bash
# Enforce that GitHub Actions secrets are step-scoped and that e2e-gate exists.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "Usage: $0 [--self-test] [--e2e-job <id>] [path ...]" >&2
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

INSTALL_NEEDLES = (
    "npm ci",
    "npm install",
    "npm i ",
    "pnpm install",
    "yarn install",
    "pip install",
    "python -m pip install",
    "uv sync",
    "uv pip install",
    "poetry install",
    "go mod download",
    "go get",
)

BOOL_SECRET_RE = re.compile(
    r"secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:!=|==)\s*(?:''|\"\")"
)
SECRET_RE = re.compile(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)")
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


def parse_args(argv: list[str]):
    e2e_job = "e2e"
    self_test = False
    paths: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help"):
            raise SystemExit(2)
        if arg == "--self-test":
            self_test = True
        elif arg == "--e2e-job":
            i += 1
            if i >= len(argv):
                raise SystemExit("missing value for --e2e-job")
            e2e_job = argv[i]
        elif arg.startswith("--e2e-job="):
            e2e_job = arg.split("=", 1)[1]
        elif arg.startswith("-"):
            raise SystemExit(f"unknown option: {arg}")
        else:
            paths.append(arg)
        i += 1
    return self_test, e2e_job, paths


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


def raw_secrets(text: str) -> set[str]:
    boolean = {m.group(1) for m in BOOL_SECRET_RE.finditer(text)}
    names = {m.group(1) for m in SECRET_RE.finditer(text)}
    return names - boolean


def any_secret_ref(text: str) -> bool:
    return bool(SECRET_RE.search(text))


def is_github_token_name(name: str) -> bool:
    return name == "GITHUB_TOKEN"


def is_checkout(step: dict) -> bool:
    return str(step.get("uses") or "").startswith("actions/checkout@")


def is_reusable_job(job: dict) -> bool:
    return bool(job.get("uses"))


def needs_list(needs) -> list[str]:
    if needs is None:
        return []
    if isinstance(needs, str):
        return [str(needs)]
    if isinstance(needs, list):
        return [str(item) for item in needs]
    if isinstance(needs, dict):
        return [str(key) for key in needs]
    return []


def env_values(env) -> list[tuple[object, str]]:
    if not isinstance(env, dict):
        return []
    return [(value, str(value)) for value in env.values()]


def check_file(path: Path, e2e_job: str) -> list[str]:
    errors: list[str] = []
    rel = path.as_posix()
    try:
        data = load_yaml(path)
    except yaml.YAMLError as exc:
        return [f"{rel}:1: yaml parse error: {exc}"]
    if not isinstance(data, dict):
        return [f"{rel}:1: workflow must be a mapping"]

    for name, line in trigger_names(workflow_on(data)):
        if name == "pull_request_target":
            errors.append(f"{rel}:{line}: pull_request_target is forbidden")

    env = data.get("env")
    if isinstance(env, dict):
        for value, text in env_values(env):
            if any_secret_ref(text):
                errors.append(f"{rel}:{lineno(value, lineno(env))}: secret in workflow-level env")

    jobs = data.get("jobs")
    if not isinstance(jobs, dict):
        jobs = {}

    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            continue
        job_line = lineno(job)
        secrets = job.get("secrets")
        if secrets == "inherit" or str(secrets) == "inherit":
            errors.append(
                f"{rel}:{lineno(secrets, job_line)}: secrets: inherit is forbidden; pass named secrets"
            )

        job_env = job.get("env")
        if isinstance(job_env, dict):
            for value, text in env_values(job_env):
                if any_secret_ref(text):
                    errors.append(f"{rel}:{lineno(value, lineno(job_env))}: secret in job-level env")

        if is_reusable_job(job):
            continue

        steps = job.get("steps") or []
        if not isinstance(steps, list):
            steps = []
        raw_steps: dict[str, set[int]] = {}
        first_raw_line: dict[str, int] = {}
        for index, step in enumerate(steps):
            if not isinstance(step, dict):
                continue
            step_line = lineno(step)
            run = step.get("run")
            if run is not None:
                text = str(run)
                if any_secret_ref(text):
                    errors.append(
                        f"{rel}:{lineno(run, step_line)}: secret interpolated into run:; pass it via step env"
                    )

            with_ = step.get("with")
            if isinstance(with_, dict):
                for key, value in with_.items():
                    text = str(value)
                    if not any_secret_ref(text):
                        continue
                    if str(key) == "token" and is_checkout(step):
                        continue
                    errors.append(f"{rel}:{lineno(value, lineno(with_))}: secret in with:")

            env_map = step.get("env")
            run_text = str(run) if run is not None else ""
            env_raw: set[str] = set()
            if isinstance(env_map, dict):
                for value, text in env_values(env_map):
                    env_raw.update(raw_secrets(text))
            if env_raw and any(needle in run_text for needle in INSTALL_NEEDLES):
                errors.append(f"{rel}:{lineno(env_map, step_line)}: secret on an install step")

            step_raw: set[str] = set()
            if isinstance(env_map, dict):
                for _, text in env_values(env_map):
                    step_raw.update(raw_secrets(text))
            if isinstance(with_, dict):
                for _, value in with_.items():
                    step_raw.update(raw_secrets(str(value)))
            for name in step_raw:
                if is_github_token_name(name):
                    continue
                raw_steps.setdefault(name, set()).add(index)
                first_raw_line.setdefault(name, step_line)

        for name, used in raw_steps.items():
            if len(used) > 1:
                errors.append(
                    f"{rel}:{first_raw_line[name]}: secret {name} used raw in more than one step of job {job_id}; "
                    "presence checks must use the boolean form"
                )

    if path.name == "ci.yml":
        gate = jobs.get("e2e-gate") if isinstance(jobs, dict) else None
        malformed = False
        line = 1
        if not isinstance(gate, dict):
            malformed = True
        else:
            line = lineno(gate)
            if_text = str(gate.get("if") or "")
            if "always()" not in if_text:
                malformed = True
            if e2e_job not in needs_list(gate.get("needs")):
                malformed = True
        if malformed:
            errors.append(f"{rel}:{line}: missing or malformed e2e-gate job")

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


def self_test(e2e_job: str) -> int:
    good = ROOT / "scripts" / "testdata" / "secret-scope" / "good"
    bad = ROOT / "scripts" / "testdata" / "secret-scope" / "bad"
    status = 0
    for path in sorted(good.rglob("*.y*ml")):
        errors = check_file(path, e2e_job)
        if errors:
            print(f"self-test: expected {path} to pass", file=sys.stderr)
            print("\n".join(errors), file=sys.stderr)
            status = 1
        else:
            print(f"self-test: good {path.relative_to(ROOT)}")
    for path in sorted(bad.rglob("*.y*ml")):
        errors = check_file(path, e2e_job)
        expect = expect_of(path)
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
        if expect and expect not in joined:
            print(f"self-test: {path} missing expected reason {expect!r}", file=sys.stderr)
            print(joined, file=sys.stderr)
            status = 1
            continue
        print(f"self-test: bad {path.relative_to(ROOT)} → {errors[0]}")
    if status == 0:
        print("self-test: ok")
    return status


def main() -> int:
    try:
        do_self_test, e2e_job, paths = parse_args(ARGV)
    except SystemExit as exc:
        if exc.code in (0, 1, 2):
            return int(exc.code or 0)
        print(str(exc), file=sys.stderr)
        return 2
    if do_self_test:
        return self_test(e2e_job)
    files = collect_files(paths)
    if not files:
        print("no workflow files found", file=sys.stderr)
        return 1
    errors: list[str] = []
    for path in files:
        errors.extend(check_file(path, e2e_job))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("secret-scope policy: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
