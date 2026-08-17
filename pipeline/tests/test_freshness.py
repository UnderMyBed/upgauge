"""The freshness alert (#17). CLAUDE.md's hard rule: alert when `max(year_month)` has not moved
in ~45 days.

The clock is the release history, not a state file: `warehouse.yml` publishes a release ONLY
when the month advances (its "Stop if this month is already published" guard), so `publishedAt`
of the newest well-formed `warehouse-YYYY.MM` release IS the timestamp of the last advance.

Every test below names the bug it exists to catch. Two of them cannot fail against a plausible
wrong implementation unless their fixture is built to distinguish it:

  * `gh release list` returns NEWEST-FIRST, so an implementation that takes `[0]` is correct
    against every real input and wrong in principle. `test_the_newest_release_wins_regardless_
    of_input_order` feeds ascending order, which is the only input that separates them.
  * An exact `publishedAt` tie is what turns `sort | reverse | .[0]` into "pick the OLDER tag"
    (warehouse.yml carries the measurement). A fixture with distinct timestamps cannot fail
    that way, so the tie fixture ties exactly.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from freshness import THRESHOLD_DAYS, assess, main  # noqa: E402

NOW = datetime(2026, 8, 17, 12, 0, 0, tzinfo=UTC)


def _release(tag: str, published: datetime | None) -> dict:
    """The exact shape `gh release list --json tagName,publishedAt` emits."""
    return {
        "tagName": tag,
        "publishedAt": None if published is None else published.isoformat().replace("+00:00", "Z"),
    }


def _days_ago(n: int) -> datetime:
    return NOW - timedelta(days=n)


def test_a_release_published_today_is_fresh():
    """Catches an inverted comparison. This is the live state: warehouse-2026.05 published
    2026-08-14, three days before NOW."""
    v = assess([_release("warehouse-2026.05", _days_ago(3))], now=NOW)
    assert v.stale is False
    assert v.latest_tag == "warehouse-2026.05"
    assert v.days == 3


def test_a_release_older_than_the_threshold_is_stale():
    v = assess([_release("warehouse-2026.05", _days_ago(46))], now=NOW)
    assert v.stale is True
    assert v.days == 46
    assert "warehouse-2026.05" in v.cause


def test_the_threshold_day_itself_is_not_stale():
    """The boundary is `> 45`, not `>= 45`. Catches an off-by-one that would fire a day early
    every month -- and a false alarm on a working pipeline is how an alert gets ignored."""
    assert (
        assess([_release("warehouse-2026.05", _days_ago(THRESHOLD_DAYS))], now=NOW).stale is False
    )
    assert (
        assess([_release("warehouse-2026.05", _days_ago(THRESHOLD_DAYS + 1))], now=NOW).stale
        is True
    )


def test_no_release_at_all_is_stale_with_its_own_cause():
    """Catches deleting the empty branch, which would make the emptiest possible failure -- a
    repo that has never published anything -- report healthy. Silence there is the dark guard."""
    v = assess([], now=NOW)
    assert v.stale is True
    assert v.latest_tag is None
    assert v.days is None
    assert "no well-formed" in v.cause


def test_a_malformed_tag_cannot_be_the_newest_release():
    """Catches dropping the `^warehouse-\\d{4}\\.\\d{2}$` shape filter. warehouse.yml already
    documents why a prefix check is not enough: git ref names permit backticks, `$`, `;` and
    quotes, so a tag named ``warehouse-`id` `` would otherwise win. Here the junk tag is the
    NEWEST, so an unfiltered implementation reports fresh against a 100-day-old warehouse."""
    v = assess(
        [
            _release("warehouse-2026.05", _days_ago(100)),
            _release("warehouse-`id`", _days_ago(1)),
            _release("warehouse-2026.5", _days_ago(1)),
            _release("v1.2.3", _days_ago(1)),
        ],
        now=NOW,
    )
    assert v.stale is True
    assert v.latest_tag == "warehouse-2026.05"
    assert v.days == 100


def test_a_draft_release_cannot_be_the_newest():
    """Drafts carry publishedAt=null, which sorts as the smallest value in jq and raises in
    Python. Excluded, not crashed on."""
    v = assess(
        [_release("warehouse-2026.05", _days_ago(90)), _release("warehouse-2026.06", None)],
        now=NOW,
    )
    assert v.stale is True
    assert v.latest_tag == "warehouse-2026.05"


def test_the_newest_release_wins_regardless_of_input_order():
    """THE mutant that a real-input test cannot catch. `gh release list` returns newest-first,
    so `releases[0]` is right against every real response and wrong by construction. Ascending
    input is the only thing that separates "sorted" from "took the first one"."""
    ascending = [
        _release("warehouse-2026.04", _days_ago(60)),
        _release("warehouse-2026.05", _days_ago(3)),
    ]
    assert assess(ascending, now=NOW).stale is False
    assert assess(list(reversed(ascending)), now=NOW).stale is False
    assert assess(ascending, now=NOW).latest_tag == "warehouse-2026.05"


def test_an_exact_published_at_tie_resolves_to_the_newer_tag():
    """warehouse.yml measured this: `sort_by | reverse | .[0]` reverses a stable-sorted tie into
    the OLDER tag. Distinct timestamps cannot fail that way, so these tie to the second."""
    same = _days_ago(3)
    v = assess(
        [_release("warehouse-2026.05", same), _release("warehouse-2026.04", same)],
        now=NOW,
    )
    assert v.latest_tag == "warehouse-2026.05"


def test_the_issue_body_names_the_tag_the_lag_and_the_threshold():
    """A stale alert that does not say WHAT is stale or FOR HOW LONG sends the operator to the
    Actions log for facts the alert already held -- health.ts's "named cause" rule, applied
    here."""
    v = assess([_release("warehouse-2026.05", _days_ago(70))], now=NOW)
    body = v.issue_body()
    assert "warehouse-2026.05" in body
    assert "70" in body
    assert str(THRESHOLD_DAYS) in body


def test_the_no_release_issue_body_does_not_claim_a_lag_it_cannot_know():
    """The empty case has no tag and no day count. A body built from a shared template would
    print "None days" -- a fabricated measurement, which is the failure this repo files under
    numbers that rot."""
    body = assess([], now=NOW).issue_body()
    assert "None" not in body
    assert "no well-formed" in body


def test_main_writes_file_issue_and_a_body_when_stale(monkeypatch, tmp_path):
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("FRESHNESS_NOW", NOW.isoformat())
    monkeypatch.setattr(
        sys, "argv", ["freshness.py", json.dumps([_release("warehouse-2026.05", _days_ago(90))])]
    )
    assert main() == 0
    text = out.read_text()
    assert "file_issue=1" in text
    assert "warehouse-2026.05" in text


def test_main_writes_no_file_issue_when_fresh(monkeypatch, tmp_path):
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("FRESHNESS_NOW", NOW.isoformat())
    monkeypatch.setattr(
        sys, "argv", ["freshness.py", json.dumps([_release("warehouse-2026.05", _days_ago(3))])]
    )
    assert main() == 0
    text = out.read_text()
    assert "file_issue=1" not in text
    assert "stale=0" in text


def test_main_honours_an_injected_now(monkeypatch, tmp_path):
    """This is what makes the dispatch demonstration worth anything. If FRESHNESS_NOW did not
    reach the comparison, running the workflow with a future `as_of` would prove only that the
    workflow runs -- an alert demonstrated by a path production never takes. Same release, two
    clocks, two verdicts."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    releases = json.dumps([_release("warehouse-2026.05", _days_ago(3))])
    monkeypatch.setattr(sys, "argv", ["freshness.py", releases])

    monkeypatch.setenv("FRESHNESS_NOW", NOW.isoformat())
    main()
    assert "file_issue=1" not in out.read_text()

    monkeypatch.setenv("FRESHNESS_NOW", (NOW + timedelta(days=200)).isoformat())
    main()
    assert "file_issue=1" in out.read_text()


