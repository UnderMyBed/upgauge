"""The drift classifier. Class 3 is the 2026-08-07 failure mode: BTS renamed aircraft type 699
'A321/LR' -> 'A321nXLR', which moved NO number and still reddened 17 assertions. Catching that
at the producer is the only place it is cheap."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from classify_warehouse import _issue_body, classify, main  # noqa: E402


def _measures(**overrides):
    base = {
        "max_year_month": "2026-04",
        "city_markets": 6181,
        "dim_aircraft_type_rows": 450,
        "fact_present_aircraft_codes": 112,
        "rows_by_year": [{"year": 2026, "rows": 118650, "quarantined": 52}],
        "aircraft_short_names": [{"code": "699", "short_name": "A321nXLR"}],
        "aircraft_slug_separators": {"0": 37, "1": 64, "2": 10},
    }
    base.update(overrides)
    return {"measures": base}


def test_nothing_changed_is_class_zero():
    assert classify(_measures(), _measures()).worst_class == 0


def test_a_new_month_is_class_one():
    c = classify(_measures(), _measures(max_year_month="2026-05"))
    assert c.worst_class == 1
    assert c.new_months == ["2026-05"]
    assert c.shape_changes == []


def test_a_closed_year_moving_is_class_two():
    """Amended filings revise CLOSED months -- BTS's own release page shows
    '10/2025 - 3/2026 updated'. Expected, but it must be surfaced."""
    c = classify(
        _measures(),
        _measures(rows_by_year=[{"year": 2026, "rows": 118999, "quarantined": 52}]),
    )
    assert c.worst_class == 2
    assert "2026" in c.moved_years


def test_an_aircraft_rename_is_class_three():
    """The mutant that matters. No count moves; only a NAME does."""
    c = classify(
        _measures(),
        _measures(aircraft_short_names=[{"code": "699", "short_name": "A321/LR"}]),
    )
    assert c.worst_class == 3
    assert any("699" in s and "A321nXLR" in s and "A321/LR" in s for s in c.shape_changes)


def test_a_dim_count_moving_is_class_three():
    c = classify(_measures(), _measures(city_markets=6185))
    assert c.worst_class == 3
    assert any("city_markets" in s and "6181" in s and "6185" in s for s in c.shape_changes)


def test_a_new_month_alongside_a_rename_reports_class_three():
    """worst_class is the MAXIMUM, not the most recent finding -- a rename hidden behind a
    routine new month is precisely how the 2026-08-07 drift arrived."""
    c = classify(
        _measures(),
        _measures(
            max_year_month="2026-05",
            aircraft_short_names=[{"code": "699", "short_name": "A321/LR"}],
        ),
    )
    assert c.worst_class == 3
    assert c.new_months == ["2026-05"]


def test_a_year_disappearing_is_class_three():
    """A dropped partition is a shape change, not silence. The forward loop in `classify()`
    only walks `cur["rows_by_year"]` and looks each year up in `prev` -- a year present in
    `prev` and absent from `cur` never gets visited by that loop at all, so this needs its own
    reverse check. Fixture note: `_measures()`'s one-year `rows_by_year` can't express a
    disappearance on its own, so this test overrides `rows_by_year` directly on both sides
    rather than going through `_measures(rows_by_year=...)`'s single-year default."""
    prev = _measures(
        rows_by_year=[
            {"year": 2015, "rows": 500000, "quarantined": 10},
            {"year": 2026, "rows": 118650, "quarantined": 52},
        ]
    )
    cur = _measures(rows_by_year=[{"year": 2026, "rows": 118650, "quarantined": 52}])
    c = classify(prev, cur)
    assert c.worst_class == 3
    assert any("2015" in s for s in c.shape_changes)
    # The year that survived unchanged must NOT also be reported as moved or renamed --
    # this is what would catch an over-eager reverse check that flags every prior year.
    assert c.moved_years == []


def test_mismatched_measure_keys_fail_loudly():
    """classify() relies on both sides sharing the same key set -- both produced by the same
    commit's `pipeline.stats.collect()`. That is asserted explicitly, not hoped for: a
    `.get(...)`-tolerant version of the checks below would silently treat a missing key as
    "unchanged" instead of surfacing that classify()'s own input shape moved."""
    prev = _measures()
    cur = _measures()
    del cur["measures"]["aircraft_slug_separators"]
    with pytest.raises(KeyError):
        classify(prev, cur)


