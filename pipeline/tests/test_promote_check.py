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
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from promote_check import (  # noqa: E402
    _HAND_CHECK,
    DEGRADED,
    MISMATCH,
    assess,
    main,
    parse_promoted_tag,
)

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
    assert "not this app's health report" in v.reason
    assert v.read_a_build is False


def test_a_non_dict_build_does_not_crash():
    """Catches dropping the `isinstance(build, dict)` guard. A malformed or hand-edited health
    body could carry `build` as anything -- this must degrade to the same "not yet" reason as a
    missing key, never raise."""
    v = assess(TAG, '{"status": "ok", "build": "not-a-dict", "data": {}}', 200)
    assert v.matched is False
    assert "not this app's health report" in v.reason
    assert v.read_a_build is False


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


def test_main_returns_nonzero_and_writes_matched_0_on_a_mismatch(monkeypatch, tmp_path):
    """Non-zero keeps the poll going; the exact value is the three-way contract pinned by
    `test_the_poll_exit_code_distinguishes_a_read_build_from_a_blind_attempt`."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, "200", _health("warehouse-2026.04", "6ea164b")]
    )
    assert main() != 0
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
    monkeypatch.setattr(sys, "argv", ["promote_check.py", "--validate", TAG])
    assert main() == 0
    assert not out.exists()


def test_main_fails_fast_on_a_malformed_tag_with_no_health_report(monkeypatch, tmp_path, capsys):
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(sys, "argv", ["promote_check.py", "--validate", "not-a-warehouse-tag"])
    assert main() == 1
    assert "does not match the warehouse-YYYY.MM-<sha> shape" in capsys.readouterr().out
    assert not out.exists()


def _promote_workflow() -> str:
    return (Path(__file__).parents[2] / ".github" / "workflows" / "promote.yml").read_text()


def _run_scalars() -> list[str]:
    """Every `run:` string in promote.yml."""
    doc = yaml.safe_load(_promote_workflow())
    return [
        step["run"]
        for job in (doc.get("jobs") or {}).values()
        for step in (job.get("steps") or [])
        if isinstance(step, dict) and isinstance(step.get("run"), str)
    ]


def _calls(run: str, script: str) -> list[list[str]]:
    """Argv of every real (non-comment) invocation of `script`, in order, continuations joined."""
    joined = run.replace("\\\n", " ")
    return [
        re.findall(r'--[A-Za-z-]+|"[^"]*"', line[line.index(script) + len(script) :])
        for line in joined.splitlines()
        if script in line and not line.strip().startswith("#") and "python" in line
    ]


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
    collapsing the 30-attempt poll down to a single curl-or-give-up.

    Asserted against EMITTED text and against the mechanism that exists, not the literal that
    used to implement it: this test previously looked for `|| echo 000`, and once that form was
    retired for concatenating onto curl's own `-w` output, the only remaining occurrence in the
    file was the COMMENT explaining why it had been retired. It passed on prose. A mutant that
    tore the fallback out of the loop entirely survived it.
    """
    emitted = _promote_emitted()
    loop_at = emitted.index("for attempt in $(seq 1 30)")
    assert "code=000" in emitted[loop_at:], "no curl-failure fallback inside the poll loop"
    assert "|| rc=$?" in emitted[loop_at:], (
        "a failed attempt aborts the step instead of polling again"
    )


def test_the_tag_is_validated_before_the_poll_loop_is_ever_entered():
    """Fix round 1, finding 1. Catches two shapes of regression: dropping the validate step
    entirely, and keeping it but moving it AFTER the poll loop starts (which would satisfy a
    membership check while still burning the full 300s budget on a typo)."""
    yaml_text = _promote_workflow()
    assert 'promote_check.py --validate "$TAG"\n' in yaml_text, "no validate-only call found"
    validate_at = yaml_text.index(
        'mise exec -- python .github/scripts/promote_check.py --validate "$TAG"\n'
    )
    poll_at = yaml_text.index("for attempt in $(seq 1 30)")
    assert validate_at < poll_at, "the tag must be validated BEFORE the poll loop is entered"


