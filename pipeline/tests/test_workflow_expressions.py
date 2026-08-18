"""An empty `${{ }}` inside a `run:` block makes a workflow unparseable by GitHub while
remaining perfectly valid YAML.

`warehouse.yml` shipped to main in exactly that state. `gh workflow list` showed it by
FILENAME rather than name -- GitHub could not read it far enough to find `name:` -- and a
dispatch returned `HTTP 422: failed to parse workflow: (Line: 116, Col: 14): An expression
was expected`. Every check applied before that merge was a YAML check (js-yaml, PyYAML, and
`yaml.safe_load` in two independent reviews) and every one of them passed, because the
Actions EXPRESSION layer sits above YAML.

The trap is that `#` inside a `run:` block is not a comment. It is part of a YAML scalar,
and Actions substitutes `${{ }}` into that scalar's raw text BEFORE bash ever parses it. A
`#` at YAML level, by contrast, is stripped by the YAML parser and never reaches Actions --
which is why the empty `${{ }}` in the explanatory comments at `.github/actions/setup/
action.yml` and `.github/workflows/warehouse.yml` are legitimate and must not be flagged.

`actionlint` covers this for `.github/workflows/`. It CANNOT cover composite actions: run it
against `.github/actions/setup/action.yml` and it reports `"jobs" section is missing`,
parsing the file as a workflow. This test is what closes that half of the gap, so it
deliberately walks every Actions YAML in the repo rather than only the ones actionlint skips.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

GITHUB_DIR = Path(__file__).parents[2] / ".github"

# `${{ }}` with nothing but whitespace between the braces. Never valid in any position.
EMPTY_EXPRESSION = re.compile(r"\$\{\{\s*\}\}")


def _run_scalars(path: Path) -> list[tuple[int, str]]:
    """Every `run:` string in the file, as (1-based line where the scalar starts, text).

    Uses `compose` rather than `safe_load` so nodes keep their source marks -- a failure
    that cannot name a line is most of the way to being ignored.
    """
    found: list[tuple[int, str]] = []
    for doc in yaml.compose_all(path.read_text()):
        stack = [doc]
        while stack:
            node = stack.pop()
            if isinstance(node, yaml.MappingNode):
                for key, value in node.value:
                    if (
                        isinstance(key, yaml.ScalarNode)
                        and key.value == "run"
                        and isinstance(value, yaml.ScalarNode)
                    ):
                        found.append((value.start_mark.line + 1, value.value))
                    stack.append(value)
            elif isinstance(node, yaml.SequenceNode):
                stack.extend(node.value)
    return found


def _actions_yaml() -> list[Path]:
    return sorted(p for p in GITHUB_DIR.rglob("*") if p.suffix in {".yml", ".yaml"} and p.is_file())


def test_the_corpus_is_not_empty():
    """Guards the gate itself. A rename of `.github/` or a bad glob would make every
    assertion below vacuously true, which is the failure mode this repo keeps finding."""
    files = _actions_yaml()
    assert len(files) >= 5, f"expected the workflows, the composite and dependabot; got {files}"
    assert any(p.name == "action.yml" for p in files), (
        "no composite action found -- this test exists to cover what actionlint cannot"
    )
    assert sum(len(_run_scalars(p)) for p in files) > 0, "no `run:` blocks found to check"


def test_no_empty_expression_in_any_run_block():
    offenders = []
    for path in _actions_yaml():
        for start_line, script in _run_scalars(path):
            for offset, line in enumerate(script.splitlines()):
                if EMPTY_EXPRESSION.search(line):
                    rel = path.relative_to(GITHUB_DIR.parent)
                    offenders.append(f"{rel}:~{start_line + offset}: {line.strip()}")
    assert not offenders, (
        "empty `${{ }}` inside a `run:` block -- GitHub will refuse to parse this file "
        "while YAML validators call it fine:\n  " + "\n  ".join(offenders)
    )
