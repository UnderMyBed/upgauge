"""`promote_check.py`: the tag parse `promote.yml` validates with, and the verdict `make promote`
decides a deploy with (task 7 of the deploy runbook, #19).

`promote_check.py`'s own docstring has the bug this file exists to catch: the workflow's first
draft parsed the promoted tag with bash's `${TAG%-*}` / `${TAG##*-}`, which splits on the LAST
`-` in the string. `UPGAUGE_BUILD_SHA` is `git describe --always --dirty --abbrev=7`, so a dirty
tree's tag is `warehouse-2026.05-a2020f0-dirty` -- and splitting on the last `-` lands inside
`-dirty`, not at the warehouse/sha boundary. A perfectly good deploy would then fail its own
health poll forever, comparing a mangled "dirty" against a live sha that can never equal it.

`test_a_dirty_sha_matches` is THE test that separates the fix from the bug: a clean sha has no
extra `-`, so bash's naive split and the shape-anchored parse in this file agree on it and a
clean-only fixture would pass under either implementation.

The second family of tests here is about what the confirmation says when its budget runs out.
That path ordered a real production rollback on evidence it did not have -- see
`promote_check.py`'s `exhausted_report`. `deploy/promote.py` is its caller;
`test_promote_confirm.py` pins that call site.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from promote_check import (  # noqa: E402
    _HAND_CHECK,
    DEGRADED,
    MISMATCH,
    UNREADABLE,
    assess,
    main,
    parse_promoted_tag,
)

TAG = "warehouse-2026.05-6ea164b"
DIRTY_TAG = "warehouse-2026.05-a2020f0-dirty"

#: The attempt count handed to `exhausted_report`, deliberately NOT the real budget of 30, and
#: asserted as `f"after {ATTEMPTS} attempts"` rather than as a bare number.
#:
#: Every branch of that report interpolates its count into fixed prose that already contains a
#: 30 -- "retries the same digest every 30s forever" on the degraded branch, "any 30s tick" on
#: the mismatch one -- so `assert "30" in report` holds no matter what the count renders as, or
#: whether it renders at all. Measured: replacing the interpolation with the literal `NN`
#: survived the whole suite on BOTH branches (mutants M17/M18 of the #79 review). CLAUDE.md's
#: rule -- vary the input that distinguishes correct from buggy, never assert an outcome the
#: buggy implementation also produces.
ATTEMPTS = 17


#: What a GitHub runner was actually served on 2026-08-1x, in place of the health report: an HTTP
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
    assert v.outcome == UNREADABLE


def test_a_non_dict_build_does_not_crash():
    """Catches dropping the `isinstance(build, dict)` guard. A malformed or hand-edited health
    body could carry `build` as anything -- this must degrade to the same "not yet" reason as a
    missing key, never raise."""
    v = assess(TAG, '{"status": "ok", "build": "not-a-dict", "data": {}}', 200)
    assert v.matched is False
    assert "not this app's health report" in v.reason
    assert v.outcome == UNREADABLE


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


def test_main_validates_a_well_formed_tag_with_no_health_report(monkeypatch, tmp_path):
    """`--validate <tag>` is the call shape `promote.yml`'s pre-flight step uses, so a typo'd
    tag fails in seconds, before the registry is touched. No health report exists at this point,
    so nothing is written to `GITHUB_OUTPUT` -- there is no `Verdict` to report."""
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


def test_the_tag_is_validated_before_the_registry_is_touched():
    """Catches two shapes of regression: dropping the validate step entirely, and keeping it but
    moving it AFTER the login or the retag (which would satisfy a membership check while still
    sending a typo through five retried registry round trips, or worse, past them)."""
    yaml_text = _promote_workflow()
    assert 'promote_check.py --validate "$TAG"\n' in yaml_text, "no validate-only call found"
    validate_at = yaml_text.index(
        'mise exec -- python .github/scripts/promote_check.py --validate "$TAG"\n'
    )
    assert validate_at < yaml_text.index("docker/login-action"), "validated after the login"
    assert validate_at < yaml_text.index("imagetools inspect"), "validated after the retag began"


def test_the_workflow_does_not_read_the_site():
    """The workflow retags and nothing else. A GitHub runner is served Bot Fight Mode's
    challenge page (2026-10-02: 30 of 30 attempts a 403 against a healthy box, on both promotes
    that day), so a health check from here measures nothing, burns its whole budget in CI
    minutes, and ends red on every healthy deploy. `make promote` confirms from the operator's
    machine instead.

    Asserted against EMITTED text, so the header comment naming `/api/health` is not a hit.
    Mutant: the deleted "Wait for the box to be serving it" step restored."""
    emitted = _promote_emitted()
    assert "/api/health" not in emitted, "promote.yml reads the site from a runner again"
    assert "upgauge.shipman.dev" not in emitted, "promote.yml reaches the site from a runner again"
    assert "ROLL BACK NOW" not in emitted, (
        "a rollback order is back in the workflow, which has read nothing to earn one"
    )


def test_the_promote_step_writes_no_output_nobody_can_read():
    """Fix round 1, finding 3 (minor): the `digest` value was written to `$GITHUB_OUTPUT` from a
    step with no `id:`, so nothing could ever read it -- dropped rather than wired up, since
    nothing in this workflow needs it.
    A `GITHUB_OUTPUT` write reappearing on that step without an `id:` alongside it is the same
    dead-output shape returning."""
    yaml_text = _promote_workflow()
    lines = yaml_text.splitlines()
    step_at = next(i for i, ln in enumerate(lines) if "Point :deploy at the requested digest" in ln)
    next_step_at = next(
        (
            i
            for i, ln in enumerate(lines)
            if i > step_at
            and (ln.strip().startswith("- name:") or ln.strip().startswith("- uses:"))
        ),
        len(lines),
    )
    step_text = "\n".join(lines[step_at:next_step_at])
    has_output_write = "GITHUB_OUTPUT" in step_text
    has_id = any(ln.strip().startswith("id:") for ln in lines[step_at:next_step_at])
    assert has_output_write == has_id, (
        "this step writes to $GITHUB_OUTPUT without an id: (dead, unreadable output) or has an "
        "id: with nothing written (dead id) -- pick one"
    )


# --------------------------------------------------------------------------------------
# What the confirmation says when its budget runs out (#77)
# --------------------------------------------------------------------------------------


def test_an_unparseable_body_is_not_classified_as_a_wrong_build():
    """The evidence boundary the whole fix turns on. Folding a decode error into `{}` -- which
    is what this did -- makes an unreadable response indistinguishable from a health report that
    carried no build, and the exhausted path then speaks as though it had read the box."""
    v = assess(TAG, CHALLENGE, 403)
    assert v.matched is False
    assert v.outcome == UNREADABLE
    assert "403" in v.reason
    assert "Just a moment" in v.reason, "the body that was actually served is not carried"


def test_a_503_carrying_a_real_report_is_still_read_as_a_report():
    """The status never classifies readability. `/api/health` answers 503 with a complete,
    valid report when the data layer is degraded (`app/src/app/api/health/route.ts:27`), so a
    503 that names a build IS a reading of the box -- and a wrong build read from one is a
    mismatch, not a blind poll."""
    v = assess(TAG, _health("warehouse-2026.04", "6ea164b", status="degraded"), 503)
    assert v.outcome == MISMATCH
    assert "warehouse-2026.04" in v.reason


def test_the_exhausted_report_orders_a_rollback_when_the_box_reported_a_different_build():
    """The remedy must survive where it is earned. `docker compose up -d --wait` recreates the
    container before confirming health and the box's timer retries the same digest forever, so
    a promote that did not take leaves `:deploy` pointing at an image the box can land on at any
    tick -- promoting the previous known-good tag is what stops that."""
    v = assess(TAG, _health("warehouse-2026.04", "6ea164b"), 200)
    report = v.exhausted_report(ATTEMPTS)
    assert "ROLL BACK NOW: `make promote TAG=<tag>` with the previous known-good tag" in report
    assert "re-dispatch this workflow" not in report, "the remedy names the workflow, not make"
    assert "The tag moved; the deploy did not." in report
    assert "warehouse-2026.04" in report and "warehouse-2026.05" in report
    assert f"after {ATTEMPTS} attempts" in report, (
        "the count of attempts behind this verdict is not reported -- see ATTEMPTS"
    )


def test_the_exhausted_report_does_not_assert_a_failed_deploy_when_the_box_was_never_read():
    """THE defect. On 2026-08-1x this path told an operator to roll back a healthy,
    correctly-promoted deploy -- verified independently four times -- having never read the box
    at all. "The deploy did not happen" and "I could not read the box" are different findings,
    and the poll asserted the first while observing the second. A rollback is a real
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
    assert "ROLL BACK NOW: `make promote TAG=<tag>` with the previous known-good tag" in report
    line = next(ln for ln in report.splitlines() if "ROLL BACK NOW" in ln)
    before = line[: line.index("ROLL BACK NOW")]
    assert "If it is down" in before, (
        f"the rollback is not conditioned on anything the operator checked first: {line}"
    )
    assert _HAND_CHECK in before, "the condition names no way to establish it"