def test_the_timeout_budget_says_where_its_evidence_lives_and_does_not_restate_it():
    """The 300s budget has to justify itself beside the 30/10 constants, not in a report that
    gets deleted. What that justification IS has changed: it was an arithmetic of measured parts
    plus an admitted NOT-MEASURED pull duration, "because no live box exists yet". A box exists
    now and the whole path has been timed, so that sentence had become false while a test held
    it in place -- and it contradicted `docs/architecture/deploy.md`, which records both
    end-to-end figures as measured.

    So this pins the two things that must stay true: the committed-config sources are still
    cited, and the timings themselves are NOT restated here. CLAUDE.md's rule -- a number
    written in two places is a number that will disagree with itself, which is what happened."""
    yaml_text = _promote_workflow()
    assert "OnUnitActiveSec=30s" in yaml_text, "the measured timer-latency source is not cited"
    assert "start_period=20s" in yaml_text, "the measured healthcheck-timing source is not cited"
    assert "docs/architecture/deploy.md" in yaml_text, "the budget cites no record for its timings"
    assert "NOT MEASURED" not in yaml_text, (
        "the retired no-live-box assumption is back; the path has been timed end to end"
    )
    for stale in ("55s", "85s"):
        assert stale not in yaml_text, (
            f"{stale} is restated here as well as in deploy.md -- one of the two will rot"
        )


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
    """Every line reaches the run's log as its own `::error::` annotation -- this pins the
    per-line prefixing, NOT the whitespace collapse: because every line is prefixed, a newline
    here only makes another annotation. The collapse is load-bearing on the two UNPREFIXED
    prints instead, and is pinned there.

    The report also reaches the step summary, which is what replaces `printf | jq .` on this
    path. That pipe wrote NOTHING when the body was not JSON, which is every case this path now
    exists to report, and printed `jq: parse error` in place of it."""
    summary = tmp_path / "summary"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    # Multi-line, and carrying something that would be a workflow command at line start. A
    # single-line fixture cannot exercise the collapse, so the annotation assertion below would
    # hold no matter what `snippet` did.
    hostile = CHALLENGE + "\n::stop-commands::deadbeef\n::add-mask::hunter2\n</body></html>"
    monkeypatch.setattr(sys, "argv", ["promote_check.py", "--exhausted", TAG, "403", hostile, "30"])
    assert main() == 1, "an exhausted poll that returns 0 is a green run on a failed deploy"
    out = capsys.readouterr().out
    assert "::error::" in out
    assert all(ln.startswith("::error::") for ln in out.splitlines() if ln.strip())
    assert "Just a moment" in summary.read_text()


# --------------------------------------------------------------------------------------
# The exhausted verdict must be built from the strongest thing the poll SAW (#77 review)
# --------------------------------------------------------------------------------------


def test_the_poll_exit_code_distinguishes_a_read_build_from_a_blind_attempt(monkeypatch, tmp_path):
    """`code`/`body` are overwritten every iteration, so a verdict built from the last attempt
    alone is a verdict about one sample. With attempts 1-29 reporting the WRONG build -- a
    genuine mismatch, which earns the unconditional rollback -- and attempt 30 hitting a single
    flaky challenge, the report claimed the poll `never read a build from the box` and
    DOWNGRADED an earned order to the conditional blind path.

    The loop cannot see that distinction from a bare pass/fail, so the exit code carries it:
    0 matched, 2 read-a-build-and-it-disagreed, 1 read nothing. `promote.yml` keeps the last
    attempt that returned 2."""
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "out"))

    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, "200", _health("warehouse-2026.05", "6ea164b")]
    )
    assert main() == 0, "a match must end the poll"

    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, "200", _health("warehouse-2026.04", "6ea164b")]
    )
    assert main() == 2, "a build was read and it disagreed -- the loop must be able to keep it"

    monkeypatch.setattr(sys, "argv", ["promote_check.py", TAG, "403", CHALLENGE])
    assert main() == 1, "nothing was read; this attempt must not look like a mismatch"