# --- main() / CLI entry point --------------------------------------------------------------
#
# 2026-08-08 fix round, Finding 1 (CRITICAL): `gh issue create --body
# "${{ steps.classify.outputs.issue_body }}"` spliced the body into the shell script BEFORE
# bash parsed it, so the markdown code span `` `make stats` `` in `_issue_body()`'s own text
# became live command substitution -- the reviewer reproduced `make stats` actually re-running
# and corrupting the issue body on every class-3 firing. The fix moved to an `env:`-mediated
# `"$ISSUE_BODY"` reference in the workflow, which no unit test can see (it's YAML+bash, not
# Python). What a unit test CAN and must guard is main()'s half of the contract: the exact
# bytes it hands to `$GITHUB_OUTPUT` -- backticks intact, parseable by GitHub's own
# `name<<DELIM` rules -- because that is the value the workflow's `env:` block later copies
# verbatim into `$ISSUE_BODY`.


def _parse_github_output(text: str) -> dict[str, str]:
    """Re-implement GitHub's own $GITHUB_OUTPUT parsing rules (`name=value` and
    `name<<DELIM ... DELIM`) well enough to prove a value round-trips through them. This is
    deliberately independent of `_write_multiline_output`'s own delimiter choice -- it reads
    whatever delimiter appears after `<<` rather than assuming a fixed one, which is exactly
    what makes it able to catch a broken delimiter (fixed OR one that collides with content)
    instead of merely mirroring the implementation under test."""
    result: dict[str, str] = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if "<<" in line:
            name, delim = line.split("<<", 1)
            i += 1
            body_lines = []
            while lines[i] != delim:
                body_lines.append(lines[i])
                i += 1
            result[name] = "\n".join(body_lines)
            i += 1  # skip the closing delimiter line
        elif "=" in line:
            name, value = line.split("=", 1)
            result[name] = value
            i += 1
        else:
            i += 1
    return result


def _run_main(monkeypatch, tmp_path, previous, current):
    out_path = tmp_path / "github_output"
    summary_path = tmp_path / "github_summary"
    out_path.write_text("")
    summary_path.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out_path))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_path))
    monkeypatch.setattr(
        sys, "argv", ["classify_warehouse.py", json.dumps(previous), json.dumps(current)]
    )
    assert main() == 0
    return out_path.read_text()


def test_main_hands_github_output_a_byte_identical_issue_body_with_backticks_intact(
    monkeypatch, tmp_path
):
    previous = _measures(aircraft_short_names=[{"code": "699", "short_name": "A321/LR"}])
    current = _measures()
    out_text = _run_main(monkeypatch, tmp_path, previous, current)
    outputs = _parse_github_output(out_text)

    assert outputs["file_issue"] == "1"
    expected_body = _issue_body(classify(previous, current))
    # (a) the full body is present, (b) it survived a real re-implementation of GitHub's own
    # <<DELIM parsing rules to get here, (c) backticks are literal, not stripped or escaped.
    assert outputs["issue_body"] == expected_body
    assert "`make stats`" in outputs["issue_body"]
    # The delimiter itself must not be the old static "EOF" -- Finding 6 -- confirmed by
    # checking the raw $GITHUB_OUTPUT text for a randomized (32 hex char) delimiter line.
    delim_lines = [
        line.split("<<", 1)[1] for line in out_text.splitlines() if line.startswith("issue_body<<")
    ]
    assert len(delim_lines) == 1
    assert delim_lines[0] != "EOF"
    assert len(delim_lines[0]) == 32
    assert all(ch in "0123456789abcdef" for ch in delim_lines[0])


def test_main_with_no_class_three_finding_writes_no_output_file(monkeypatch, tmp_path):
    """The companion case: main() must not create $GITHUB_OUTPUT content at all (no
    `file_issue`, no `issue_body`) when nothing shape-changed -- the issue-filing step's
    `if: steps.classify.outputs.file_issue == '1'` depends on that key being genuinely
    absent, not present-and-empty."""
    out_text = _run_main(monkeypatch, tmp_path, _measures(), _measures())
    assert out_text == ""