# --------------------------------------------------------------------------------------
# Every unreadable body is named as such, with what arrived (#77 review)
# --------------------------------------------------------------------------------------


def test_a_fetch_that_did_not_complete_is_named_as_such():
    """Status 000 is curl failing, not a server answering with nothing -- the distinction
    `live_check` already draws and this script did not test."""
    v = assess(TAG, "", 0)
    assert v.outcome == UNREADABLE
    assert "did not complete" in v.reason


def test_the_no_build_branch_carries_the_body_like_every_other_blind_branch():
    """It was the only unreadable branch that withheld the bytes, and it is the case where they
    are most diagnostic: a JSON body with no `build` is some OTHER service answering, and its
    contents are what identify which."""
    v = assess(TAG, '{"success":false,"errors":[{"code":1015}]}', 200)
    assert v.outcome == UNREADABLE
    assert "1015" in v.reason, "the body that identifies the responder is withheld"


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
        assert v.outcome == UNREADABLE, body
        assert v.matched is False, body
        report = v.exhausted_report(30)
        # Not "no rollback anywhere" -- the blind branch keeps a CONDITIONAL one by design. The
        # property is that it never asserts the deploy failed, and never orders the rollback
        # outright, which is what the mismatch branch does.
        assert "The tag moved; the deploy did not." not in report, body
        assert "NOT EVIDENCE EITHER WAY" in report, body