def test_the_workflow_keeps_the_last_attempt_that_read_a_build():
    """Without this the exit code above is decoration. Asserts the loop records the sticky
    sample AND that the exhausted call prefers it over whatever landed last."""
    run = next(r for r in _run_scalars() if "--exhausted" in r)
    # The POSITION, not the presence: a membership check cannot see WHICH rc branch the
    # assignments sit in. Measured -- `if [ "$rc" = 2 ]` mutated to `= 1` (records the BLIND
    # attempt, downgrading the very rollback this carry exists to protect) and `seen_body=$body`
    # mutated to `=$code` (the kept body becomes "200", which reads as blind) both left the
    # whole suite green.
    lines = run.splitlines()
    start = next(i for i, ln in enumerate(lines) if 'if [ "$rc" = 2 ]' in ln)
    end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == "fi")
    kept = "\n".join(lines[start + 1 : end])
    assert "seen_code=$code" in kept, f"the read-a-build branch does not keep the code: {kept}"
    assert "seen_body=$body" in kept, f"the read-a-build branch does not keep the body: {kept}"
    argv = _calls(run, "promote_check.py")[-1]
    assert argv[0] == "--exhausted"
    assert argv[2] == '"${seen_code:-$code}"', f"exhausted does not prefer the kept sample: {argv}"
    assert argv[3] == '"${seen_body:-$body}"', f"exhausted does not prefer the kept sample: {argv}"


def test_the_workflow_passes_promote_check_its_arguments_in_order():
    """`assess` reads argv positionally. Transposing status and body makes every healthy deploy
    exhaust its budget (`int('{"status"...')` -> ValueError, or a body of `200`), and no test
    above can see it because they all call `main()` directly."""
    run = next(r for r in _run_scalars() if "--exhausted" in r)
    poll, exhausted = _calls(run, "promote_check.py")
    assert poll == ['"$TAG"', '"$code"', '"$body"'], f"poll call shape drifted: {poll}"
    assert exhausted[0] == "--exhausted"
    assert exhausted[1] == '"$TAG"'
    assert exhausted[-1] == '"$attempt"', f"exhausted call shape drifted: {exhausted}"


def test_the_workflow_never_appends_to_a_status_curl_already_wrote():
    """curl writes its `-w` output even on failure, so `|| echo 000` concatenates onto it --
    measured `000000` refused, `200000` on a mid-body timeout, which is exactly the hung-origin
    case a 300s poll exists for."""
    run = next(r for r in _run_scalars() if "--exhausted" in r)
    # Continuations JOINED first: the fallback sits on the second physical line, so
    # splitting raw made this check pass against the very bug it names.
    for line in run.replace("\\\n", " ").splitlines():
        if "%{http_code}" in line:
            assert "|| echo" not in line, f"a status curl still appends a fallback: {line.strip()}"


def test_a_fetch_that_did_not_complete_is_named_as_such():
    """Status 000 is curl failing, not a server answering with nothing -- the distinction
    `live_check` already draws and this script did not test."""
    v = assess(TAG, "", 0)
    assert v.read_a_build is False
    assert "did not complete" in v.reason


def test_the_no_build_branch_carries_the_body_like_every_other_blind_branch():
    """It was the only unreadable branch that withheld the bytes, and it is the case where they
    are most diagnostic: a JSON body with no `build` is some OTHER service answering, and its
    contents are what identify which."""
    v = assess(TAG, '{"success":false,"errors":[{"code":1015}]}', 200)
    assert v.read_a_build is False
    assert "1015" in v.reason, "the body that identifies the responder is withheld"


