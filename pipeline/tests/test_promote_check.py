"""`promote.yml`'s decision half (task 7 of the deploy runbook, #19).

`promote_check.py`'s own docstring has the bug this file exists to catch: the workflow's first
draft parsed the promoted tag with bash's `${TAG%-*}` / `${TAG##*-}`, which splits on the LAST
`-` in the string. `UPGAUGE_BUILD_SHA` is `git describe --always --dirty --abbrev=7`, so a dirty
tree's tag is `warehouse-2026.05-a2020f0-dirty` -- and splitting on the last `-` lands inside
`-dirty`, not at the warehouse/sha boundary. A perfectly good deploy would then fail its own
health poll forever, comparing a mangled "dirty" against a live sha that can never equal it.

`test_a_dirty_sha_matches` is THE test that separates the fix from the bug: a clean sha has no
extra `-`, so bash's naive split and the shape-anchored parse in this file agree on it and a
clean-only fixture would pass under either implementation.

The second family of tests here is about what the poll says when its budget runs out. That path
ordered a real production rollback on evidence it did not have -- see `promote_check.py`'s
`exhausted_report`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from promote_check import _HAND_CHECK, assess, main, parse_promoted_tag  # noqa: E402

TAG = "warehouse-2026.05-6ea164b"
DIRTY_TAG = "warehouse-2026.05-a2020f0-dirty"


#: What the runner was actually served on 2026-08-1x, in place of the health report: an HTTP
#: success carrying HTML. Empty would have parsed under the old `or "{}"`; this did not.
CHALLENGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>'


def _health(warehouse: str, sha: str, status: str = "ok") -> str:
    """The exact shape `/api/health` returns (`app/src/lib/health.ts`'s `HealthReport`),
    serialized -- `assess` takes the BODY, because whether it parsed is part of the verdict."""
    return json.dumps({"status": status, "build": {"warehouse": warehouse, "sha": sha}, "data": {}})


def test_a_clean_sha_matches():
    v = assess(TAG, _health("warehouse-2026.05", "6ea164b"), 200)
    assert v.matched is True
    assert v.expected_warehouse == "warehouse-2026.05"
    assert v.expected_sha == "6ea164b"


def test_a_dirty_sha_matches():
    """THE mutant: naive last-dash splitting yields expected sha `dirty` and expected warehouse
    `warehouse-2026.05-a2020f0`, neither of which any live build could ever report. This fixture
    is the only one that separates that bug from the fix -- see the module docstring."""
    v = assess(DIRTY_TAG, _health("warehouse-2026.05", "a2020f0-dirty"), 200)
    assert v.matched is True
    assert v.expected_warehouse == "warehouse-2026.05"
    assert v.expected_sha == "a2020f0-dirty"


def test_a_mismatched_warehouse_does_not_match():
    v = assess(TAG, _health("warehouse-2026.04", "6ea164b"), 200)
    assert v.matched is False
    assert "warehouse-2026.04" in v.reason
    assert "warehouse-2026.05" in v.reason


def test_a_mismatched_sha_does_not_match():
    v = assess(TAG, _health("warehouse-2026.05", "eb4da0d"), 200)
    assert v.matched is False
    assert "eb4da0d" in v.reason
    assert "6ea164b" in v.reason


def test_a_health_report_missing_build_entirely_does_not_match():
    """`build` is non-optional on `HealthReport` and `identity()` computes it before every
    return branch (`app/src/lib/health.ts`), so JSON without one did not come from this app at
    all. It must read as "not yet", with a reason that says so, not as a crash on
    `health["build"]` -- and it is NOT a reading of the box's build."""
    v = assess(TAG, "{}", 200)
    assert v.matched is False
    assert "no `build` section" in v.reason
    assert v.read_a_build is False


def test_a_non_dict_build_does_not_crash():
    """Catches dropping the `isinstance(build, dict)` guard. A malformed or hand-edited health
    body could carry `build` as anything -- this must degrade to the same "not yet" reason as a
    missing key, never raise."""
    v = assess(TAG, '{"build": "not-a-dict"}', 200)
    assert v.matched is False
    assert "no `build` section" in v.reason


def test_a_tag_that_does_not_match_the_warehouse_shape_is_named_as_such():
    """Catches dropping the shape anchor entirely -- e.g. accepting any string with a dash in
    it, which is exactly the bug this whole module exists to fix in a different guise."""
    v = assess("not-a-warehouse-tag", _health("not-a-warehouse-tag", "abc1234"), 200)
    assert v.matched is False
    assert "does not match the warehouse-YYYY.MM-<sha> shape" in v.reason


def test_parse_promoted_tag_splits_on_the_warehouse_prefix_not_the_last_dash():
    assert parse_promoted_tag(TAG) == ("warehouse-2026.05", "6ea164b")
    assert parse_promoted_tag(DIRTY_TAG) == ("warehouse-2026.05", "a2020f0-dirty")
    assert parse_promoted_tag("garbage") is None


def test_main_returns_0_and_writes_matched_1_on_a_match(monkeypatch, tmp_path):
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, "200", _health("warehouse-2026.05", "6ea164b")]
    )
    assert main() == 0
    text = out.read_text()
    assert "matched=1" in text


