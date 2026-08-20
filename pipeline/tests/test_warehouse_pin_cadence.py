"""The `WAREHOUSE_TAG` / smoke-needle fixture and the cadence that keeps the two together (#74).

`Makefile`'s `WAREHOUSE_TAG` pins which published release the container is built from, and
`app/smoke.sh`'s dataset-pinned needles assert month-specific values measured against that same
asset. They are ONE fixture. Measured: the pin sat on `warehouse-2026.04` for four days after
the needles had already been re-pinned to `2026.05`, and every gate stayed green throughout.

Nothing asserted the coupling because nothing ran the one form that can see it. `image.yml`
does invoke `make image-smoke`, but against the NEWEST release with `SMOKE_DATASET_PINNED=0` --
the pin and the needles are both absent from that invocation by construction. The gate this file
covers runs `make image-smoke` unoverridden: pinned tag, needles on.

Two mechanisms, and the tests below are split the same way:

  * the bot -- `warehouse.yml`'s `bump-pin` job opens a PR moving the pin when a release
    publishes, so the drift is fixed at its source;
  * the gate -- `image-contract.yml` runs the coupling assertion on any PR touching either half,
    so a bot that silently stops working is loud instead of silent.

Every workflow assertion is made against PARSED YAML with `#` comment lines stripped out of
`run:` scalars. This repo's smoke-needle rule is the same lesson one layer down: a `grep` for
`image-smoke` is satisfied by a comment mentioning it, and would pass with the gate deleted.
"""

from __future__ import annotations

import difflib
import re
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).parents[2]
WORKFLOWS = REPO / ".github" / "workflows"

sys.path.insert(0, str(REPO / ".github" / "scripts"))

from bump_pin import PinError, branch_for, bump, current_pin, main  # noqa: E402

MAKEFILE = (REPO / "Makefile").read_text()


# --------------------------------------------------------------------------------------
# bump_pin.py -- the mechanical half
# --------------------------------------------------------------------------------------


def test_only_the_pin_line_changes():
    """THE test for the rewriter, run against the REAL Makefile rather than a fixture.

    A `warehouse-YYYY.MM` string appears in that file TWICE: the pin itself, and the comment
    beside `IMAGE_SHA` explaining that the repo's only git tag is lightweight. A rewriter
    implemented as a global substitution over the tag SHAPE corrupts the second one -- silently,
    since nothing else reads it -- and a synthetic one-line fixture cannot fail that way.
    """
    after, previous = bump(MAKEFILE, "warehouse-2027.01")
    assert previous == "warehouse-2026.05"

    changed = [
        line
        for line in difflib.unified_diff(
            MAKEFILE.splitlines(), after.splitlines(), n=0, lineterm=""
        )
        if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))
    ]
    assert changed == [
        "-WAREHOUSE_TAG ?= warehouse-2026.05",
        "+WAREHOUSE_TAG ?= warehouse-2027.01",
    ], f"more than the pin line moved: {changed}"


def test_a_renamed_or_missing_pin_fails_loudly():
    """A silent no-op here is the whole defect wearing a different hat: the bot would report
    success, open a PR that changes nothing, and the pin would stay behind forever."""
    without = "\n".join(
        line for line in MAKEFILE.splitlines() if not line.startswith("WAREHOUSE_TAG ?=")
    )
    with pytest.raises(PinError, match="WAREHOUSE_TAG"):
        bump(without, "warehouse-2027.01")


def test_two_pin_lines_fail_loudly():
    """Rewriting the first of two leaves make reading the SECOND -- a later assignment wins --
    so the bot would report a bump that had no effect on what `make image` actually builds."""
    doubled = MAKEFILE + "\nWAREHOUSE_TAG ?= warehouse-2026.05\n"
    with pytest.raises(PinError, match="twice|2 "):
        bump(doubled, "warehouse-2027.01")


@pytest.mark.parametrize(
    "tag",
    [
        "latest",
        "warehouse-2026.5",
        "warehouse-2026.05-dirty",
        "warehouse-`id`.01",
        "warehouse-2026.05 ; rm -rf /",
        "",
    ],
)
def test_a_tag_that_is_not_warehouse_yyyy_mm_is_refused(tag):
    """The full anchored shape, never `startswith("warehouse-")`. warehouse.yml's own resolver
    comment measured this: git ref names permit backticks, `$`, `;`, `&`, `|`, quotes and
    parens, and a prefix check constrains the prefix and nothing after it. This value ends up
    in a branch name, a commit message and a `gh pr create` invocation.
    """
    with pytest.raises(PinError, match="warehouse-YYYY.MM"):
        bump(MAKEFILE, tag)