def test_a_poll_attempt_cannot_emit_a_workflow_command_out_of_the_body(monkeypatch, capsys):
    """The real injection surface, found by a mutant surviving against the exhausted path: this
    print is NOT line-prefixed, so an embedded newline puts edge-controlled bytes at the start
    of a line on the runner's stdout. Actions parses `::add-mask::` and `::stop-commands::`
    there, in a job holding `packages: write`, and this loop runs the print 30 times.

    `gha.snippet`'s whitespace collapse is the only thing standing between those two facts."""
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    hostile = "<html>\n::stop-commands::deadbeef\n::add-mask::hunter2\n</html>"
    monkeypatch.setattr(sys, "argv", ["promote_check.py", TAG, "403", hostile])
    main()
    for line in capsys.readouterr().out.splitlines():
        assert not line.startswith("::"), f"a workflow command reached line start: {line!r}"


def test_a_newline_in_a_parsed_value_cannot_open_a_workflow_command(monkeypatch, capsys):
    """The poll's per-attempt `print(verdict.reason)` is unprefixed and runs 30 times, in a job
    holding `packages: write`. `build.warehouse` reaches it straight out of the parsed body, and
    `snippet`'s collapse never touches it."""
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    hostile = "w\n::stop-commands::deadbeef"
    body = json.dumps({"status": "ok", "build": {"warehouse": hostile, "sha": "s"}, "data": {}})
    monkeypatch.setattr(sys, "argv", ["promote_check.py", TAG, "200", body])
    main()
    for line in capsys.readouterr().out.splitlines():
        assert not line.startswith("::"), f"a workflow command reached line start: {line!r}"


def test_an_undecodable_byte_in_a_parsed_value_does_not_kill_the_exhausted_report(
    monkeypatch, tmp_path, capsys
):
    """The step-summary write is strict under every locale, so this is live on ubuntu-latest. A
    crash here hands the operator a traceback instead of the rollback verdict -- and it exits 1,
    this script's code for "read nothing", so it would silently downgrade an earned rollback to
    the blind path too."""
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "summary"))
    bad = b"\xff\xfe".decode("utf-8", "surrogateescape")
    body = json.dumps(
        {"status": "ok", "build": {"warehouse": f"warehouse-2026.04{bad}", "sha": "x"}, "data": {}}
    )
    monkeypatch.setattr(sys, "argv", ["promote_check.py", "--exhausted", TAG, "200", body, "30"])
    assert main() == 1
    assert "ROLL BACK NOW" in (tmp_path / "summary").read_text()
    assert "ROLL BACK NOW" in capsys.readouterr().out


def test_json_that_is_not_this_apps_report_never_earns_a_rollback():
    """`is_health_report` shipped in live_check and not here, so for one commit any JSON with a
    `build` dict counted as a reading of the box: `{"build":{}}` produced a `mismatch` whose
    exhausted report ordered ROLL BACK NOW unconditionally, and a body whose keys happened to
    line up declared the promote SUCCESSFUL outright. `deploy.md` states the rule for both
    watchdogs; now both hold it."""
    for body in (
        '{"build":{}}',
        '{"success":false,"build":{"warehouse":"w","sha":"s"},"errors":[{"code":1015}]}',
        '{"build":{"warehouse":"warehouse-2026.05","sha":"6ea164b"}}',
    ):
        v = assess(TAG, body, 200)
        assert v.read_a_build is False, body
        assert v.matched is False, body
        report = v.exhausted_report(30)
        # Not "no rollback anywhere" -- the blind branch keeps a CONDITIONAL one by design. The
        # property is that it never asserts the deploy failed, and never orders the rollback
        # outright, which is what the mismatch branch does.
        assert "The tag moved; the deploy did not." not in report, body
        assert "NOT EVIDENCE EITHER WAY" in report, body


