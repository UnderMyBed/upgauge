"""The scheduled-run failure alert (#61).

The adjacent rule to #17's. That alert fires when the data STOPS moving; this one fires when
the data moved correctly and the repository's own gates went red about it. No freshness check
could ever catch the second case, and nothing else was watching:

    2026-08-14 07:59Z  Warehouse publishes warehouse-2026.05; max(year_month) 2026-04 -> 2026-05
    2026-08-15 04:49Z  Verify (reproducibility) fails. FIRST RED
    2026-08-16 04:51Z  fails again
    2026-08-17 05:00Z  fails again
    2026-08-17 16:27Z  an unrelated PR opens and reddens four jobs -- the first human signal

Three nights of red on main reached nobody. `verify.yml` did its job on the very first night.

Every test below names the bug it exists to catch. Three need a fixture built to distinguish a
plausible wrong implementation, because the obvious one passes against the obvious input:

  * Dedupe keyed on the LABEL alone suppresses every workflow after the first, and looks
    correct as long as only one workflow is ever red. `test_an_open_alert_for_a_different_
    workflow_does_not_suppress_this_one` is the only fixture that separates them.
  * Dedupe by substring is correct for every name this repo watches today, and wrong in
    principle -- so `test_dedupe_matches_the_whole_title_not_a_prefix` uses names where one
    contains the other, which no real pair currently does.
  * `conclusion != "success"` and `conclusion in {failure, timed_out}` agree on every run
    except a CANCELLED one, so only the cancelled fixture catches a deny-list written where
    CLAUDE.md requires an allow-list.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from scheduled_failure import ALERTING_CONCLUSIONS, assess, main  # noqa: E402

WORKFLOWS = Path(__file__).parents[2] / ".github" / "workflows"
NOTIFIER = WORKFLOWS / "scheduled-failure.yml"


def _run(
    name: str = "Verify (reproducibility)",
    conclusion: str = "failure",
    event: str = "schedule",
    url: str = "https://github.com/UnderMyBed/upguage/actions/runs/32105217496",
) -> dict:
    """The subset of a `workflow_run` payload this decision needs, named as GitHub names it."""
    return {"name": name, "conclusion": conclusion, "event": event, "html_url": url}


def _issue(title: str) -> dict:
    """The shape `gh issue list --json title` emits."""
    return {"title": title}


# --------------------------------------------------------------------------------------
# Which runs are worth a human's attention
# --------------------------------------------------------------------------------------


def test_a_failed_scheduled_run_files_an_alert():
    """The live case: verify.yml red at 04:49Z on a schedule, three nights running."""
    alert = assess(_run(), open_issues=[])
    assert alert.file_issue is True
    assert "Verify (reproducibility)" in alert.title


def test_a_successful_scheduled_run_never_files():
    """Catches an absent or inverted conclusion check. `workflow_run` fires on `completed`,
    which includes every green nightly -- roughly 364 of them a year."""
    assert assess(_run(conclusion="success"), open_issues=[]).file_issue is False


def test_a_cancelled_run_never_files():
    """The allow-list mutant. CLAUDE.md: a predicate over outcomes is an allow-list, never
    `!= "success"` -- the same rule the cacheability predicate is held to. A cancelled run is
    usually a human superseding it, and an alert that pages on deliberate cancellation is one
    that gets muted. `!= "success"` passes every other test in this file."""
    assert assess(_run(conclusion="cancelled"), open_issues=[]).file_issue is False


def test_a_timed_out_run_files():
    """The other half of the allow-list. `make verify` carries `timeout-minutes: 60` and
    rebuilds the warehouse twice, so a hang reports `timed_out`, not `failure` -- an
    implementation testing `== "failure"` alone goes silent on exactly the slow-death case."""
    assert assess(_run(conclusion="timed_out"), open_issues=[]).file_issue is True


def test_a_push_triggered_failure_never_files():
    """CodeQL runs on `pull_request` and `push: main` as well as its weekly schedule, so
    without an event filter this alert files an issue for every red PR -- on top of the
    existing PR checks that already reach the author. Catches a missing event filter, which no
    other fixture here can: every other run in this file is already a scheduled one."""
    assert assess(_run(name="CodeQL", event="push"), open_issues=[]).file_issue is False


def test_a_dispatched_failure_files():
    """Deliberate, and the reason is demonstrability. `workflow_run` workflows only ever run
    the copy on the default branch, so a hand-dispatched nightly is the ONLY way to exercise
    this path end to end -- the same trick freshness.yml's `as_of` input uses, where the run,
    the failure and the issue are all real and one variable moves. A nightly someone dispatched
    and walked away from is also unwatched, which is the condition this alert is about."""
    assert assess(_run(event="workflow_dispatch"), open_issues=[]).file_issue is True


# --------------------------------------------------------------------------------------
# Not burying its own repeat
# --------------------------------------------------------------------------------------


def test_an_open_alert_for_the_same_workflow_suppresses_a_second():
    """A red nightly stays red every night until someone fixes it -- three nights, in the case
    this issue was written from. Without this, that is three issues, and freshness.yml already
    paid for the lesson that an alert which buries its own repeat gets muted."""
    alert = assess(_run(), open_issues=[_issue("Scheduled run failed: Verify (reproducibility)")])
    assert alert.file_issue is False


def test_an_open_alert_for_a_different_workflow_does_not_suppress_this_one():
    """THE mutant. Dedupe keyed on the `scheduled-red` label alone -- `gh issue list --label
    scheduled-red | length`, which is exactly the shape freshness.yml uses for its single
    alert -- passes every other test in this file and silently swallows the second workflow to
    go red. A dataset advance reddens Verify AND Warehouse, so this is the live case, not a
    hypothetical: the Warehouse alert would never be filed."""
    alert = assess(_run(name="Warehouse"), open_issues=[_issue("Scheduled run failed: Freshness")])
    assert alert.file_issue is True
    assert "Warehouse" in alert.title


def test_dedupe_matches_the_whole_title_not_a_prefix():
    """Correct today by accident of naming -- no two watched workflows share a prefix -- and
    wrong in principle. A substring test means adding a workflow named `Verify` would silently
    mute `Verify (reproducibility)` for as long as the shorter one stayed red."""
    alert = assess(
        _run(name="Verify (reproducibility)"), open_issues=[_issue("Scheduled run failed: Verify")]
    )
    assert alert.file_issue is True


def test_a_closed_alert_does_not_suppress_a_new_one():
    """`open_issues` is what the workflow passes -- `gh issue list --state open`. This pins the
    contract from the script's side: whatever it is handed is treated as currently-open, so a
    workflow that drops `--state open` reddens here rather than going quietly silent forever
    after the first alert is closed."""
    alert = assess(_run(), open_issues=[])
    assert alert.file_issue is True


# --------------------------------------------------------------------------------------
# What the human actually receives
# --------------------------------------------------------------------------------------


def test_the_body_links_the_run_that_failed():
    """Without the URL the operator has to find the run by hand across five workflows. The
    whole point of this alert is that nobody was looking at the Actions tab."""
    alert = assess(
        _run(url="https://github.com/UnderMyBed/upguage/actions/runs/999"), open_issues=[]
    )
    assert "https://github.com/UnderMyBed/upguage/actions/runs/999" in alert.body


def test_the_body_names_the_workflow_and_that_it_was_unattended():
    alert = assess(_run(), open_issues=[])
    assert "Verify (reproducibility)" in alert.body
    assert "schedule" in alert.body


def test_the_body_does_not_guess_a_cause():
    """This alert knows a run went red. It does NOT know why, and a body that asserts a cause
    -- 'the dataset advanced' being the tempting one, since that is what happened the day this
    was written -- trains the reader to skip the log. CLAUDE.md: when a compound claim is found
    false, re-derive each clause; the cheaper fix is not to make the claim."""
    body = assess(_run(), open_issues=[]).body.lower()
    for guess in ("the dataset advanced", "re-pin", "data-contract failed"):
        assert guess not in body


def test_the_body_points_at_the_data_contract_as_the_first_thing_to_check():
    """Not a cause claim -- an ordering. The nightly's data-contract step is designed to say
    'any other red is a consequence of this', so it is where a reader should look first."""
    assert "data contract" in assess(_run(), open_issues=[]).body.lower()


# --------------------------------------------------------------------------------------
# The plumbing between the script and the workflow
# --------------------------------------------------------------------------------------


def test_main_writes_file_issue_with_a_title_and_a_body(monkeypatch, tmp_path):
    out = tmp_path / "out"
    out.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    assert main(["Verify (reproducibility)", "failure", "schedule", "https://x/1", "[]"]) == 0
    written = out.read_text()
    assert "file_issue=1" in written
    assert "issue_title<<" in written
    assert "issue_body<<" in written


def test_main_writes_a_zero_file_issue_when_it_should_not_file(monkeypatch, tmp_path):
    """Always written, both branches -- a key that exists only on failure is a key whose
    absence has two meanings, and the workflow's step condition reads it either way."""
    out = tmp_path / "out"
    out.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    assert main(["Verify (reproducibility)", "success", "schedule", "https://x/1", "[]"]) == 0
    written = out.read_text()
    assert "file_issue=0" in written
    assert "issue_body<<" not in written