def test_main_returns_1_and_writes_matched_0_on_a_mismatch(monkeypatch, tmp_path):
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, "200", _health("warehouse-2026.04", "6ea164b")]
    )
    assert main() == 1
    text = out.read_text()
    assert "matched=0" in text


def test_main_treats_a_body_that_does_not_parse_as_json_as_not_yet_matched(monkeypatch, tmp_path):
    """A `curl` that half-succeeds (truncated response, an HTML error page from an intermediary)
    can hand this script a body that is not valid JSON at all. That must poll again, not crash
    the whole workflow on one flaky fetch."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, "502", "<html>502 Bad Gateway</html>"]
    )
    assert main() == 1
    assert "no `build` section" in out.read_text() or "matched=0" in out.read_text()


def test_main_validates_a_well_formed_tag_with_no_health_report(monkeypatch, tmp_path):
    """Fix round 1, finding 1: a single positional argument is the validate-only call shape
    `promote.yml`'s new pre-flight step uses, so a typo'd tag fails in seconds instead of after
    the full 30-attempt poll budget. No health report exists yet at this point, so nothing is
    written to `GITHUB_OUTPUT` -- there is no `Verdict` to report."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(sys, "argv", ["promote_check.py", TAG])
    assert main() == 0
    assert not out.exists()


def test_main_fails_fast_on_a_malformed_tag_with_no_health_report(monkeypatch, tmp_path, capsys):
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(sys, "argv", ["promote_check.py", "not-a-warehouse-tag"])
    assert main() == 1
    assert "does not match the warehouse-YYYY.MM-<sha> shape" in capsys.readouterr().out
    assert not out.exists()


def _promote_workflow() -> str:
    return (Path(__file__).parents[2] / ".github" / "workflows" / "promote.yml").read_text()


def _promote_emitted() -> str:
    """Every string the workflow can EMIT, with bash comment lines removed.

    CLAUDE.md's needle rule -- write the check against the bytes that are emitted, not the bytes
    the source contains. `yaml.safe_load` drops YAML-level comments; the `#` lines inside a
    `run:` scalar are bash comments that survive it and are still never emitted, so they come
    out here too. Without this, a comment EXPLAINING a removed message reads as the message
    still being there, and -- far worse in the other direction -- a real `echo` could hide
    behind one.
    """
    doc = yaml.safe_load(_promote_workflow())
    out: list[str] = []

    def walk(node) -> None:
        if isinstance(node, str):
            out.extend(ln for ln in node.splitlines() if not ln.strip().startswith("#"))
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    return "\n".join(out)


def test_the_workflow_feeds_the_tag_through_env_and_never_splices_it():
    """Same rule as `warehouse.yml`'s `PREVIOUS_TAG`/`ISSUE_BODY` and `freshness.yml`'s
    `as_of`: Actions substitutes `${{ }}` into a `run:` scalar BEFORE bash parses it, and `tag`
    is dispatch-supplied text in a job holding `packages: write`."""
    for line in _promote_workflow().splitlines():
        if "inputs.tag" in line:
            assert line.strip().startswith("TAG:") or "description:" in line, (
                f"inputs.tag must only ever appear as an env: value or the input's own "
                f"description, found: {line.strip()}"
            )


def test_the_workflow_never_reintroduces_the_last_dash_split():
    """The regression this whole file exists to prevent: `${TAG%-*}` / `${TAG##*-}` back in the
    workflow text would silently bypass `promote_check.py` and reintroduce the `-dirty` bug even
    though every test above still passes, because they'd be testing a module the workflow no
    longer calls."""
    yaml_text = _promote_workflow()
    assert "${TAG%-*}" not in yaml_text
    assert "${TAG##*-}" not in yaml_text
    assert "promote_check.py" in yaml_text


def test_the_workflow_retries_the_imagetools_calls():
    """Both calls are separate network requests to the registry, so each needs its OWN retry
    loop -- a single shared loop around only one of them would leave the other a bare,
    unretried call. `.count()`, not a single membership check: a membership check stays green
    if only ONE of the two loops survives, which is exactly the gap a first draft of this test
    left open (measured: removing just the `inspect` retry kept this test green)."""
    yaml_text = _promote_workflow()
    assert "imagetools inspect" in yaml_text
    assert "imagetools create" in yaml_text
    assert yaml_text.count("for attempt in 1 2 3 4 5") >= 2, (
        "each imagetools call needs its own retry loop"
    )