def test_the_workflow_treats_a_usage_failure_as_a_wiring_bug_not_a_site_condition():
    """Exit 64 is `promote_check.py` refusing its own call shape. Folded into the loop's
    "keep polling" alongside a genuine 1, a wiring bug spends the full 300s budget and is then
    reported as a condition of the SITE -- the misattribution this whole branch exists to end."""
    run = next(r for r in _run_scalars() if "--exhausted" in r)
    lines = run.splitlines()
    start = next(i for i, ln in enumerate(lines) if 'if [ "$rc" = 64 ]' in ln)
    end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == "fi")
    block = "\n".join(lines[start + 1 : end])
    assert "exit 1" in block, f"a usage failure does not stop the poll: {block}"
    assert "wiring bug" in block, "the operator is not told this is a wiring bug, not the site"

    # POSITION, not presence -- the same upgrade this file already made for the sticky carry.
    # Moved after `done`, this block inspects only the last attempt and only once the full 300s
    # budget is spent, which is verbatim the failure its own message names; every test stayed
    # green against exactly that move.
    loop_at = next(i for i, ln in enumerate(lines) if "for attempt in $(seq 1 30)" in ln)
    done_at = next(i for i in range(loop_at + 1, len(lines)) if lines[i].strip() == "done")
    assert loop_at < start < done_at, (
        "the usage check must run INSIDE the poll loop, on the attempt that failed -- not after "
        "the budget is already spent"
    )


def test_a_fetch_that_hung_mid_body_carries_what_did_arrive():
    """The same withholding this file fixed on the no-`build` branch: status 000 with bytes in
    hand is an origin that started answering and stalled, not a refused connection."""
    v = assess(TAG, '{"status":"ok","build"', 0)
    assert v.read_a_build is False
    assert "did not complete" in v.reason
    assert '{"status":"ok","build"' in v.reason, "the partial response was discarded"


def test_an_undecodable_byte_in_a_poll_attempt_does_not_kill_the_loop(monkeypatch, capsys):
    """The per-attempt print is a boundary too, and it runs 30 times. A crash exits 1 -- this
    script's code for "read nothing" -- so it would also downgrade an earned rollback."""
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    bad = b"\xff\xfe".decode("utf-8", "surrogateescape")
    body = json.dumps(
        {"status": "ok", "build": {"warehouse": f"warehouse-2026.04{bad}", "sha": "x"}, "data": {}}
    )
    monkeypatch.setattr(sys, "argv", ["promote_check.py", TAG, "200", body])
    assert main() == 2, "a build WAS read; a crash here would look like a blind attempt"
    assert "warehouse-2026.04" in capsys.readouterr().out


def test_a_newline_in_a_dispatched_tag_cannot_open_a_workflow_command(monkeypatch, capsys):
    """`--validate` echoes the dispatch input back on a rejection, unprefixed, in a job holding
    `packages: write`. Anyone who can dispatch this workflow chooses that string."""
    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", "--validate", "nope\n::stop-commands::deadbeef"]
    )
    assert main() == 1
    for line in capsys.readouterr().out.splitlines():
        assert not line.startswith("::"), f"a workflow command reached line start: {line!r}"


# --------------------------------------------------------------------------------------
# A box serving the promoted build and reporting it cannot answer (#79)
# --------------------------------------------------------------------------------------

#: A cause in the shape the container really produces, measured on `make portability` negative 3
#: and recorded verbatim at `docs/architecture/hosting.md:575`.
CATALOG_GAP = (
    'catalog probe failed: IO Error: Cannot open database "/tmp/upgauge.duckdb" in read-only '
    "mode: database does not exist"
)

#: The other degraded shape, and it is NOT reachable through `missing`: the catalog is intact and
#: `dataAsOf()` threw, so the cause lands in `data.error` instead (`app/src/lib/health.ts:73-82`,
#: measured on `make portability` negative 1).
ASOF_ERROR = (
    'IO Error: No files found that match the pattern "data/parquet/t100_segment/**/*.parquet"'
)


def _degraded(warehouse: str, sha: str, data: dict | None = None, status: str = "degraded") -> str:
    """A degraded `/api/health` body carrying the PROMOTED build identity.

    That combination is #79 itself, and it is not contrived: `build` is baked from the
    Dockerfile's runtime build args and `health.ts`'s `identity()` computes it before every
    return branch, so a container whose data layer never opened reports the promoted sha and
    warehouse exactly as a healthy one does.
    """
    return json.dumps(
        {
            "status": status,
            "build": {"warehouse": warehouse, "sha": sha},
            "data": data if data is not None else {"asOf": None, "missing": [CATALOG_GAP]},
        }
    )