def test_main_reads_the_open_issues_argument_and_dedupes_on_it(monkeypatch, tmp_path):
    out = tmp_path / "out"
    out.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    existing = '[{"title": "Scheduled run failed: Verify (reproducibility)"}]'
    assert main(["Verify (reproducibility)", "failure", "schedule", "https://x/1", existing]) == 0
    assert "file_issue=0" in out.read_text()


# --------------------------------------------------------------------------------------
# Assertions about the workflow YAML, which no Python test above can reach
# --------------------------------------------------------------------------------------


def _notifier_text() -> str:
    return NOTIFIER.read_text()


def _triggers(path: Path) -> dict:
    """`on:` is YAML 1.1 truthy, so PyYAML hands it back under the key `True`."""
    doc = yaml.safe_load(path.read_text())
    return doc.get("on", doc.get(True)) or {}


def test_every_scheduled_workflow_in_the_repo_is_watched():
    """The rule, not a snapshot: a workflow that runs on a schedule has no human attached to
    it, so it MUST be in the watch list. This is what makes the next scheduled workflow
    somebody adds fail loudly here instead of joining verify.yml in going red at nobody."""
    scheduled = {
        yaml.safe_load(p.read_text()).get("name", p.stem)
        for p in sorted(WORKFLOWS.glob("*.yml"))
        if p != NOTIFIER and "schedule" in (_triggers(p) or {})
    }
    watched = set(_triggers(NOTIFIER).get("workflow_run", {}).get("workflows", []))
    assert scheduled <= watched, f"scheduled but unwatched: {sorted(scheduled - watched)}"


