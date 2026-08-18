"""`deploy/provision.sh` renders `deploy/cloud-init.yaml` by splicing four sibling files
(`compose.yml`, `upgauge-deploy.sh`, `upgauge-deploy.service`, `upgauge-deploy.timer`) into
`__MARKER__` placeholders before handing the result to Hetzner as `--user-data-from-file`. A
broken render produces a box that boots clean and never deploys anything -- cloud-init logs the
YAML error somewhere on a machine nobody is watching, and `deploy/cloud-init.yaml`'s own header
comment states the render is exactly this: "each unit exists in exactly one place instead of
being duplicated here." This file is the only thing standing between that comment being true and
the box silently doing nothing, since no live box exists to fail loudly against (Task 6).

These tests run the render logic Python actually EXTRACTED from `provision.sh`'s heredoc, not a
reimplementation -- a copy in this file could drift from what ships and pass against a bug the
real script has. `python -` (script on stdin) is exactly how `provision.sh` itself invokes it.

Two real bugs were caught writing this file, both from a first-draft render that matched the
task brief's own reference implementation literally:

1. `tpl.replace(marker, ...)` matches ALL occurrences, and `cloud-init.yaml`'s own header
   comment names all four markers in one sentence to document them ("The __COMPOSE__ /
   __DEPLOY_SH__ / __SERVICE__ / __TIMER__ markers below are placeholders..."). A bare
   `.replace()` splices a whole sibling file's content into that sentence too, which is not
   only wrong content -- it breaks the surrounding YAML enough that `yaml.safe_load` raises
   `ScannerError`, never producing a document at all.
2. The first fix (matching the placeholder as a whole line via `INDENT + marker`) consumed the
   template's own leading whitespace as part of the matched text without restoring it on the
   replacement's first line, landing an unindented line inside a `content: |` block scalar --
   `yaml.safe_load` raises `ParserError` there too, for an unrelated reason.

Both are caught by `test_render_produces_valid_cloud_config_yaml` alone. A third class -- valid
YAML with WRONG content (e.g. two markers swapped to the wrong sibling file) -- parses fine and
needs the round-trip test to catch it; see that test's docstring.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).parents[2]
DEPLOY = REPO / "deploy"
PROVISION_SH = DEPLOY / "provision.sh"

# The exact TUNNEL_TOKEN value used across these tests, chosen to be obviously not a real
# credential and easy to grep for in a rendered fixture.
DUMMY_TOKEN = "dummy-test-token-do-not-use"


def _extract_heredoc(script: Path, marker: str = "PY") -> str:
    """Pull the literal Python source between `<<'PY'` and the closing `PY` line out of a
    shell script, so the render test exercises the SAME bytes `provision.sh` ships, not a
    hand-copied stand-in that could quietly diverge from it."""
    lines = script.read_text().splitlines()
    start = end = None
    for i, line in enumerate(lines):
        if start is None and line.rstrip().endswith(f"<<'{marker}'"):
            start = i + 1
        elif start is not None and line == marker:
            end = i
            break
    assert start is not None and end is not None, (
        f"could not find a <<'{marker}' ... {marker} heredoc in {script}"
    )
    return "\n".join(lines[start:end]) + "\n"


@pytest.fixture(scope="module")
def rendered(tmp_path_factory) -> str:
    """Run provision.sh's real render heredoc against the real sibling files, with a dummy
    TUNNEL_TOKEN, and return the rendered cloud-init text. Never touches hcloud/Cloudflare --
    the heredoc only reads deploy/ and writes the output path it's given."""
    script_source = _extract_heredoc(PROVISION_SH)
    out_path = tmp_path_factory.mktemp("provision-render") / "user-data.yaml"
    result = subprocess.run(
        [sys.executable, "-", str(DEPLOY), str(out_path)],
        input=script_source,
        text=True,
        capture_output=True,
        env={**os.environ, "TUNNEL_TOKEN": DUMMY_TOKEN},
    )
    assert result.returncode == 0, (
        f"render heredoc exited {result.returncode}\nstdout: {result.stdout}\n"
        f"stderr: {result.stderr}"
    )
    return out_path.read_text()


