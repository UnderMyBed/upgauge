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

A third real bug, found in review (not by the author of the above): the firewall attach lived
only inside `server create`'s `--firewall` flag, so a re-run against an already-existing box
never re-attached it -- and the box carries a public IPv6 address with sshd listening by
default, so "not attached" silently means SSH reachable from the internet. The tests below in
`TestFirewallAttachIsUnconditional` are static-structure checks over `provision.sh`'s own text
(no `hcloud` invocation, no network) -- there is no live box to assert against.
"""

from __future__ import annotations

import os
import re
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


def _bash_body_lines(script_text: str) -> list[str]:
    """`provision.sh`'s lines with the embedded Python heredoc (between `<<'PY'` and the `PY`
    that closes it) excluded. The heredoc's own `if` statements are Python, not bash, and have
    no matching `fi` -- scanning them corrupts any bash if/fi nesting check over the
    surrounding script (confirmed: the naive version of this helper, without the exclusion,
    measured the real `apply-to-resource` line at depth 1 because of the heredoc's
    `if body_lines and body_lines[-1] == "":`, one indentation level that bash never closes)."""
    out = []
    in_heredoc = False
    for line in script_text.splitlines():
        if not in_heredoc and line.rstrip().endswith("<<'PY'"):
            in_heredoc = True
            continue
        if in_heredoc:
            if line == "PY":
                in_heredoc = False
            continue
        out.append(line)
    return out


class TestFirewallAttachIsUnconditional:
    """Static-structure checks over `provision.sh`'s own bash text. No `hcloud` command is run
    here -- there is no live box to assert against, and this repo has no credentials to reach
    one, so the only thing left to verify offline is that the SCRIPT ITSELF cannot regress into
    the shape review caught: firewall attach living only inside the server-creation branch."""

    SCRIPT = PROVISION_SH.read_text()
    BASH_LINES = _bash_body_lines(SCRIPT)

    def test_attach_call_is_not_nested_inside_the_server_creation_if_else(self):
        """The bug this catches: a previous version attached the firewall only via
        `--firewall upgauge-deny-inbound` passed to `hcloud server create`, itself inside the
        `else` branch of `if <server exists>; then ... else <create> fi`. A re-run against an
        already-existing box takes the `if` branch, never reaches `server create`, and so never
        attaches anything -- the box then carries a public IPv6 address with sshd listening by
        default and no firewall in front of it, silently.

        `provision.sh` never nests one `if` inside another (every `if ... ; then ... fi` here
        is a flat, sequential block), so a plain depth counter over `if `/`fi` tokens is enough
        to prove the `apply-to-resource` call sits at depth 0 -- outside every such block, on a
        path every run takes regardless of which branch the server-existence check followed.

        Mutant run (by hand, reverted): moved the `if apply_out=$(hcloud firewall
        apply-to-resource ...); then ... fi` block back inside the server-creation `else`
        clause (2-space indented, alongside `hcloud server create`). This assertion went red
        with depth 1; reverting restored green. `test_render_produces_valid_cloud_config_yaml`
        and friends stayed green throughout, since that mutant never touches the heredoc --
        confirming this test, not the render tests, is what catches this particular bug."""
        depth = 0
        checked_a_line = False
        for line in self.BASH_LINES:
            if "hcloud firewall apply-to-resource" in line:
                assert depth == 0, (
                    f"apply-to-resource found at if/fi nesting depth {depth}, expected 0 -- "
                    "it must run on every invocation, not only inside one branch of the "
                    "server-creation check"
                )
                checked_a_line = True
            if line.lstrip().startswith("if "):
                depth += 1
            elif line.strip() == "fi":
                depth -= 1
        assert checked_a_line, "provision.sh no longer calls hcloud firewall apply-to-resource"
        assert depth == 0, (
            "unbalanced if/fi while scanning provision.sh -- the parser above "
            "is naive and something in the script no longer matches its assumptions"
        )

    def test_existence_probes_do_not_redirect_stderr_to_dev_null(self):
        """The bug this catches: `hcloud firewall describe upgauge-deny-inbound >/dev/null
        2>&1` (and the equivalent for `server describe`) make a transient Hetzner API failure
        indistinguishable from "does not exist yet" -- both come back as a non-zero exit with
        the reason thrown away, and a script that then falls through to `create` risks either
        a duplicate resource or, for the firewall specifically, treating an outage as
        "already exists" and never attaching it. The fix uses `hcloud ... list` instead (whose
        non-zero exit means ONLY "the API did not answer", mirroring `freshness.yml`'s `gh
        release list` pattern) and never discards stderr. A mutant reverting to the
        `describe ... >/dev/null 2>&1` form reintroduces exactly the swallowed-stderr pattern
        this asserts against.

        Checked over CODE lines only (comments excluded): the surrounding comment in
        `provision.sh` legitimately quotes that exact anti-pattern to explain why it was
        removed, and a test that can't tell prose from code would force that explanation out
        of the file to stay green -- exactly the kind of test this project's own house rule
        warns against (asserting a string's absence when the string's PRESENCE-as-code, not
        as text, is the actual bug)."""
        code_lines = [ln for ln in self.BASH_LINES if not ln.lstrip().startswith("#")]
        assert not any(">/dev/null 2>&1" in ln for ln in code_lines)
        assert "hcloud firewall list" in self.SCRIPT
        assert "hcloud server list" in self.SCRIPT

    def test_a_real_attach_failure_still_exits_nonzero(self):
        """The bug this catches: handling the documented `firewall_already_applied` case by
        swallowing ALL errors (`apply-to-resource ... || true`, or matching on the exit code
        alone rather than the specific error) would silently continue past a REAL failure --
        wrong credentials, a renamed firewall, an outage -- leaving the box created with no
        firewall attached and no error anywhere. Only the one documented, stable error code is
        allowed to not `exit 1`."""
        assert "|| true" not in self.SCRIPT
        assert "firewall_already_applied" in self.SCRIPT
        match = re.search(
            r"if apply_out=\$\(hcloud firewall apply-to-resource.*?\n(.*?\nfi\n)",
            self.SCRIPT,
            re.DOTALL,
        )
        assert match, "could not locate the apply-to-resource if/elif/else/fi block"
        block = match.group(1)
        assert "exit 1" in block, (
            "the apply-to-resource block has no exit 1 -- a real failure (anything other than "
            "the already-applied case) would fall through silently"
        )
