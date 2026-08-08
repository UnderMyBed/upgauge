"""The drift classifier. Class 3 is the 2026-08-07 failure mode: BTS renamed aircraft type 699
'A321/LR' -> 'A321nXLR', which moved NO number and still reddened 17 assertions. Catching that
at the producer is the only place it is cheap."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from classify_warehouse import classify  # noqa: E402


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