def test_the_notifier_never_watches_itself():
    """A notifier watching itself turns one failure into an unbounded chain of runs, each
    reporting the previous one's failure to report."""
    assert yaml.safe_load(NOTIFIER.read_text())["name"] not in set(
        _triggers(NOTIFIER).get("workflow_run", {}).get("workflows", [])
    )


def test_the_alert_is_filed_only_by_the_notifier():
    """freshness.yml's header argues the general form: an alert that shares a fate with the
    thing it watches is not an alert. A notify step inside verify.yml cannot report verify.yml
    being disabled for repository inactivity, deleted, or failing before the step is reached.

    Asserted as "no other workflow files THIS alert", not as "no other workflow holds
    issues:write" -- warehouse.yml legitimately holds it to file its own drift issues, and
    freshness.yml to file the staleness alert. Writing the wider assertion would have made this
    test red for two correct reasons and taught the next reader to weaken it."""
    assert NOTIFIER.exists()
    for other in sorted(WORKFLOWS.glob("*.yml")):
        if other == NOTIFIER:
            continue
        text = other.read_text()
        assert "scheduled_failure.py" not in text, f"{other.name} files the alert itself"
        assert "scheduled-red" not in text, f"{other.name} uses the alert's dedupe label"


def test_the_nightly_gains_no_permission_from_being_watched():
    """verify.yml has no legitimate issue-filing role, so `issues: write` appearing there is
    the specific regression of folding the notifier into the thing it watches."""
    assert yaml.safe_load((WORKFLOWS / "verify.yml").read_text())["permissions"] == {
        "contents": "read"
    }


def _run_scalars(path: Path) -> list[str]:
    """Every `run:` string in the file. The `${{ }}` layer sits ABOVE YAML and Actions
    substitutes into these scalars before bash ever parses them, so this is the only context
    where an expression becomes source code."""
    doc = yaml.safe_load(path.read_text())
    return [
        step["run"]
        for job in (doc.get("jobs") or {}).values()
        for step in (job.get("steps") or [])
        if isinstance(step, dict) and isinstance(step.get("run"), str)
    ]