def test_the_workflow_delegates_the_exhausted_verdict_to_the_script():
    """Replaces an assertion that `ROLL BACK NOW` appeared in this file. It did -- in a bare
    `echo`, emitted whatever the poll had observed, which is the defect: a message hardcoded in
    bash cannot be conditional on the evidence. The remedy now comes from `exhausted_report`,
    where the two tests above pin which verdict earns it, so its ABSENCE from the YAML is the
    property to hold. Both halves are asserted: delegation present, and no unconditional copy
    left behind for the delegation to be bypassed by."""
    emitted = _promote_emitted()
    assert "--exhausted" in emitted, "the exhausted path no longer asks the script for a verdict"
    assert "ROLL BACK NOW" not in emitted, (
        "an unconditional rollback instruction is back in the workflow's emitted text -- bash "
        "cannot condition it on whether a build was ever read, which is the whole defect"
    )
    poll_at = emitted.index("for attempt in $(seq 1 30)")
    assert poll_at < emitted.index("--exhausted"), (
        "the exhausted verdict must come AFTER the poll budget, not before"
    )


def test_the_workflow_treats_a_curl_failure_as_not_yet_not_as_abandoning_the_poll():
    """The curl-failure fallback must stay INSIDE the retry loop, not replace it -- catches
    collapsing the 30-attempt poll down to a single curl-or-give-up. `|| echo 000` is that
    fallback now that the poll measures a status: curl that never gets a response line has no
    code to report, and 000 is what `assess` reads as "the fetch did not complete"."""
    yaml_text = _promote_workflow()
    assert "for attempt in $(seq 1 30)" in yaml_text
    assert "|| echo 000" in yaml_text
    assert yaml_text.index("for attempt in $(seq 1 30)") < yaml_text.index("|| echo 000")


def test_the_tag_is_validated_before_the_poll_loop_is_ever_entered():
    """Fix round 1, finding 1. Catches two shapes of regression: dropping the validate step
    entirely, and keeping it but moving it AFTER the poll loop starts (which would satisfy a
    membership check while still burning the full 300s budget on a typo)."""
    yaml_text = _promote_workflow()
    assert 'promote_check.py "$TAG"\n' in yaml_text, (
        "no validate-only call (single positional argument) found"
    )
    validate_at = yaml_text.index('mise exec -- python .github/scripts/promote_check.py "$TAG"\n')
    poll_at = yaml_text.index("for attempt in $(seq 1 30)")
    assert validate_at < poll_at, "the tag must be validated BEFORE the poll loop is entered"


def test_the_timeout_budget_names_what_is_measured_and_what_is_not():
    """Fix round 1, finding 2: the reviewer's arithmetic (timer latency + healthcheck timing
    measured from committed config, pull duration NOT measured -- no live box exists yet) has to
    live beside the 30/10 constants themselves, not only in a gitignored report that gets deleted
    when this plan finishes. Checks for the two halves separately so a comment that states one
    without the other -- implying the whole 300s figure was measured -- still fails this."""
    yaml_text = _promote_workflow()
    assert "OnUnitActiveSec=30s" in yaml_text, "the measured timer-latency source is not cited"
    assert "start_period=20s" in yaml_text, "the measured healthcheck-timing source is not cited"
    assert "NOT MEASURED" in yaml_text, "the unmeasured pull-duration assumption is not admitted"
    assert "413 MB" in yaml_text, "the pull-size figure is not named as the thing being guessed at"


def test_the_promote_step_writes_no_output_nobody_can_read():
    """Fix round 1, finding 3 (minor): the `digest` value was written to `$GITHUB_OUTPUT` from a
    step with no `id:`, so nothing could ever read it -- dropped rather than wired up, since
    nothing in this workflow needs it (the poll step compares against `TAG`, not the digest).
    A `GITHUB_OUTPUT` write reappearing on that step without an `id:` alongside it is the same
    dead-output shape returning."""
    yaml_text = _promote_workflow()
    lines = yaml_text.splitlines()
    step_at = next(i for i, ln in enumerate(lines) if "Point :deploy at the requested digest" in ln)
    next_step_at = next(
        i
        for i, ln in enumerate(lines)
        if i > step_at and (ln.strip().startswith("- name:") or ln.strip().startswith("- uses:"))
    )
    step_text = "\n".join(lines[step_at:next_step_at])
    has_output_write = "GITHUB_OUTPUT" in step_text
    has_id = any(ln.strip().startswith("id:") for ln in lines[step_at:next_step_at])
    assert has_output_write == has_id, (
        "this step writes to $GITHUB_OUTPUT without an id: (dead, unreadable output) or has an "
        "id: with nothing written (dead id) -- pick one"
    )


