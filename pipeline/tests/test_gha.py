"""`gha.py` is shared plumbing for putting UNTRUSTED remote text into an Actions surface, and
none of it had a test of its own.

Both properties here are correctness properties its own docstrings name, and both were confirmed
by breaking the implementation: `code_span` returning a fixed backtick pair, and `snippet`
skipping the whitespace collapse, each passed the entire suite before this file existed. The
tests that looked like they covered them asserted that the text came out verbatim -- which every
broken fencing scheme also does.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from gha import code_span, snippet  # noqa: E402


def _longest_backtick_run(text: str) -> int:
    return max((len(run) for run in re.findall(r"`+", text)), default=0)


def _split_span(span: str) -> tuple[str, str]:
    """`(fence, content)`. Asserts the thing is a code span at all, which is what catches a
    `code_span` that stopped fencing entirely."""
    m = re.match(r"^(`+)(.*?)(`+)$", span, re.DOTALL)
    assert m, f"not a code span at all: {span!r}"
    assert m.group(1) == m.group(3), f"fences do not match: {span!r}"
    return m.group(1), m.group(2)


def test_a_code_span_fence_is_longer_than_any_backtick_run_it_contains():
    """THE property, and the one no previous assertion read. A fixed pair of backticks renders
    a body containing a backtick as a span that CLOSES EARLY, so the rest of the evidence lands
    in the issue as prose -- or as raw HTML the renderer swallows. Asserting the text appears
    verbatim cannot see this: it appears verbatim under every fencing scheme, broken or not."""
    for text in ("x=`1`", "a ``pair`` here", "```fence```", "no backticks at all"):
        fence, content = _split_span(code_span(text))
        assert len(fence) > _longest_backtick_run(text), (
            f"fence {fence!r} cannot delimit {text!r}: it closes early"
        )
        assert text in content, "the evidence was altered"


def test_a_code_span_of_plain_text_uses_a_single_backtick():
    """The fence grows only when it must -- catches 'always use ten backticks', which satisfies
    the length property above while making every alert unreadable."""
    fence, content = _split_span(code_span("plain"))
    assert fence == "`"
    assert content == "plain"


def test_a_code_span_pads_content_that_begins_or_ends_with_a_backtick():
    """CommonMark strips one space from each end of a code span, and requires that padding when
    the content itself starts or ends with a backtick. Without it the span does not parse."""
    _, content = _split_span(code_span("`x`"))
    assert content == " `x` "


def test_an_empty_code_span_says_so_rather_than_rendering_two_backticks():
    assert code_span("") == "(empty)"


def test_a_snippet_collapses_newlines_so_no_line_can_open_a_workflow_command():
    """Security-relevant, not cosmetic. `promote_check.py`'s exhausted path emits one
    `::error::` per line of its report, so a newline inside edge-controlled evidence would put
    attacker-chosen bytes at the START of a line on the runner's stdout -- where Actions parses
    `::add-mask::` and `::stop-commands::`, in a job holding `packages: write`. The collapse is
    what makes that unreachable, and both existing fixtures were single-line, so nothing
    exercised it."""
    body = "<html>\n::stop-commands::deadbeef\r\n::add-mask::hunter2\n</html>"
    s = snippet(body)
    assert "\n" not in s and "\r" not in s
    assert not any(line.startswith("::") for line in s.splitlines())
    # Collapsed, never censored: the operator still sees exactly what was served.
    assert "::stop-commands::deadbeef" in s


def test_a_snippet_survives_a_body_that_is_not_valid_utf8():
    """`sys.argv` decodes with `surrogateescape`, so a binary or truncated error page arrives
    carrying lone surrogates. Printing those to a stdout whose error handler is `strict` raises
    UnicodeEncodeError -- the alert crashing instead of reporting, which is the whole defect
    class this fix exists to end. `ubuntu-latest` sets LANG=C.UTF-8 (handler `surrogateescape`,
    no raise) and nothing in this repo pins that, so the guard cannot live in the environment.
    """
    body = b"<html>\xff\xfe bad bytes</html>".decode("utf-8", "surrogateescape")
    s = snippet(body)
    s.encode("utf-8")  # the print path. Raises UnicodeEncodeError without the guard.
    assert "<html>" in s and "bad bytes" in s


def test_a_snippet_marks_truncation_and_alters_nothing_else():
    body = "<html>" + ("y" * 400)
    s = snippet(body)
    assert s.startswith("<html>")
    assert "[truncated]" in s
    assert len(s) < len(body)