def test_no_untrusted_value_is_spliced_into_a_run_scalar():
    """Actions substitutes `${{ }}` into a `run:` scalar BEFORE bash parses it, so a spliced
    value is source code -- in a job holding issues:write. `workflow_run.name` is whatever the
    watched workflow's `name:` says, and the issue title and body are built from it. Same rule
    as warehouse.yml's PREVIOUS_TAG and freshness.yml's ISSUE_BODY.

    Asserted over `run:` scalars rather than over lines, because an expression in a
    `concurrency.group` or an `if:` is a different context entirely and is not a splice."""
    untrusted = (
        "github.event.workflow_run.name",
        "github.event.workflow_run.html_url",
        "github.event.workflow_run.event",
        "github.repository_owner",
        "steps.assess.outputs.issue_title",
        "steps.assess.outputs.issue_body",
    )
    for scalar in _run_scalars(NOTIFIER):
        for expression in untrusted:
            assert expression not in scalar, (
                f"{expression} is spliced into a run: block; it must arrive through env:"
            )


def test_every_untrusted_value_the_script_reads_arrives_through_env():
    """The other half: not spliced is necessary, actually wired is sufficient. A value that
    reaches neither the shell nor `env:` means the script is being handed something else."""
    doc = yaml.safe_load(NOTIFIER.read_text())
    env_values = {
        value
        for job in doc["jobs"].values()
        for step in job["steps"]
        for value in (step.get("env") or {}).values()
    }
    joined = " ".join(str(v) for v in env_values)
    for expression in ("workflow_run.name", "workflow_run.conclusion", "workflow_run.event"):
        assert expression in joined, f"{expression} never reaches the script through env:"


def test_the_yaml_prefilter_and_the_script_agree():
    """The job-level `if:` is a cost control and the script is the decision, so the prefilter
    may never be NARROWER than the allow-list -- a conclusion the script would alert on but the
    `if:` drops is an alert silently lost, with nothing red to show for it. This is what stops
    the two drifting when someone adds a conclusion to one of them."""
    condition = yaml.safe_load(NOTIFIER.read_text())["jobs"]["alert"]["if"]
    for conclusion in ALERTING_CONCLUSIONS:
        assert f"'{conclusion}'" in condition, (
            f"the script alerts on {conclusion} and the job-level if: drops it"
        )


def test_the_file_step_is_gated_on_the_scripts_decision():
    """The dedupe and the event filter both live in the script, so a file step that does not
    read its verdict has silently discarded both."""
    gated = [
        line for line in _notifier_text().splitlines() if "steps.assess.outputs.file_issue" in line
    ]
    assert gated, "the file step lost its gate on the script's verdict"


def test_the_alert_mentions_and_assigns_the_owner():
    """FILING AN ISSUE IS NOT ALERTING A HUMAN. Measured 2026-08-17: the issue #17's
    demonstration filed was authored by github-actions[bot], in a repo the owner was not
    watching, with zero assignees and no `@` anywhere in its body. It notified nobody."""
    text = _notifier_text()
    assert '"@$OWNER"' in text or "@$OWNER" in text
    assert "--add-assignee" in text


def test_the_notifier_takes_no_more_permission_than_it_needs():
    doc = yaml.safe_load(NOTIFIER.read_text())
    assert doc["permissions"] == {"contents": "read", "issues": "write"}


# --------------------------------------------------------------------------------------
# The other half of #61: the nightly must assert the data contract
# --------------------------------------------------------------------------------------


def test_the_nightly_asserts_the_data_contract():
    """Hole 1. `data-contract` lives only in ci.yml, which triggers on pull_request and
    push:main -- so the gate whose whole purpose is catching the upstream dataset moving was
    gated behind a human opening a PR, while the dataset moves on BTS's schedule."""
    text = (WORKFLOWS / "verify.yml").read_text()
    assert "make stats" in text
    assert "pipeline/reference/stats.generated.json" in text


def test_the_data_contract_runs_before_the_expensive_proof():
    """An ordering, so it is asserted as an ordering -- CLAUDE.md's rule: when the property is
    a position, assert the position, never the set of things present. `make verify` rebuilds
    the warehouse twice under a 60-minute timeout; running it first means an hour spent proving
    reproducibility against reference values already known to be stale.

    Over PARSED STEPS, not raw text. The first draft compared `text.index(...)` and stayed
    green when the step was moved to the end of the job -- both needles also occur in the
    explanatory comments, so it was asserting an ordering of prose. Found by running the
    mutant, which is the only thing that could have found it."""
    steps = yaml.safe_load((WORKFLOWS / "verify.yml").read_text())["jobs"]["verify"]["steps"]
    runs = [step.get("run") or "" for step in steps]
    contract = next(i for i, r in enumerate(runs) if "make stats" in r)
    proof = next(i for i, r in enumerate(runs) if "make verify" in r)
    assert contract < proof, (
        f"data contract is step {contract}, the 60-minute proof is step {proof}"
    )
