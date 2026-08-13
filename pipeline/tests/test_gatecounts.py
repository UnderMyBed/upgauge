"""`pipeline.gatecounts.collected_count`'s parser, exercised against text fixtures.

Deliberately NOT skip-guarded: like test_stats_sql_parsing.py these are pure text parsing and
must run on a fresh clone, with no `data/` and no built catalog.

The bug this file exists to catch: the parser was anchored (`^(\\d+) tests? collected`) and
therefore blind to ANSI. pytest colourises that line whenever `FORCE_COLOR` is set -- which
Claude Code sets -- so `make check` was red in every agent shell and green in CI, where runners
do not set it. Worse, it misdiagnosed itself twice over: the raised message blamed a changed
reporter format, and the visible failure was `check-gate-counts`, whose documented meaning is
"a test was added without regenerating".
"""

from __future__ import annotations

import pytest

from pipeline.gatecounts import collected_count, python_test_count

# Captured from a real `FORCE_COLOR=3 pytest --collect-only`, not hand-written. The doubled
# `\x1b[32m` prefix and the reset sitting INSIDE the line are what pytest actually emits; a
# fixture invented from the escape sequence one expects would be a weaker test than this.
COLOURISED = "\x1b[32m\x1b[32m510 tests collected\x1b[0m\x1b[32m in 0.10s\x1b[0m\x1b[0m"
PLAIN = "510 tests collected in 0.10s"


def test_parses_a_colourised_collected_line():
    """The regression itself. Under the anchored regex this raises instead of returning."""
    assert collected_count(f"<other output>\n{COLOURISED}\n") == 510


def test_parses_a_plain_collected_line():
    """A fix that only handles the colourised form would be no fix at all -- CI is the
    uncoloured caller, and it is the one that gates merges."""
    assert collected_count(f"<other output>\n{PLAIN}\n") == 510


def test_a_missing_collected_line_raises():
    """The guard that survives the ANSI fix: a silent 0 here would gate nothing."""
    with pytest.raises(RuntimeError, match="no 'N tests collected' line"):
        collected_count("no such line anywhere in this output\n")


def test_a_zero_count_raises():
    with pytest.raises(RuntimeError, match="refusing to pin a vacuous count"):
        collected_count("0 tests collected in 0.01s\n")


def test_python_test_count_survives_FORCE_COLOR(monkeypatch):
    """End-to-end, against a real subprocess: the reported symptom, gone.

    The parser tests above use a captured fixture, so they cannot see a future pytest that
    colourises differently. This one sets the variable and runs the real collection.
    """
    monkeypatch.setenv("FORCE_COLOR", "3")
    assert python_test_count() > 0