def test_the_pin_never_moves_backwards():
    """`workflow_dispatch` can re-run the publisher, and a bump job that took whatever tag it
    was handed would walk the pin back to an older dataset -- against which the committed
    needles are wrong, so the gate would go red with no defect present."""
    with pytest.raises(PinError, match="backwards|older"):
        bump(MAKEFILE, "warehouse-2026.04")


def test_an_already_current_pin_is_a_no_op_not_a_failure():
    """A re-dispatch against the already-pinned release must exit 0. "Warehouse" is watched by
    scheduled-failure.yml, so raising here would file a critical issue, @mention and assign the
    owner for a run in which nothing is wrong."""
    after, previous = bump(MAKEFILE, "warehouse-2026.05")
    assert after == MAKEFILE
    assert previous == "warehouse-2026.05"


def test_current_pin_reads_the_committed_value():
    assert current_pin(MAKEFILE) == "warehouse-2026.05"


def test_the_branch_name_is_derived_from_the_tag():
    """One source for the branch, because the workflow pushes it, `gh pr create` names it as
    the head, and the PR body links the gate's runs filtered by it. Three hand-written copies
    would drift into a PR whose gate link points at a branch that does not exist."""
    assert branch_for("warehouse-2027.01") == "bot/warehouse-pin-warehouse-2027.01"


def _outputs(path: Path) -> dict[str, str]:
    """Parse a `$GITHUB_OUTPUT` file, supporting both `k=v` and `k<<DELIM` blocks."""
    out: dict[str, str] = {}
    lines = (path.read_text()).splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if "<<" in line:
            name, delim = line.split("<<", 1)
            body: list[str] = []
            i += 1
            while i < len(lines) and lines[i] != delim:
                body.append(lines[i])
                i += 1
            out[name] = "\n".join(body)
        elif "=" in line:
            name, value = line.split("=", 1)
            out[name] = value
        i += 1
    return out


def test_the_pr_body_uses_the_randomized_delimiter(tmp_path, monkeypatch):
    """The PR body is multiline, and this repo has exactly ONE sanctioned way to write a
    multiline `$GITHUB_OUTPUT` value: `gha.write_multiline_output`, whose delimiter is random
    per call. A static `EOF` heredoc truncates silently on a body that happens to contain the
    delimiter on its own line -- gha.py's docstring calls this a security property and says two
    copies of one is one copy plus a place for it to be wrong.
    """
    makefile = tmp_path / "Makefile"
    makefile.write_text(MAKEFILE)
    output = tmp_path / "gh-output"
    output.write_text("")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_REPOSITORY", "UnderMyBed/upguage")
    monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "UnderMyBed")
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://github.com")

    assert main(["warehouse-2027.01"]) == 0

    raw = output.read_text()
    delimiters = re.findall(r"^pr_body<<(.+)$", raw, re.MULTILINE)
    assert delimiters, "pr_body was not written as a multiline block at all"
    assert re.fullmatch(r"[0-9a-f]{32}", delimiters[0]), (
        f"pr_body used a static delimiter {delimiters[0]!r} -- it must come from "
        "gha.write_multiline_output, which randomizes it per call"
    )

    parsed = _outputs(output)
    assert parsed["changed"] == "1"
    assert parsed["previous"] == "warehouse-2026.05"
    assert parsed["branch"] == "bot/warehouse-pin-warehouse-2027.01"
    assert makefile.read_text() == bump(MAKEFILE, "warehouse-2027.01")[0]


def test_the_pr_body_states_that_ci_has_not_run_on_this_pr(tmp_path, monkeypatch):
    """The known weakness of opening the PR under GITHUB_TOKEN: GitHub starts no
    `pull_request` runs from events that token creates (image.yml's `on:` comment documents the
    same rule for `release: published`). So ci.yml has NOT run here and the gate ran by
    dispatch. A reader who merges on a green-looking PR is the failure mode, so this belongs in
    the body, not in a footnote.
    """
    (tmp_path / "Makefile").write_text(MAKEFILE)
    output = tmp_path / "gh-output"
    output.write_text("")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_REPOSITORY", "UnderMyBed/upguage")
    monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "UnderMyBed")
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://github.com")

    assert main(["warehouse-2027.01"]) == 0
    body = _outputs(output)["pr_body"]

    assert "@UnderMyBed" in body, "the PR notifies nobody without a mention"
    assert "ci.yml" in body and "has not run" in body
    assert "actions/workflows/image-contract.yml?query=branch" in body, (
        "the body must carry a direct link to the dispatched gate's runs for this branch"
    )
    assert "not re-measured" in body, (
        "the body must state that the needles were NOT re-measured, or it reads as a "
        "verification claim the bot never made"
    )