def test_render_produces_valid_cloud_config_yaml(rendered: str):
    """The bug this catches: a broken marker substitution that still writes SOME output file,
    but not one cloud-init (or anything else) can parse. Mutants that must go red here: (1) a
    bare `tpl.replace(marker, ...)` that also matches cloud-init.yaml's header comment
    (`ScannerError`), and (2) a fixed-but-still-wrong version that consumes the template's own
    indentation without restoring it on the replacement's first line (`ParserError`). Both were
    observed directly while writing this file."""
    assert rendered.startswith("#cloud-config\n"), "cloud-init requires this literal header"
    doc = yaml.safe_load(rendered.removeprefix("#cloud-config\n"))
    assert isinstance(doc, dict) and "write_files" in doc


UNIT_FILES = [
    ("/srv/upgauge/compose.yml", "compose.yml"),
    ("/srv/upgauge/upgauge-deploy.sh", "upgauge-deploy.sh"),
    ("/etc/systemd/system/upgauge-deploy.service", "upgauge-deploy.service"),
    ("/etc/systemd/system/upgauge-deploy.timer", "upgauge-deploy.timer"),
]


@pytest.mark.parametrize("write_path,source_name", UNIT_FILES)
def test_embedded_content_round_trips_byte_identical_to_disk(
    rendered: str, write_path: str, source_name: str
):
    """YAML validity alone does not prove correctness: a mutant that swaps which sibling file
    fills which marker (e.g. __COMPOSE__ <- upgauge-deploy.sh, __DEPLOY_SH__ <- compose.yml)
    still produces perfectly parseable YAML -- cloud-init would boot the box with the deploy
    script written to compose.yml's path and vice versa, and nothing anywhere would say so.
    Confirmed as a live mutant: swapping those two mappings keeps `yaml.safe_load` green and
    only this per-unit content comparison goes red."""
    doc = yaml.safe_load(rendered.removeprefix("#cloud-config\n"))
    files = {f["path"]: f["content"] for f in doc["write_files"]}
    assert write_path in files, f"cloud-init never writes {write_path}"
    assert files[write_path] == (DEPLOY / source_name).read_text()


def test_tunnel_token_is_substituted_not_left_as_a_literal_placeholder(rendered: str):
    """The bug this catches: the final `${TUNNEL_TOKEN}` substitution is a separate step from
    the four marker replacements and is easy to drop in a refactor. If it is, the box's
    /etc/upgauge/deploy.env carries the literal string `${TUNNEL_TOKEN}` instead of a
    credential, and cloudflared fails to authenticate -- a failure mode invisible here since no
    box exists to watch it fail. Confirmed as a live mutant: removing the substitution line
    leaves `${TUNNEL_TOKEN}` present in the rendered text."""
    assert "${TUNNEL_TOKEN}" not in rendered
    doc = yaml.safe_load(rendered.removeprefix("#cloud-config\n"))
    files = {f["path"]: f["content"] for f in doc["write_files"]}
    assert files["/etc/upgauge/deploy.env"] == f"TUNNEL_TOKEN={DUMMY_TOKEN}\n"


def test_no_unresolved_marker_survives_outside_the_documentation_sentence(rendered: str):
    """`cloud-init.yaml`'s header comment legitimately names all four `__MARKER__` tokens in
    prose to document them, and that sentence is expected to survive untouched. What must NOT
    survive is a marker inside `write_files[].content` -- that would mean the placeholder line
    was never matched (e.g. the render's own `assert len(hits) == 1` guard was silently
    loosened) and the box would carry the literal marker text instead of real unit content."""
    doc = yaml.safe_load(rendered.removeprefix("#cloud-config\n"))
    for f in doc["write_files"]:
        for marker in ("__COMPOSE__", "__DEPLOY_SH__", "__SERVICE__", "__TIMER__"):
            assert marker not in f["content"], f"{f['path']} still contains {marker}"
