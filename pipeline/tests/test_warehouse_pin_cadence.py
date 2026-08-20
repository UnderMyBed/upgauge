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

from bump_pin import PinError, branch_for, bump, current_pin, main, pr_body  # noqa: E402

MAKEFILE = (REPO / "Makefile").read_text()

#: DERIVED, never restated. Every fixture below is relative to whatever the Makefile pins right
#: now, because the bot's whole job is to rewrite that line -- a hard-coded `warehouse-2026.05`
#: would make this suite red the first time the mechanism it tests actually fires, and `ci.yml`
#: would not catch it: the bot's PR starts no `pull_request` run (that is this feature's own
#: documented premise), so `make check` never runs on it. A hard-coded FUTURE tag is the same
#: bug with a fuse on it -- fine until the pin reaches that month, then permanently red.
PINNED = current_pin(MAKEFILE)


def _month_offset(tag: str, months: int) -> str:
    """`warehouse-YYYY.MM` shifted by whole months, rolling the year correctly."""
    year, month = (int(part) for part in tag.removeprefix("warehouse-").split("."))
    total = year * 12 + (month - 1) + months
    return f"warehouse-{total // 12:04d}.{total % 12 + 1:02d}"


NEWER = _month_offset(PINNED, 1)
OLDER = _month_offset(PINNED, -1)


def test_the_month_offset_helper_rolls_the_year():
    """Guards the fixtures themselves. An off-by-one here would hand `bump()` the tag it is
    already pinned to and turn the newer/older cases into no-ops that pass for the wrong
    reason."""
    assert _month_offset("warehouse-2026.12", 1) == "warehouse-2027.01"
    assert _month_offset("warehouse-2027.01", -1) == "warehouse-2026.12"
    assert _month_offset("warehouse-2026.05", 1) == "warehouse-2026.06"
    assert _month_offset(PINNED, 1) != PINNED


# --------------------------------------------------------------------------------------
# bump_pin.py -- the mechanical half
# --------------------------------------------------------------------------------------


#: A second `warehouse-YYYY.MM` on a line that is NOT the assignment. THE FIXTURE CARRIES ITS
#: OWN HAZARD, and that is the whole point of this constant existing.
#:
#: This test used to rely on a decoy that happened to be in the Makefile -- `warehouse-2026.04`
#: quoted in the `IMAGE_SHA` comment. Correcting that stale claim deleted the fixture, and the
#: unanchored-substitution mutant this test is named for then PASSED. CLAUDE.md's own rule,
#: landing on us: "when a renamed value was the fixture for a transform, MOVE the fixture -- a
#: replacement that no longer exercises the path passes against the very bug it exists to
#: catch." Built here, the guard can never again depend on incidental comment content.
DECOY = f"# historical: {PINNED} was the first asset the container gate ever built from"


def _pr_body() -> str:
    """The body exactly as the workflow's `pr_body` output carries it."""
    return pr_body(PINNED, NEWER, "UnderMyBed", "UnderMyBed/upguage", "https://github.com")


def test_only_the_pin_line_changes():
    """THE test for the rewriter. A rewriter implemented as a substitution over the tag SHAPE
    rewrites every `warehouse-YYYY.MM` in the file rather than the pin -- silently, since
    nothing reads prose. Anchoring on the assignment is what makes that impossible.

    Run against the real Makefile PLUS a decoy, so both halves are proven: the pin moves, and a
    same-shaped string somewhere else does not.
    """
    source = MAKEFILE + "\n" + DECOY + "\n"
    after, previous = bump(source, NEWER)
    assert previous == PINNED

    changed = [
        line
        for line in difflib.unified_diff(source.splitlines(), after.splitlines(), n=0, lineterm="")
        if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))
    ]
    assert changed == [
        f"-WAREHOUSE_TAG ?= {PINNED}",
        f"+WAREHOUSE_TAG ?= {NEWER}",
    ], f"more than the pin line moved: {changed}"
    assert DECOY in after, "the decoy tag was rewritten -- the substitution is not anchored"


def test_a_renamed_or_missing_pin_fails_loudly():
    """A silent no-op here is the whole defect wearing a different hat: the bot would report
    success, open a PR that changes nothing, and the pin would stay behind forever."""
    without = "\n".join(
        line for line in MAKEFILE.splitlines() if not line.startswith("WAREHOUSE_TAG ?=")
    )
    with pytest.raises(PinError, match="WAREHOUSE_TAG"):
        bump(without, NEWER)