def test_a_fetch_that_hung_mid_body_carries_what_did_arrive():
    """The same withholding this file fixed on the no-`build` branch: status 000 with bytes in
    hand is an origin that started answering and stalled, not a refused connection."""
    v = assess(TAG, '{"status":"ok","build"', 0)
    assert v.outcome == UNREADABLE
    assert "did not complete" in v.reason
    assert '{"status":"ok","build"' in v.reason, "the partial response was discarded"


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


def test_the_exhausted_report_names_the_cause_the_box_reported():
    """`health.ts` guarantees every degraded path names a cause -- the catalog probe's in
    `missing`, the freshness probe's in `error` -- so a report saying only "degraded" sends an
    operator to fetch a fact this poll already had in hand.

    BOTH fixtures are needed: a `missing`-only implementation passes the first and silently
    drops the second, which is the very case `health.ts` keeps a separate key for."""
    gap = assess(TAG, _degraded("warehouse-2026.05", "6ea164b"), 503).exhausted_report(ATTEMPTS)
    assert CATALOG_GAP in gap, "the catalog probe's cause is not carried"
    assert "warehouse-2026.05" in gap and "6ea164b" in gap
    assert f"after {ATTEMPTS} attempts" in gap, (
        "the count of attempts behind this verdict is not reported -- see ATTEMPTS"
    )

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
    assert "ROLL BACK NOW: `make promote TAG=<tag>` with the previous known-good tag" in report
    assert "The tag moved; the deploy did not." not in report, (
        "the mismatch claim leaked onto a promote that DID land"
    )
    assert "never pulled" not in report, "the box pulled; this sends the operator after the timer"
    assert "SAME box" in report, "the rollback is promised as a fix it cannot guarantee"
    assert "replace it" in report, "no path for the case where the box is the subject"


