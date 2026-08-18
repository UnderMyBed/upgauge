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
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from promote_check import assess, main, parse_promoted_tag  # noqa: E402

TAG = "warehouse-2026.05-6ea164b"
DIRTY_TAG = "warehouse-2026.05-a2020f0-dirty"


def _health(warehouse: str, sha: str) -> dict:
    """The exact shape `/api/health` returns (`app/src/lib/health.ts`'s `HealthReport`)."""
    return {"status": "ok", "build": {"warehouse": warehouse, "sha": sha}, "data": {}}


def test_a_clean_sha_matches():
    v = assess(TAG, _health("warehouse-2026.05", "6ea164b"))
    assert v.matched is True
    assert v.expected_warehouse == "warehouse-2026.05"
    assert v.expected_sha == "6ea164b"


def test_a_dirty_sha_matches():
    """THE mutant: naive last-dash splitting yields expected sha `dirty` and expected warehouse
    `warehouse-2026.05-a2020f0`, neither of which any live build could ever report. This fixture
    is the only one that separates that bug from the fix -- see the module docstring."""
    v = assess(DIRTY_TAG, _health("warehouse-2026.05", "a2020f0-dirty"))
    assert v.matched is True
    assert v.expected_warehouse == "warehouse-2026.05"
    assert v.expected_sha == "a2020f0-dirty"


def test_a_mismatched_warehouse_does_not_match():
    v = assess(TAG, _health("warehouse-2026.04", "6ea164b"))
    assert v.matched is False
    assert "warehouse-2026.04" in v.reason
    assert "warehouse-2026.05" in v.reason


def test_a_mismatched_sha_does_not_match():
    v = assess(TAG, _health("warehouse-2026.05", "eb4da0d"))
    assert v.matched is False
    assert "eb4da0d" in v.reason
    assert "6ea164b" in v.reason


def test_a_health_report_missing_build_entirely_does_not_match():
    """`{}` is exactly what the workflow substitutes for a failed `curl` -- and is also what a
    503 body from a booting box can look like before `build` is ever populated. Both must read
    as "not yet", with a reason that says so, not as a crash on `health["build"]`."""
    v = assess(TAG, {})
    assert v.matched is False
    assert "no `build` section" in v.reason


def test_a_non_dict_build_does_not_crash():
    """Catches dropping the `isinstance(build, dict)` guard. A malformed or hand-edited health
    body could carry `build` as anything -- this must degrade to the same "not yet" reason as a
    missing key, never raise."""
    v = assess(TAG, {"build": "not-a-dict"})
    assert v.matched is False
    assert "no `build` section" in v.reason


def test_a_tag_that_does_not_match_the_warehouse_shape_is_named_as_such():
    """Catches dropping the shape anchor entirely -- e.g. accepting any string with a dash in
    it, which is exactly the bug this whole module exists to fix in a different guise."""
    v = assess("not-a-warehouse-tag", _health("not-a-warehouse-tag", "abc1234"))
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
        sys, "argv", ["promote_check.py", TAG, json.dumps(_health("warehouse-2026.05", "6ea164b"))]
    )
    assert main() == 0
    text = out.read_text()
    assert "matched=1" in text


def test_main_returns_1_and_writes_matched_0_on_a_mismatch(monkeypatch, tmp_path):
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(
        sys, "argv", ["promote_check.py", TAG, json.dumps(_health("warehouse-2026.04", "6ea164b"))]
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
    monkeypatch.setattr(sys, "argv", ["promote_check.py", TAG, "<html>502 Bad Gateway</html>"])
    assert main() == 1
    assert "no `build` section" in out.read_text() or "matched=0" in out.read_text()


def _promote_workflow() -> str:
    return (Path(__file__).parents[2] / ".github" / "workflows" / "promote.yml").read_text()


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


def test_the_failure_message_names_rollback_as_the_remedy():
    """The health poll is the DETECTOR for `docker compose up -d --wait` recreating the
    container before confirming health (a bad image takes the site down and the box's timer
    just keeps retrying it) -- so the failure message must tell a human what to do about it, not
    only that the poll timed out."""
    yaml_text = _promote_workflow()
    assert "ROLL BACK NOW" in yaml_text
    assert "previous known-good tag" in yaml_text


def test_the_workflow_treats_a_curl_failure_as_not_yet_not_as_abandoning_the_poll():
    """`|| echo '{}'` must stay INSIDE the retry loop, not replace it -- catches collapsing the
    30-attempt poll down to a single curl-or-give-up."""
    yaml_text = _promote_workflow()
    assert "for attempt in $(seq 1 30)" in yaml_text
    assert "|| echo '{}'" in yaml_text