def test_two_pin_lines_fail_loudly():
    """Rewriting the first of two leaves make reading the SECOND -- a later assignment wins --
    so the bot would report a bump that had no effect on what `make image` actually builds."""
    doubled = MAKEFILE + f"\nWAREHOUSE_TAG ?= {OLDER}\n"
    with pytest.raises(PinError, match="twice|2 "):
        bump(doubled, NEWER)


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
        bump(MAKEFILE, OLDER)


def test_an_already_current_pin_is_a_no_op_not_a_failure():
    """A re-dispatch against the already-pinned release must exit 0. "Warehouse" is watched by
    scheduled-failure.yml, so raising here would file a critical issue, @mention and assign the
    owner for a run in which nothing is wrong."""
    after, previous = bump(MAKEFILE, PINNED)
    assert after == MAKEFILE
    assert previous == PINNED


def test_the_branch_name_is_derived_from_the_tag():
    """One source for the branch, because the workflow pushes it, `gh pr create` names it as
    the head, and the PR body links the gate's runs filtered by it. Three hand-written copies
    would drift into a PR whose gate link points at a branch that does not exist."""
    assert branch_for(NEWER) == f"bot/warehouse-pin-{NEWER}"


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

    assert main([NEWER]) == 0

    raw = output.read_text()
    delimiters = re.findall(r"^pr_body<<(.+)$", raw, re.MULTILINE)
    assert delimiters, "pr_body was not written as a multiline block at all"
    assert re.fullmatch(r"[0-9a-f]{32}", delimiters[0]), (
        f"pr_body used a static delimiter {delimiters[0]!r} -- it must come from "
        "gha.write_multiline_output, which randomizes it per call"
    )

    parsed = _outputs(output)
    assert parsed["changed"] == "1"
    assert parsed["previous"] == PINNED
    assert parsed["branch"] == f"bot/warehouse-pin-{NEWER}"
    assert makefile.read_text() == bump(MAKEFILE, NEWER)[0]


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

    assert main([NEWER]) == 0
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


def _raw_run_scalars(job: dict) -> list[str]:
    """Every `run:` scalar EXACTLY as Actions sees it -- comments included. Actions substitutes
    `${{ }}` into this text before bash parses it, so a `#` line is a splice site like any
    other."""
    return [
        step["run"]
        for step in (job.get("steps") or [])
        if isinstance(step, dict) and isinstance(step.get("run"), str)
    ]


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


def test_the_bump_job_gates_on_the_tag_existing_and_can_still_run_after_a_failed_run():
    """THE repair path, and it turns on one word.

    A job with `needs:` is skipped when the needed job fails, unless its `if:` names a status
    function -- so a bare `needs.publish.outputs.<x> == '1'` carries an implicit `success()`.
    `classify` runs AFTER the release is created and can legitimately throw (a real upstream
    shape change is precisely when it should), which fails the publish job and skips the bump.
    Every re-dispatch afterwards hits the already-published guard, so a flag keyed on "this run
    created the release" is never set again: the release ships, the pin never moves, and the
    only signal is a generic red -- #74's own defect with a bot in front of it.

    So the guard is `always()` plus "does a release with this tag exist", never "did this run
    go well".
    """
    doc = _doc(WAREHOUSE)
    job_id, job = _bump_job()
    condition = str(job.get("if", ""))
    assert "publish" in (job.get("needs") or []) or job.get("needs") == "publish"
    assert "!cancelled()" in condition, (
        f"{job_id} carries an implicit success(), so a crash anywhere after the release is "
        "created strands the pin permanently -- no re-dispatch can reach this job. "
        "`!cancelled()` and not `always()`: they differ only on a run a human stopped."
    )
    assert "needs.publish.outputs.tag_published" in condition, (
        f"{job_id} does not gate on the tag existing"
    )
    assert "tag_published" in (doc["jobs"]["publish"].get("outputs") or {})


def _output_sources(job: dict, name: str) -> dict[str, dict]:
    """The steps a job output's expression reads, keyed by step id."""
    ids = re.findall(r"steps\.([A-Za-z0-9_-]+)\.outputs", str(job["outputs"][name]))
    by_id = {step.get("id"): step for step in job["steps"] if isinstance(step, dict)}
    missing = [i for i in ids if i not in by_id]
    assert not missing, f"`{name}` names steps that do not exist: {missing}"
    return {i: by_id[i] for i in ids}