def test_the_blind_branch_does_not_call_a_matching_build_a_good_deploy():
    """#79 in the branch that hands the decision to a human, and it needs both open realities to
    see: a runner served a challenge page for the full budget is blind (#77), and the box can be
    serving 503 on the correctly-promoted image at the same time (#79).

    The blind branch never read the box, so it offers a hand check and states the rule for
    reading what comes back. That rule read the BUILD and nothing else -- "If it reports the
    promoted build, this run was blind and the deploy is fine" -- which concludes, against a site
    serving 503 to every visitor, exactly what the DEGRADED branch directly above it exists to
    refuse. `-D -` does put the status on screen; the stated rule beside it did not read it.

    Asserted as the two halves of the rule rather than as a phrase, because a paraphrase of
    either half is the same defect: the roll-back condition must name a non-`ok` status, and the
    all-clear must be qualified by `ok`. BACKTICKED -- `ok` unfenced is a substring of "looks"
    and "took", both already in this branch's fixed prose, which is the same collision that made
    `assert "30" in report` decoration (see ATTEMPTS)."""
    report = assess(TAG, CHALLENGE, 403).exhausted_report(30)
    rule = next(ln for ln in report.splitlines() if "ROLL BACK NOW" in ln)
    condition, _, all_clear = rule.partition("ROLL BACK NOW")
    assert "`ok`" in condition, (
        f"the roll-back condition reads the build and never the status, so a box serving 503 on "
        f"the promoted image reads as an all-clear: {condition}"
    )
    assert "`ok`" in all_clear, (
        f"a build identity alone is called a good deploy -- the finding #79 fixed in `assess`, "
        f"restated to an operator thirty lines below its own module docstring: {all_clear}"
    )


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
    for claim in ("ROLL BACK NOW", "make promote TAG=<tag>", "never pulled"):
        assert claim in degraded, f"the mismatch recommendation changed: {claim}"

    healthy = assess(TAG, _health("warehouse-2026.04", "6ea164b"), 200).exhausted_report(30)
    assert "The box answers, so it is up" in healthy, (
        "the ordinary mismatch message changed, or the degraded clause leaked onto it"
    )
    assert "degraded" not in healthy


def test_the_mismatch_report_does_not_call_a_tag_it_watched_fail_known_good():
    """Which tag the operator is sent to is mechanical and unchanged -- `:deploy` has to come
    off the image the box never pulled. What the report may CALL that tag is not.

    In the quadrant where a new image is promoted TO FIX an outage and the box never pulled it,
    "the previous known-good tag" names the build this poll just watched report a non-`ok`
    status on every attempt. The branch already reads that status for its `up` clause, so the
    phrase is contradicted by the branch's own evidence -- the same shape as comparing a build
    identity and calling it a deploy, one field over.

    ONLY this quadrant, which is why both halves are here: an ordinary mismatch against an old
    build that is serving keeps the phrase, because there the previous tag IS one this poll
    watched serve. The DEGRADED and blind branches never observed the previous tag at all, so
    "known-good" there is the operator's own knowledge and not a claim this report makes; their
    own tests pin it in place."""
    degraded = assess(TAG, _degraded("warehouse-2026.04", "6ea164b"), 503).exhausted_report(30)
    assert "previous known-good tag" not in degraded, (
        "the report measured this build failing on every attempt and calls its tag known-good"
    )
    assert "on every attempt" in degraded, (
        "the operator is not told to reach PAST the build the box is on, so the correction is "
        "an omission rather than a rule"
    )

    healthy = assess(TAG, _health("warehouse-2026.04", "6ea164b"), 200).exhausted_report(30)
    assert "previous known-good tag" in healthy, (
        "the clause leaked onto a mismatch whose old build is serving fine"
    )