def _freshness_workflow() -> str:
    return (Path(__file__).parents[2] / ".github" / "workflows" / "freshness.yml").read_text()


def test_the_workflow_asks_gh_for_published_at_and_never_created_at():
    """The one mutant no Python test above can reach: swap the field in the `gh release list`
    query and every assertion in this file stays green while the alert measures the wrong
    clock. warehouse.yml carries the measurement -- GitHub stamps `created_at` from the tag's
    COMMIT, so `warehouse-2026.04` reports 2026-08-08T17:00:48Z (main's HEAD, to the second)
    against a real publish of 19:00:50Z, and this repo's steady state of publishing off an
    UNCHANGED main gives releases a month apart identical `created_at` values."""
    yaml_text = _freshness_workflow()
    assert "--json tagName,publishedAt" in yaml_text
    assert "createdAt" not in yaml_text


def test_the_workflow_feeds_as_of_through_env_and_never_splices_it_into_a_run_body():
    """`as_of` is dispatch-supplied text in a job holding issues:write. Actions substitutes
    `${{ }}` into a run: scalar BEFORE bash parses it, so a spliced value is source code --
    warehouse.yml's PREVIOUS_TAG and ISSUE_BODY comments are the same rule."""
    for line in _freshness_workflow().splitlines():
        if "inputs.as_of" in line:
            assert line.strip().startswith("FRESHNESS_NOW:"), (
                f"inputs.as_of must only ever appear as an env: value, found: {line.strip()}"
            )


def test_the_alert_is_gated_on_the_dedupe_count_as_well_as_on_staleness():
    """Staleness stays true every day until someone fixes it. Losing this clause turns a
    three-month stall into ninety issues, which is how an alert gets muted."""
    condition = [
        line
        for line in _freshness_workflow().splitlines()
        if "steps.existing.outputs.count" in line
    ]
    assert condition, "the file step lost its dedupe gate"
    assert "steps.check.outputs.file_issue == '1'" in condition[0]