def test_both_steps_that_can_establish_the_release_exists_declare_it():
    """The other half of the repair path. Two steps in this workflow can establish that the
    release exists -- the one that creates it, and the guard that finds it already there -- and
    `tag_published` must read BOTH. Reading only the creating step is the stall above.

    Also the anti-vacuity half: an output that is ALWAYS set gates nothing, so the creating
    step must still carry its SKIP guard and the finder must still write inside its own
    conditional branch.
    """
    publish = _doc(WAREHOUSE)["jobs"]["publish"]
    sources = _output_sources(publish, "tag_published")
    assert len(sources) == 2, (
        f"`tag_published` reads {len(sources)} step(s), expected 2 -- one source means no "
        f"re-dispatch can ever set it again: {sorted(sources)}"
    )
    runs = {i: _code(step["run"]) for i, step in sources.items()}
    creator = [i for i, run in runs.items() if "gh release create" in run]
    finder = [i for i, run in runs.items() if "gh release view" in run]
    assert creator, "no source step creates the release"
    assert finder, "no source step detects an already-published release"

    assert "SKIP" in str(sources[creator[0]].get("if", "")), (
        "the creating step lost its already-published guard, so it would run on every no-op day"
    )
    # Inside the branch, not merely in the same script. `if gh release view … then` being
    # present says nothing about where the write landed; a write after the `fi` reports the
    # release as existing on every run, including ones where the lookup found nothing.
    finder_run = runs[finder[0]]
    opened = finder_run.index("if gh release view")
    closed = finder_run.index("\nfi", opened)
    written = finder_run.index("already=", opened)
    assert opened < written < closed, (
        "the finder writes its flag outside the conditional branch -- it would report the "
        "release as existing on a run where the lookup failed"
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
    # NO ALLOW-LIST, and no whitespace assumption. An earlier form of this test matched the
    # literal `${{ <name>` with one space, against a hand-maintained tuple of expression names.
    # GitHub requires neither: `${{needs.publish.outputs.tag}}` and
    # `${{  github.repository_owner }}` both splice, and both passed that test -- and every new
    # expression was invisible to it besides. This job legitimately splices NOTHING into a
    # shell; every value it uses arrives through `env:`. So the property is the absence of the
    # construct, not the absence of five names.
    # RAW scalars, never `_code()`. A `#` inside a `run:` block is NOT a comment -- it is part
    # of a YAML scalar, and Actions substitutes `${{ }}` into that scalar's raw text before bash
    # ever parses it (test_workflow_expressions.py's docstring states this rule for the same
    # reason). Stripping `#` lines first reduced this to "no splice on non-comment lines", and
    # `# bumping to ${{ needs.publish.outputs.tag }}` passed it -- a value carrying a newline
    # ends the comment and the rest executes, in a job holding all three write scopes.
    # actionlint does not cover it either: its untrusted-input list has neither `needs.*` nor
    # `github.ref_name`.
    for scalar in _raw_run_scalars(job) + _raw_run_scalars(_doc(GATE)["jobs"]["gate"]):
        assert "${{" not in scalar, (
            "an Actions expression is spliced into a run: block -- including inside a `#` line, "
            f"which Actions substitutes into just the same. It must arrive through env:\n{scalar}"
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


def test_the_gate_fires_on_nothing_but_a_pull_request_and_a_dispatch():
    """The cost scoping, asserted rather than only argued in a comment. This target builds a
    413 MB container and runs ~338 served checks against it -- on the order of 30 minutes.
    `push: branches: [main]` reads as harmless and doubles that onto every merge, on top of
    image.yml's own build; a `schedule:` would put it on a timer the repo explicitly refuses.

    By this repo's own rule a stated property with no failing test is the one that regresses,
    and both additions survived every other test in this file."""
    assert set(_triggers(_doc(GATE))) == {"pull_request", "workflow_dispatch"}


def test_the_gate_filter_never_widens_to_a_subtree():
    """`app/src/**` or `sql/**` would make a 30-minute container build fire on nearly every PR
    in the repo -- the every-run cost the scoping exists to avoid, and both are already covered
    on every PR by ci.yml's `make app-smoke`. Named files only, so the filter stays a list
    someone must justify entry by entry."""
    offenders = [p for p in _triggers(_doc(GATE))["pull_request"]["paths"] if "*" in p]
    assert not offenders, f"the gate's path filter widened to a subtree: {offenders}"


def test_the_gate_never_writes_either_override_into_the_environment():
    """The third route to the same defect, after the command line and an `env:` block: a step
    can append to `$GITHUB_ENV`, which becomes the environment of every LATER step -- including
    the one running `make image-smoke`. `WAREHOUSE_TAG ?=` is a conditional assignment and
    smoke.sh reads `${SMOKE_DATASET_PINNED:-1}`, so either name arriving that way silently
    disarms the gate exactly as a flag would."""
    for scalar in _job_run_scalars(_doc(GATE)["jobs"]["gate"]):
        for line in scalar.splitlines():
            if "GITHUB_ENV" in line:
                assert "WAREHOUSE_TAG" not in line and "SMOKE_DATASET_PINNED" not in line, (
                    f"the gate disarms itself through $GITHUB_ENV:\n{line}"
                )


def test_the_bump_job_skips_on_an_OPEN_PR_never_merely_on_the_branch_existing():
    """The repair case this distinction exists for: the push succeeds and `gh pr create` then
    fails. The branch exists and no PR does -- and a bot keyed on the branch reports success
    and reopens nothing, every run, forever. Keyed on an open PR instead, the next run opens
    the PR against the branch already there."""
    _, job = _bump_job()
    step = next(s for s in job["steps"] if "gh pr create" in _code(s.get("run", "")))
    code = _code(step["run"])
    early_exit = code[: code.index("gh pr create")]
    assert "open_pr_for" in early_exit, "the early exit does not look for an OPEN PR"
    assert early_exit.index("open_pr_for") < early_exit.index("branch_exists"), (
        "the branch check precedes the PR check, so a branch with no PR still exits early"
    )


def test_the_gate_is_dispatched_only_when_a_PR_was_actually_opened():
    """The dispatch starts a ~30-minute container build. Gated on `changed` alone it would fire
    on every daily run for as long as an already-open bump PR stayed open, since the step above
    exits early in exactly that case without opening anything."""
    _, job = _bump_job()
    dispatch = next(s for s in job["steps"] if "gh workflow run" in _code(s.get("run", "")))
    pr_step = next(s for s in job["steps"] if "gh pr create" in _code(s.get("run", "")))
    condition = str(dispatch.get("if", ""))
    assert f"steps.{pr_step['id']}.outputs" in condition, (
        f"the dispatch is gated on {condition!r}, which is true on the early-exit path too"
    )
    # POSITIONAL, exactly like the `already=` assertion above. Presence proves nothing: with
    # `opened=1` written before the already-open early exit, the flag is set on the very path
    # that opens no PR -- and the dispatch then fires a ~30-minute container build every day
    # for as long as a bump PR stays open. That mutant passed a presence check.
    code = _code(pr_step["run"])
    exit_at = code.index("exit 0")
    written_at = code.index("opened=1")
    assert written_at > exit_at, (
        "`opened=1` is written before the already-open early exit, so it is set on the path "
        "that opens nothing"
    )


def test_the_gate_uploads_no_log_that_container_mode_never_writes():
    """`/tmp/upgauge-smoke.log` is written by `serve_next` in app/smoke.sh's HOST branch only.
    This gate runs `make image-smoke`, which sets `SMOKE_MODE=container` -- and smoke.sh's EXIT
    trap tears the container down before a later step could reach `docker logs` either. An
    upload step here publishes nothing and reports it as a yellow `if-no-files-found: warn`
    annotation: a dead diagnostic path that reads like a live one."""
    for job in _doc(GATE)["jobs"].values():
        for step in job.get("steps") or []:
            assert "upgauge-smoke.log" not in str(step.get("with") or {}), (
                "the gate uploads a log container mode never writes"
            )


def test_a_tag_with_a_trailing_newline_is_refused():
    """Python's `$` also matches immediately before a single trailing newline, so the `$` form
    of the tag pattern ACCEPTED "warehouse-2026.06\\n" and spliced a blank line in after the
    pin. No wired caller delivers that today -- `stamp` builds the tag from a regex-checked
    `ym` -- but the pattern's own comment claims both ends are anchored, and a human piping
    `cat` output into this script is one keystroke away."""
    with pytest.raises(PinError, match="warehouse-YYYY.MM"):
        bump(MAKEFILE, NEWER + "\n")


def test_the_pr_body_never_claims_the_gate_has_already_run():
    """The body is built BEFORE the PR exists and before the dispatch is attempted, so any
    past-tense claim about the gate is a check reported as performed that may not have been.
    On the dispatch-failed path the workflow refuses correctly -- but that correction lived
    only in a red Actions log, next to a PR that read "the gate above ran" and "Green: merge"."""
    body = _pr_body()
    assert "ran by" not in body, "the body asserts in the past tense that the gate ran"
    assert "is dispatched" in body, "the body does not say the gate is dispatched, not done"
    assert "Check that link before merging" in body


def test_a_failed_dispatch_is_reported_onto_the_PR_not_only_into_the_log():
    """The other half: if the dispatch never lands, the human reading the PR must be told
    there, because the PR body points at a runs link that will simply be empty."""
    _, job = _bump_job()
    step = next(s for s in job["steps"] if "gh workflow run" in _code(s.get("run", "")))
    code = _code(step["run"])
    assert "gh pr comment" in code, "a failed dispatch leaves a PR that reads as gated and is not"
    assert code.index("gh pr comment") < code.rindex("exit 1"), (
        "the PR is annotated after the step has already failed, so it never happens"
    )


def _outside_quotes(line: str) -> str:
    """`line` with every single- and double-quoted span removed."""
    return re.sub(r"\"[^\"]*\"|'[^']*'", " ", line)


RETRIED = ("gh pr create", "gh workflow run", "git push", "gh pr list")
#: Must never appear in the workflow at all: `git ls-remote --exit-code` returns 2 for
#: "absent" and 128 for a transport failure, and the obvious `if git ls-remote …; then`
#: collapses both to "absent". That handling lives in `branch_exists`, once.
FORBIDDEN = ("git ls-remote",)
#: Deliberately unretried, and each must be `||`-tolerated so it cannot fail the step: both are
#: polish on top of a PR that already exists and already mentions the owner.
TOLERATED = ("gh pr edit", "gh pr comment")


def test_every_network_call_in_the_bump_job_is_retried_or_explicitly_tolerated():
    """The retry is the NAMED mitigation for this job being able to redden a run that
    image.yml gates its build on, and it had no test -- so `gh pr list`, the first network call
    on every real bump, sat un-retried while two comments and hosting.md both said "every gh
    call is retried". A stated property with no failing test is the one that regresses.

    `gh pr list` and `git ls-remote` must not appear here at all: they live behind
    `open_pr_for`/`branch_exists`, which is where their retry and their exit-code semantics
    are."""
    _, job = _bump_job()
    for scalar in _job_run_scalars(job):
        for line in scalar.splitlines():
            # Quoted spans are MESSAGES, not call sites -- `--body "… \`gh workflow run\`
            # failed …"` names a command it does not run. Scanned outside the quotes, asserted
            # against the raw line, so `retry "gh pr create" gh pr create …` still reads as one.
            bare = _outside_quotes(line)
            for command in RETRIED:
                if command in bare:
                    assert 'retry "' in line, f"{command} is not retried:\n{line}"
            for command in FORBIDDEN:
                assert command not in bare, (
                    f"{command} is called directly rather than through the helper, so its "
                    f"exit-code handling is whatever this line does -- and a transport failure "
                    f"reads as 'branch absent':\n{line}"
                )
    joined = "\n".join(_job_run_scalars(job))
    for command in TOLERATED:
        for chunk in joined.split(command)[1:]:
            assert "||" in chunk.split("\n\n")[0], (
                f"{command} can fail the step; it is polish and must be `||`-tolerated"
            )


def test_the_retry_helper_does_not_sleep_after_its_last_attempt():
    """Waiting 25s to then give up is pure latency on a job that has already failed, and both
    loops in the helper need the guard -- one of them existing is how the other stays wrong."""
    helper = (REPO / ".github" / "scripts" / "gh_retry.sh").read_text()
    assert helper.count('[ "$attempt" -eq 5 ] && break') == 2, (
        "a retry loop sleeps after its final attempt"
    )


def test_both_network_steps_source_the_one_retry_helper():
    """One implementation. Three hand-copied loops is one implementation plus two places for it
    to be missing -- which is exactly how `gh pr list` ended up bare."""
    _, job = _bump_job()
    for step in job["steps"]:
        code = _code(step.get("run", "") or "")
        if any(c in code for c in RETRIED):
            assert "source .github/scripts/gh_retry.sh" in code, (
                f"step {step.get('name') or step.get('id')} makes a network call without the helper"
            )