def test_a_degraded_box_serving_the_promoted_build_is_not_a_match():
    """THE defect. `assess` compared the build identity and never read `status`, so the first
    poll attempt against a box answering 503 returned matched and `promote.yml` exited 0 --
    reporting a successful deploy against a site serving 503 to every visitor.

    It is a reading of the box, not a blind attempt: the build was there and it was right."""
    v = assess(TAG, _degraded("warehouse-2026.05", "6ea164b"), 503)
    assert v.matched is False, "a box that reports it cannot answer confirmed a deploy"
    assert v.outcome == DEGRADED
    assert v.read_a_build is True, "the build WAS read; this is not a blind attempt"
    assert "degraded" in v.reason
    assert CATALOG_GAP in v.reason, "the cause the box named is not carried"


def test_only_ok_confirms_the_promoted_build():
    """An allow-list, never `!= "degraded"` -- CLAUDE.md's cacheability-predicate rule in another
    guise. `is_health_report` requires `status` to be a string and nothing further, so a future
    status value, an intermediary's own word, or a case variant all reach here and none of them
    is a confirmation. The deny-list form passes the test above and waves every one of these
    through."""
    for status in ("wat", "", "OK", "okay", "starting"):
        v = assess(TAG, _degraded("warehouse-2026.05", "6ea164b", status=status), 200)
        assert v.matched is False, status
        assert v.outcome == DEGRADED, status
        if status:
            assert status in v.reason, status


def test_a_degraded_attempt_keeps_the_loop_going_and_is_kept_as_the_sticky_sample(
    monkeypatch, tmp_path
):
    """Exit 2, and neither of its neighbours. 0 ends the poll and declares the promote
    successful -- #79 with an extra step. 1 is this script's code for "read nothing", which
    drops the attempt out of `promote.yml`'s sticky carry (`if [ "$rc" = 2 ]`), so one flaky
    challenge page at attempt 30 would report a blind poll against a box that had named its own
    failure 29 times.

    A later `ok` must still end the poll: promoting a new image is HOW a degraded box gets
    fixed, and that promote's early attempts read the old, still-degraded build."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, "503", _degraded("warehouse-2026.05", "6ea164b")]
    )
    assert main() == 2, "a degraded box either ended the poll green or read as a blind attempt"
    assert "matched=0" in out.read_text()

    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, "200", _health("warehouse-2026.05", "6ea164b")]
    )
    assert main() == 0, "a degraded attempt must not stop a later ok from ending the poll"


def test_the_exhausted_report_names_the_cause_the_box_reported():
    """`health.ts` guarantees every degraded path names a cause -- the catalog probe's in
    `missing`, the freshness probe's in `error` -- so a report saying only "degraded" sends an
    operator to fetch a fact this poll already had in hand.

    BOTH fixtures are needed: a `missing`-only implementation passes the first and silently
    drops the second, which is the very case `health.ts` keeps a separate key for."""
    gap = assess(TAG, _degraded("warehouse-2026.05", "6ea164b"), 503).exhausted_report(30)
    assert CATALOG_GAP in gap, "the catalog probe's cause is not carried"
    assert "warehouse-2026.05" in gap and "6ea164b" in gap
    assert "30" in gap

    stamp = assess(
        TAG,
        _degraded(
            "warehouse-2026.05", "6ea164b", data={"asOf": None, "missing": [], "error": ASOF_ERROR}
        ),
        503,
    ).exhausted_report(30)
    assert ASOF_ERROR in stamp, "the freshness probe's cause is not carried"


def test_the_exhausted_report_orders_a_rollback_without_promising_it_fixes_the_box():
    """The remedy differs from a mismatch's, and saying so IS the finding. The tag moved AND the
    box took the image, so "The tag moved; the deploy did not" is false here and "why this one
    never pulled" sends an operator after a pull that happened.

    The order stands: unlike the blind branch, the box has reported over the full 300s that it
    cannot answer, and that is a measurement. It is not PROMISED: `deploy/compose.yml` mounts no
    data volume (the dataset is baked into the image), `image.yml` gates every image with
    `make image-smoke` before it can reach the registry, and a rollback lands the previous image
    on the SAME box. So the report has to carry the discriminator -- if the cause survives the
    rollback, the subject is the box."""
    report = assess(TAG, _degraded("warehouse-2026.05", "6ea164b"), 503).exhausted_report(30)
    assert "ROLL BACK NOW" in report, "the remedy is withheld while the box says it is down"
    assert "previous known-good tag" in report
    assert "The tag moved; the deploy did not." not in report, (
        "the mismatch claim leaked onto a promote that DID land"
    )
    assert "never pulled" not in report, "the box pulled; this sends the operator after the timer"
    assert "SAME box" in report, "the rollback is promised as a fix it cannot guarantee"
    assert "replace it" in report, "no path for the case where the box is the subject"


def test_a_wrong_build_is_reported_as_a_mismatch_even_when_that_build_is_degraded():
    """The build is compared FIRST, and the order is the finding. A box still serving the OLD
    image and reporting degraded is telling this poll about an image nobody promoted -- reading
    the status first would report "the build you promoted is not serving" out of a box that
    never ran it, which is the unearned claim #77 spent three rounds removing."""
    v = assess(TAG, _degraded("warehouse-2026.04", "6ea164b"), 503)
    assert v.outcome == MISMATCH
    assert "warehouse-2026.04" in v.reason and "warehouse-2026.05" in v.reason
    report = v.exhausted_report(30)
    assert "The tag moved; the deploy did not." in report
    assert CATALOG_GAP not in report, (
        "a cause read off the OLD build is reported as though it were the promoted image's"
    )