# --------------------------------------------------------------------------------------
# Workflow structure
#
# Parsed YAML throughout, with `#` lines stripped out of `run:` scalars before matching. A
# `#` at YAML level is stripped by the parser and never reaches Actions, but a `#` INSIDE a
# `run:` block is part of the scalar -- so a raw-text `grep` for `image-smoke` is satisfied by
# any of the nine comments in this repo that merely mention it, and would pass with the gate
# deleted. Same lesson as CLAUDE.md's smoke-needle rule: assert the property, never the
# presence of a string something else also produces.
# --------------------------------------------------------------------------------------

WAREHOUSE = WORKFLOWS / "warehouse.yml"
GATE = WORKFLOWS / "image-contract.yml"
IMAGE = WORKFLOWS / "image.yml"


def _doc(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def _triggers(doc: dict) -> dict:
    """`on:` parses as the boolean True under YAML 1.1, which is why every reader in this repo
    looks under both keys."""
    return doc.get("on", doc.get(True)) or {}


def _code(script: str) -> str:
    """A `run:` scalar with its comment lines removed."""
    return "\n".join(line for line in script.splitlines() if not line.lstrip().startswith("#"))


def _job_run_scalars(job: dict) -> list[str]:
    return [
        _code(step["run"])
        for step in (job.get("steps") or [])
        if isinstance(step, dict) and isinstance(step.get("run"), str)
    ]


def _bump_job() -> tuple[str, dict]:
    """The job that runs the bump script, found by what it DOES rather than by its id."""
    doc = _doc(WAREHOUSE)
    for job_id, job in doc["jobs"].items():
        if any("bump_pin.py" in scalar for scalar in _job_run_scalars(job)):
            return job_id, job
    raise AssertionError("no job in warehouse.yml runs bump_pin.py")


def test_the_warehouse_workflow_opens_the_bump_pr():
    """The bot's whole job. A bump job that stops opening a PR leaves the drift exactly where
    #74 found it -- with the added cost of a job that looks like it is handling the problem."""
    _, job = _bump_job()
    scalars = _job_run_scalars(job)
    assert any("gh pr create" in s for s in scalars), "the bump job no longer opens a pull request"
    assert any("git push" in s for s in scalars), "the branch is never pushed"


def test_the_bump_job_runs_only_when_a_release_was_actually_published():
    """ "Warehouse" runs DAILY, polling BTS, and publishes only when `max(year_month)` advances
    -- roughly monthly. Without this gate the bot would open a PR (or churn a branch) on every
    one of the ~30 no-op days a month."""
    doc = _doc(WAREHOUSE)
    job_id, job = _bump_job()
    assert "publish" in (job.get("needs") or []) or job.get("needs") == "publish"
    assert "needs.publish.outputs.published" in str(job.get("if", "")), (
        f"{job_id} does not gate on the publish job's own published output"
    )
    assert "published" in (doc["jobs"]["publish"].get("outputs") or {}), (
        "the publish job does not declare a `published` output for the bump job to read"
    )


def test_the_publish_step_is_what_declares_published():
    """The anti-vacuity half of the test above: an `if:` reading an output that is ALWAYS set
    gates nothing. The output must come from the step that actually creates the release, which
    is itself guarded by the `SKIP` check -- so on a no-op day the value is never written."""
    doc = _doc(WAREHOUSE)
    publish = doc["jobs"]["publish"]
    step_id = str(publish["outputs"]["published"]).split("steps.")[1].split(".")[0]
    source = [s for s in publish["steps"] if s.get("id") == step_id]
    assert source, f"`published` names steps.{step_id}, which does not exist"
    step = source[0]
    assert "gh release create" in _code(step["run"]), (
        "`published` is not written by the step that creates the release"
    )
    assert "SKIP" in str(step.get("if", "")), (
        "the step writing `published` is not guarded by the already-published SKIP check, so "
        "the flag would be set on every daily no-op run"
    )


def test_the_bump_job_takes_only_the_permissions_it_needs():
    """Least privilege, per job. `pull-requests: write` at workflow level would hand PR-write
    to the job that runs `make ingest` and `make build` -- the one that already holds
    contents:write, id-token:write, attestations:write and issues:write."""
    doc = _doc(WAREHOUSE)
    _, job = _bump_job()
    assert job.get("permissions") == {
        "contents": "write",
        "pull-requests": "write",
        "actions": "write",
    }
    assert "pull-requests" not in (doc.get("permissions") or {}), (
        "pull-requests was granted at workflow level, widening the publish job's token"
    )


def test_the_bump_pr_mentions_and_assigns_the_owner():
    """FILING AN ISSUE IS NOT ALERTING A HUMAN, and a bot PR is the same shape. Measured
    2026-08-17: an issue opened by github-actions[bot], in a repo the owner was not watching,
    with zero assignees and no `@` anywhere in its body, notified nobody.

    Assignment is deliberately a SEPARATE call after create, never a flag on it: a permissions
    hiccup there must not fail the create and lose the PR entirely."""
    _, job = _bump_job()
    scalars = _job_run_scalars(job)
    create = next(s for s in scalars if "gh pr create" in s)

    # The mention lives in the body `bump_pin.pr_body` builds (asserted directly above). What
    # this half must prove is that THAT body is the one `gh pr create` sends -- an inline
    # `--body "..."` written in the YAML would drop the mention while every script test stayed
    # green.
    assert '--body "$PR_BODY"' in create, "gh pr create does not send the script's body"
    body_env = {
        k: str(v)
        for step in job["steps"]
        if isinstance(step, dict)
        for k, v in (step.get("env") or {}).items()
    }
    assert "outputs.pr_body" in body_env.get("PR_BODY", ""), (
        "PR_BODY does not carry the script's pr_body output"
    )

    assert any("--add-assignee" in s for s in scalars), "the PR is never assigned"
    assert "--assignee" not in create, (
        "assignment is a flag on create -- a permissions hiccup there would fail the create "
        "and lose the PR entirely, which is strictly worse than an unassigned PR"
    )


def test_no_untrusted_value_is_spliced_into_the_bump_jobs_run_scalars():
    """Actions substitutes `${{ }}` into a `run:` scalar BEFORE bash parses it, so a spliced
    value is source code -- here, in a job holding contents:write, pull-requests:write and
    actions:write. warehouse.yml's own PREVIOUS_TAG comment measured the same rule."""
    _, job = _bump_job()
    spliceable = (
        "needs.publish.outputs.tag",
        "github.repository_owner",
        "outputs.pr_body",
        "outputs.branch",
        "outputs.previous",
    )
    for scalar in _job_run_scalars(job):
        for expression in spliceable:
            assert f"{{{{ {expression}" not in scalar.replace("${{", "{{"), (
                f"{expression} is spliced into a run: block; it must arrive through env:"
            )
    env_values = " ".join(
        str(v)
        for step in job["steps"]
        if isinstance(step, dict)
        for v in (step.get("env") or {}).values()
    )
    for expression in ("needs.publish.outputs.tag", "github.repository_owner"):
        assert expression in env_values, f"{expression} never reaches the script through env:"


# --------------------------------------------------------------------------------------
# image-contract.yml -- the gate half
# --------------------------------------------------------------------------------------


def _make_invocation(path: Path, target: str) -> tuple[dict, dict, str]:
    """`(workflow_doc, step, run_scalar)` for the step that invokes `make <target>`."""
    doc = _doc(path)
    for job in doc["jobs"].values():
        for step in job.get("steps") or []:
            if isinstance(step, dict) and isinstance(step.get("run"), str):
                code = _code(step["run"])
                if f"make {target}" in code:
                    return doc, step, code
    raise AssertionError(f"no step in {path.name} runs `make {target}`")


def _env_at_every_level(doc: dict, step: dict) -> dict:
    merged = dict(doc.get("env") or {})
    for job in doc["jobs"].values():
        merged.update(job.get("env") or {})
    merged.update(step.get("env") or {})
    return merged


def test_the_gate_runs_image_smoke_against_the_pin_with_the_needles_on():
    """THE assertion. `make image-smoke` unoverridden is the only form that can see the
    WAREHOUSE_TAG/needle coupling: the Makefile's pinned asset, and `app/smoke.sh`'s
    dataset-pinned checks enabled at their default.

    image.yml also runs `make image-smoke`, and cannot substitute for this one -- it resolves
    the NEWEST release and passes `SMOKE_DATASET_PINNED=0`, so both halves of the fixture are
    absent from that invocation by construction (see the test below, which pins that).

    Both variables are checked in `env:` as well as in the command. `WAREHOUSE_TAG ?=` is a
    conditional assignment, so an environment variable of that name WINS over the Makefile's
    pin; `app/smoke.sh` reads `${SMOKE_DATASET_PINNED:-1}`, so an environment variable turns
    the needles off just as effectively as a command-line override would.
    """
    doc, step, code = _make_invocation(GATE, "image-smoke")
    assert "SMOKE_DATASET_PINNED" not in code, (
        "the gate overrides SMOKE_DATASET_PINNED -- with the needles off it asserts nothing "
        "about the fixture it exists for"
    )
    assert "WAREHOUSE_TAG" not in code, (
        "the gate overrides WAREHOUSE_TAG -- it must build from the Makefile's committed pin, "
        "which is the half of the fixture under test"
    )
    env = _env_at_every_level(doc, step)
    assert "SMOKE_DATASET_PINNED" not in env
    assert "WAREHOUSE_TAG" not in env


def test_the_gate_is_triggered_by_a_pr_touching_either_half_of_the_fixture():
    """A workflow that exists and never fires is exactly the defect #74 reports. The path
    filter must cover BOTH halves: `Makefile` (which the bot's own PR touches, and which is how
    the monthly release reaches this gate at all) and `app/smoke.sh` (which is what a human
    re-measuring needles touches)."""
    paths = _triggers(_doc(GATE))["pull_request"]["paths"]
    for half in ("Makefile", "app/smoke.sh", "Dockerfile"):
        assert half in paths, f"a PR touching {half} would not reach this gate"


def test_every_path_the_gate_filters_on_exists():
    """A `paths:` entry that matches no file is a silently disabled gate -- it fires on nothing
    and reports nothing, and no run appears anywhere to suggest something is wrong. This repo's
    recurring failure is a gate that passes for the wrong reason; this is that shape one level
    up, where the gate does not run at all."""
    paths = _triggers(_doc(GATE))["pull_request"]["paths"]
    missing = [p for p in paths if "*" not in p and not (REPO / p).exists()]
    assert not missing, f"path filter names files that do not exist: {missing}"


def test_the_bump_job_dispatches_the_gate_and_the_gate_accepts_dispatch():
    """GitHub starts no `pull_request` runs from a PR opened with GITHUB_TOKEN (image.yml's
    `on:` comment documents the same rule for `release: published`). The dispatch is therefore
    the bot PR's ONLY gate coverage, and it fails at runtime if the gate stops declaring
    `workflow_dispatch` -- silently ungating every future bump PR."""
    _, job = _bump_job()
    dispatches = [s for s in _job_run_scalars(job) if "gh workflow run" in s]
    assert dispatches, "the bump job does not dispatch the gate on its own branch"
    assert any(GATE.name in s for s in dispatches), f"the dispatch does not name {GATE.name}"
    assert any("--ref" in s for s in dispatches), "the dispatch does not target the bump branch"
    assert "workflow_dispatch" in _triggers(_doc(GATE)), (
        "the gate no longer accepts workflow_dispatch, so the bump job's dispatch would fail "
        "and every bot PR would be ungated"
    )


def test_image_yml_still_runs_the_needle_free_form():
    """The two invocations assert different things and must not be 'unified'. image.yml builds
    the PRODUCTION image from the newest published release, which is ahead of the committed
    needles by design between a release and its bump PR merging -- so turning the needles on
    there would make every production image build red the day BTS advances, for no defect."""
    _, step, code = _make_invocation(IMAGE, "image-smoke")
    assert "SMOKE_DATASET_PINNED=0" in code, (
        "image.yml's production build no longer disables the dataset-pinned needles"
    )
    assert "WAREHOUSE_TAG" in code and "steps.warehouse.outputs.tag" in str(
        (step.get("env") or {}).get("WAREHOUSE_TAG", "")
    ), "image.yml no longer builds against the resolved newest release"