# --------------------------------------------------------------------------------------
# What the poll says when its budget runs out (#77)
# --------------------------------------------------------------------------------------


def test_an_unparseable_body_is_not_classified_as_a_wrong_build():
    """The evidence boundary the whole fix turns on. Folding a decode error into `{}` -- which
    is what this did -- makes an unreadable response indistinguishable from a health report that
    carried no build, and the exhausted path then speaks as though it had read the box."""
    v = assess(TAG, CHALLENGE, 403)
    assert v.matched is False
    assert v.read_a_build is False
    assert "403" in v.reason
    assert "Just a moment" in v.reason, "the body that was actually served is not carried"


def test_a_503_carrying_a_real_report_is_still_read_as_a_report():
    """The status never classifies readability. `/api/health` answers 503 with a complete,
    valid report when the data layer is degraded (`app/src/app/api/health/route.ts:27`), so a
    503 that names a build IS a reading of the box -- and a wrong build read from one is a
    mismatch, not a blind poll."""
    v = assess(TAG, _health("warehouse-2026.04", "6ea164b", status="degraded"), 503)
    assert v.matched is False
    assert v.read_a_build is True
    assert "warehouse-2026.04" in v.reason


def test_the_exhausted_report_orders_a_rollback_when_the_box_reported_a_different_build():
    """The remedy must survive where it is earned. `docker compose up -d --wait` recreates the
    container before confirming health and the box's timer retries the same digest forever, so
    a promote that did not take leaves `:deploy` pointing at an image the box can land on at any
    tick -- re-dispatching the previous known-good tag is what stops that."""
    v = assess(TAG, _health("warehouse-2026.04", "6ea164b"), 200)
    report = v.exhausted_report(30)
    assert "ROLL BACK NOW" in report
    assert "previous known-good tag" in report
    assert "The tag moved; the deploy did not." in report
    assert "warehouse-2026.04" in report and "warehouse-2026.05" in report
    assert "30" in report


def test_the_exhausted_report_does_not_assert_a_failed_deploy_when_the_box_was_never_read():
    """THE defect. On 2026-08-1x this path told an operator to roll back a healthy,
    correctly-promoted deploy -- verified independently four times -- having never read the box
    at all. "The deploy did not happen" and "I could not read the box" are different findings,
    and the workflow asserted the first while observing the second. A rollback is a real
    production action, so the unconditional claim and the unconditional order both have to go;
    what stays is the observation, named, with the status and the body that produced it."""
    v = assess(TAG, CHALLENGE, 403)
    report = v.exhausted_report(30)
    assert "The tag moved; the deploy did not." not in report, (
        "the report asserts a failed deploy it never observed"
    )
    assert "NOT EVIDENCE EITHER WAY" in report
    assert "403" in report and "Just a moment" in report
    assert "curl -sS -D - https://upgauge.shipman.dev/api/health" in report, (
        "no hand check offered, so the operator cannot tell the two readings apart"
    )


def test_the_exhausted_report_keeps_the_rollback_available_once_the_box_is_checked_by_hand():
    """Not silence, either. A bad image that fails to start closes the port, so the real
    emergency -- the one this poll exists to detect -- ALSO arrives as an unreadable body.
    Withholding the remedy outright would suppress it exactly when the site is down; the remedy
    is kept, conditioned on the hand check rather than ordered on no evidence."""
    report = assess(TAG, CHALLENGE, 403).exhausted_report(30)
    assert "ROLL BACK NOW" in report
    assert "previous known-good tag" in report
    line = next(ln for ln in report.splitlines() if "ROLL BACK NOW" in ln)
    before = line[: line.index("ROLL BACK NOW")]
    assert "If it is down" in before, (
        f"the rollback is not conditioned on anything the operator checked first: {line}"
    )
    assert _HAND_CHECK in before, "the condition names no way to establish it"


def test_main_exhausted_prints_the_report_and_returns_1(monkeypatch, tmp_path, capsys):
    """Every line reaches the run's log as its own `::error::` annotation, and the report also
    reaches the step summary -- which is what replaces `printf '%s' "$body" | jq .` on this
    path. That pipe wrote NOTHING when the body was not JSON, which is every case this path now
    exists to report, and printed `jq: parse error` in place of it."""
    summary = tmp_path / "summary"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", "--exhausted", TAG, "403", CHALLENGE, "30"]
    )
    assert main() == 1, "an exhausted poll that returns 0 is a green run on a failed deploy"
    out = capsys.readouterr().out
    assert "::error::" in out
    assert all(ln.startswith("::error::") for ln in out.splitlines() if ln.strip())
    assert "Just a moment" in summary.read_text()