def test_the_workflow_retries_the_release_listing_and_never_passes_it_through_empty():
    """A transient GitHub 503 is not hypothetical: `gh release list` 503ed FIVE times in one
    hour on 2026-08-17 -- twice locally, twice in ci.yml's `resolve`, and once in this
    workflow's own first live run, which is what surfaced this.

    Two distinct failures follow, and the second is the dangerous one:

      1. The alert does not run at all that day. A failed scheduled run is exactly the signal
         nobody watches (#61), so the watcher goes quiet in the way it exists to prevent.
      2. If an API error ever yields EMPTY output rather than a non-zero exit, that empty
         string reaches assess() as zero releases -- which is a STALE verdict with its own
         cause, and files a FALSE critical alert. A watcher that cries wolf on its own
         infrastructure wobble gets muted, and then it is gone for the real event.

    `[]` is a legitimate answer meaning "this repo has no releases" and must still reach the
    script; only an actual failure is guarded here."""
    yaml_text = _freshness_workflow()
    assert "for attempt in" in yaml_text, "the release listing is not retried"
    assert '[ -n "$releases" ]' in yaml_text, (
        "nothing stops a failed listing reaching freshness.py as empty input, which reports "
        "'no well-formed release' and files a false alert"
    )


def test_the_alert_assigns_and_mentions_the_repository_owner():
    """#2's criterion is an alert that reaches a HUMAN, and filing an issue is not that.

    Measured 2026-08-17, after the alert was demonstrated firing: UnderMyBed/upguage was absent
    from the owner's 6 watched repositories, `repos/.../subscription` returned 404, and issue #64
    was authored by github-actions[bot] with ZERO assignees and no `@` in its body. An issue
    opened by a bot, in an unwatched repo, that neither assigns nor mentions anyone, notifies
    nobody -- so the alert fired perfectly and reached no one.

    Assignment and mention both notify regardless of watch state, and both live in this file
    where a gate can see them. Watch settings are account configuration: correct today, silently
    revocable, and invisible to every gate in this repo -- the same objection hosting.md makes
    about correctness that exists only in a provider's dashboard."""
    yaml_text = _freshness_workflow()
    # Scoped to the COMMAND, not the file: the comment above that command says the word
    # "--assignee" while explaining why it is not used there, so a file-wide substring check
    # passes on prose after the command is gone. Measured -- that exact mutant survived.
    edit = [ln for ln in yaml_text.splitlines() if "gh issue edit" in ln]
    assert edit and "--add-assignee" in edit[0], "the alert assigns nobody"
    assert '"@$OWNER' in yaml_text, "the issue body carries no @mention of the owner"


def test_the_owner_reaches_the_shell_through_env_never_spliced():
    """Same rule as `as_of` and warehouse.yml's PREVIOUS_TAG: Actions substitutes `${{ }}` into a
    run: scalar BEFORE bash parses it. `github.repository_owner` is a constrained string today,
    but the rule exists so nobody has to re-derive that per value."""
    yaml_text = _freshness_workflow()
    # BOTH halves, because the placement check alone passes VACUOUSLY when the value is absent
    # entirely -- measured: deleting the env line left nothing for the loop to inspect and the
    # test stayed green.
    assert "OWNER: ${{ github.repository_owner }}" in yaml_text, (
        "OWNER is not defined from the repository owner at all"
    )
    for line in yaml_text.splitlines():
        if "github.repository_owner" in line:
            assert line.strip().startswith("OWNER:"), (
                f"repository_owner must only appear as an env: value, found: {line.strip()}"
            )


def test_a_failed_assignment_cannot_cost_us_the_issue():
    """The issue is the alert; assignment is delivery polish on top of it. Passing --assignee to
    `gh issue create` makes a failed assignment fail the CREATE, so a permissions or API hiccup
    would lose the alert entirely -- strictly worse than the unassigned issue we have today.

    So: create first, assign second, and let the assign fail loudly without taking the alert
    with it. The @mention is already in the body by then, so the notification does not depend on
    the assign step succeeding at all."""
    yaml_text = _freshness_workflow()
    create_at = yaml_text.index("gh issue create")
    assign_at = yaml_text.index("--add-assignee")
    assert create_at < assign_at, "assignment must come after the issue exists"
    assign_line = [ln for ln in yaml_text.splitlines() if "--add-assignee" in ln][0]
    tail = yaml_text[assign_at : assign_at + 400]
    assert "||" in assign_line or "||" in tail, (
        "a failed assignment must not fail the step that already filed the alert"
    )


def test_main_falls_back_to_the_real_clock_when_no_now_is_injected(monkeypatch, tmp_path):
    """An empty `as_of` input arrives as an empty STRING, not an unset variable -- Actions sets
    every declared env key. Treating "" as a date would raise and take the whole alert down on
    every scheduled run, which is the failure mode that fails silent."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("FRESHNESS_NOW", "")
    ancient = datetime(2020, 1, 1, tzinfo=UTC)
    monkeypatch.setattr(
        sys, "argv", ["freshness.py", json.dumps([_release("warehouse-2020.01", ancient)])]
    )
    assert main() == 0
    assert "file_issue=1" in out.read_text()
