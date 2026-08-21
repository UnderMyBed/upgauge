"""`deploy/promote.py`'s decision half -- what the operator is SHOWN before they pick.

This tool's only job is presenting the right thing, so every bug it can have is a
presentation bug, and each one sends a human to promote something they did not mean to
promote. Five of them are worth naming, because each is a mutation that leaves a
plausible-looking table on screen:

  * ORDER. `gh api` happens to return versions newest-first today. Trusting that is a bug
    with no symptom until the day it doesn't -- and "row 1 is newest" is the single claim
    the whole picker rests on. `test_newest_first_is_computed_not_inherited` feeds a
    fixture in the WRONG order, so an implementation that returns the API's own sequence
    goes red and one that sorts survives.
  * WHAT IS PICKABLE. `:deploy` is its own version in this registry (measured: created
    43s after the build it points at, carrying only the tag `deploy`), and promote hops
    leave UNTAGGED versions behind -- 2 of the 17 versions on 2026-08-21. Offering either
    as a choice means dispatching `promote.yml` with a tag it cannot resolve, or promoting
    `:deploy` onto itself and calling the no-op a deploy.
  * THE ABSENT LIVE MARKER. If `/api/health` cannot be read, NO row is marked -- and a
    table with no `LIVE` on it reads exactly like a box running nothing. That is
    `promote_check.py`'s blind-poll lesson in a different shell: unreadability is a
    finding, never a default. The test asserts the emitted REASON, because an assertion
    that merely counts `LIVE` markers passes under the bug.
  * A SHA THE CLONE DOES NOT HAVE. Subjects come from `git log`, which knows nothing about
    a build made from a commit this checkout never fetched. That row must still render.
  * WHICH WAY A BUILD SITS RELATIVE TO LIVE. `git rev-list --count live..candidate` returns
    0 for the live build AND for every build older than it, so the one-sided count prints
    `+0` beside a rollback target. Only a fixture with builds on BOTH sides of live can
    tell that implementation from the `--left-right` one.

The pure/impure split mirrors `promote_check.py` for the same reason: the network half is
untestable and the deciding half is where the bugs are.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "deploy"))

from promote import (  # noqa: E402
    LiveBuild,
    build_rows,
    live_build,
    packages_error,
    promotable,
    render,
)

NEWEST = "warehouse-2026.05-9cf20ab"
MIDDLE = "warehouse-2026.05-ff1f9b4"
OLDEST = "warehouse-2026.05-f1983df"


def version(created: str, *tags: str) -> dict:
    """One item shaped like `GET /user/packages/container/upguage/versions` returns."""
    return {"created_at": created, "metadata": {"container": {"tags": list(tags)}}}


#: Deliberately NOT in newest-first order. A fixture that arrives already sorted cannot
#: distinguish "sorted it" from "returned it unchanged", which is the mutant this file's
#: docstring names first.
SCRAMBLED = [
    version("2026-08-20T01:58:00Z", OLDEST),
    version("2026-08-21T02:30:44Z", NEWEST),
    version("2026-08-20T21:10:46Z", MIDDLE),
]


class TestPromotable:
    def test_newest_first_is_computed_not_inherited(self):
        assert [c.tag for c in promotable(SCRAMBLED)] == [NEWEST, MIDDLE, OLDEST]

    def test_the_deploy_tag_is_not_a_choice(self):
        """`:deploy` is a version of its own here, not a co-tag on the build it points at.

        Promoting it would re-point `:deploy` at `:deploy` -- a no-op that prints like a
        successful deploy and moves nothing.
        """
        versions = [*SCRAMBLED, version("2026-08-20T01:58:43Z", "deploy")]
        assert all(c.tag != "deploy" for c in promotable(versions))

    def test_untagged_versions_are_not_choices(self):
        """Promote hops orphan the index `:deploy` used to wrap. Measured: 2 of 17."""
        versions = [*SCRAMBLED, version("2026-08-20T01:42:22Z"), version("2026-08-20T00:43:39Z")]
        assert len(promotable(versions)) == 3

    def test_a_version_carrying_two_tags_yields_both(self):
        versions = [version("2026-08-21T02:30:44Z", NEWEST, "warehouse-2026.05-abc1234")]
        assert len(promotable(versions)) == 2

    def test_the_sha_survives_a_dirty_suffix_whole(self):
        """Same boundary `promote_check.parse_promoted_tag` owns -- and the reason this
        module calls that function instead of writing a second regex for the same shape.
        """
        (only,) = promotable([version("2026-08-21T02:30:44Z", "warehouse-2026.05-a2020f0-dirty")])
        assert only.sha == "a2020f0-dirty"

    def test_an_unparseable_timestamp_sorts_last_rather_than_first(self):
        """Withheld, not defaulted. A row whose age is unknown must not be able to claim
        the position the operator reads as `newest`.
        """
        versions = [version("not-a-date", "warehouse-2026.05-0000000"), *SCRAMBLED]
        assert [c.tag for c in promotable(versions)][-1] == "warehouse-2026.05-0000000"


class TestLiveBuild:
    def test_a_healthy_report_names_the_sha_and_the_status(self):
        body = '{"status":"ok","build":{"sha":"f1983df","warehouse":"warehouse-2026.05"},"data":{}}'
        live, why_not = live_build(body, 200)
        assert (live, why_not) == (LiveBuild(sha="f1983df", status="ok"), None)

    def test_a_503_still_names_the_build_it_is_serving(self):
        """`build` is baked from Dockerfile args and `health.ts` computes it before every
        return branch, so a degraded box reports its sha verbatim under a 503 (#79). The
        marker's question is "what is the box running", which that answers.
        """
        body = (
            '{"status":"degraded","build":{"sha":"f1983df","warehouse":"warehouse-2026.05"},'
            '"data":{"asOf":null,"missing":["upgauge.duckdb"]}}'
        )
        live, why_not = live_build(body, 503)
        assert why_not is None
        assert live == LiveBuild(sha="f1983df", status="degraded")

    @pytest.mark.parametrize(
        "body,code",
        [
            ("<html>Just a moment...</html>", 403),
            ("", 000),
            ("{}", 200),
            ('{"build":{}}', 200),
        ],
        ids=["challenge-page", "no-response", "empty-object", "build-shaped-but-not-a-report"],
    )
    def test_anything_that_is_not_this_apps_report_is_withheld(self, body, code):
        live, why_not = live_build(body, code)
        assert live is None
        assert why_not


#: The live build every render fixture is positioned against: `f1983df` is the OLDEST of the
#: three, so "live" and "newest" are never the same row -- a fixture where they coincide
#: cannot tell a LIVE marker from a "row 1" marker.
_LIVE = LiveBuild(sha="f1983df", status="ok")


class TestRender:
    def _rows(self, live=_LIVE, **kw):
        return build_rows(
            promotable(SCRAMBLED),
            live=live,
            subjects=kw.get("subjects", {"9cf20ab": "Merge pull request #92", "f1983df": "M8"}),
            rel=kw.get("rel", {"9cf20ab": (0, 89), "ff1f9b4": (0, 74), "f1983df": (0, 0)}),
        )

    def test_the_live_row_is_marked_and_only_it(self):
        marked = [r for r in self._rows() if r.is_live]
        assert [r.sha for r in marked] == ["f1983df"]

    def test_an_unreadable_health_check_says_so_instead_of_marking_nothing(self):
        """THE MUTANT: treat an unreadable `/api/health` as "no live build". Every row is
        then unmarked -- which is also what a genuinely undeployed registry looks like --
        and the table reads as an answer. Asserting on the MARKERS passes under that bug;
        only asserting the emitted reason fails.
        """
        rows = self._rows(live=None)
        out = render(rows, live_error="the last response was HTTP 403")

        # The marker's absence, asserted on the ROWS -- the warning copy under the table
        # says the word "LIVE" itself, so a substring check over the whole render would
        # fail for the wrong reason and hide what this test is actually for.
        assert not any(r.is_live for r in rows)
        assert "not evidence" in out
        assert "HTTP 403" in out
        assert "curl -sS -D - https://upgauge.shipman.dev/api/health" in out

    def test_a_readable_health_check_adds_no_such_warning(self):
        assert "not evidence" not in render(self._rows(), live_error=None)

    def test_a_degraded_live_box_is_visible_in_the_table(self):
        """Promoting onto a box serving 503 is a thing to know BEFORE picking, not after
        the poll spends its 300s budget on it.
        """
        out = render(
            self._rows(live=LiveBuild(sha="f1983df", status="degraded")),
            live_error=None,
        )
        assert "degraded" in out

    def test_a_sha_this_clone_never_fetched_still_renders(self):
        rows = self._rows(subjects={}, rel={})
        out = render(rows, live_error=None)

        assert [r.subject for r in rows] == [None, None, None]
        assert all(t in out for t in (NEWEST, MIDDLE, OLDEST))

    def test_an_older_build_reads_as_older_not_as_zero(self):
        """A rollback target is BEHIND the live build. `git rev-list --count live..old`
        returns 0 for it and 0 for the live row alike, so an implementation built on the
        one-sided count prints `+0` next to the tag an operator is reaching for in an
        outage. Only the `--left-right` pair distinguishes them, and only a fixture with a
        build on BOTH sides of live can tell the two implementations apart.
        """
        out = render(
            self._rows(rel={"9cf20ab": (0, 89), "ff1f9b4": (0, 74), "f1983df": (0, 0)}),
            live_error=None,
        )
        rollback = render(
            self._rows(
                live=LiveBuild(sha="ff1f9b4", status="ok"),
                rel={"9cf20ab": (0, 15), "ff1f9b4": (0, 0), "f1983df": (74, 0)},
            ),
            live_error=None,
        )
        assert "+89" in out
        assert "-74" in rollback

    def test_rows_are_numbered_from_one_in_display_order(self):
        assert [(r.index, r.tag) for r in self._rows()] == [
            (1, NEWEST),
            (2, MIDDLE),
            (3, OLDEST),
        ]


class TestPackagesError:
    def test_a_404_names_the_scope_rather_than_the_status(self):
        """A token without package read scope 404s -- indistinguishable from a package
        that does not exist, and the wrong one of those sends an operator to the registry.
        """
        assert "read:packages" in packages_error("gh: Package not found. (HTTP 404)")

    def test_any_other_failure_is_passed_through_unembellished(self):
        assert "read:packages" not in packages_error("gh: Bad credentials (HTTP 401)")