def test_the_mismatch_report_does_not_claim_a_degraded_box_is_up_and_serving():
    """The mismatch branch's `The box answers, so it is up` is a claim about the build the box
    IS serving, and this branch has that build's status in hand. A box serving an old, degraded
    image is up and NOT serving, and asserting otherwise is the same unearned claim in the other
    direction.

    Both halves, because the clause must not leak: an ordinary mismatch against a healthy old
    build keeps the message it has always had, and the recommendation is unchanged either way --
    the box still never took the new image, whatever the old one is doing."""
    degraded = assess(TAG, _degraded("warehouse-2026.04", "6ea164b"), 503).exhausted_report(30)
    assert "The box answers, so it is up" not in degraded, (
        "a box reporting it cannot answer is called up and serving"
    )
    assert "degraded" in degraded, "the status the box reported is not named"
    for claim in ("ROLL BACK NOW", "previous known-good tag", "never pulled"):
        assert claim in degraded, f"the mismatch recommendation changed: {claim}"

    healthy = assess(TAG, _health("warehouse-2026.04", "6ea164b"), 200).exhausted_report(30)
    assert "The box answers, so it is up" in healthy, (
        "the ordinary mismatch message changed, or the degraded clause leaked onto it"
    )
    assert "degraded" not in healthy


def test_a_newline_in_the_reported_status_or_cause_cannot_open_a_workflow_command(
    monkeypatch, capsys
):
    """Two NEW values off the parsed body reach the per-attempt `print(verdict.reason)`, which is
    unprefixed and runs 30 times in a job holding `packages: write`. `snippet`'s collapse never
    touches either -- `inline` at the message build site is the only thing standing between them
    and `::stop-commands::` at line start."""
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    hostile = "x\n::stop-commands::deadbeef"
    body = _degraded(
        "warehouse-2026.05",
        "6ea164b",
        data={"asOf": None, "missing": [f"m{hostile}"], "error": f"e{hostile}"},
        status=f"degraded{hostile}",
    )
    monkeypatch.setattr(sys, "argv", ["promote_check.py", TAG, "503", body])
    assert main() == 2
    for line in capsys.readouterr().out.splitlines():
        assert not line.startswith("::"), f"a workflow command reached line start: {line!r}"
