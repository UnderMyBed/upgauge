"""`deploy/promote.py`'s own confirmation of a promote, read from the operator's machine (#209).

`promote.yml` polls `/api/health` from a GitHub runner, and Bot Fight Mode serves that runner a
challenge page: 30 of 30 attempts on 2026-10-02 read a 403, against a box serving the promoted
build under `ok`. So the workflow's exit code cannot say whether a promote landed, and
`make promote` decides from what THIS machine reads, through `promote_check.assess` -- the one
verdict function, never a second copy of its rules.

Each test names the mutant it exists to kill:

  * a degraded box counted as a deploy (`assess`'s #79 rule, at this call site);
  * an unreadable box counted as either outcome -- blind is neither success nor failure evidence;
  * stopping on the first attempt rather than polling until the box answers;
  * the workflow's exit code deciding instead of the local verdict, in BOTH directions.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "deploy"))

import promote  # noqa: E402
from promote import confirm  # noqa: E402

TAG = "warehouse-2026.06-1893e86"
OK = (
    json.dumps(
        {
            "status": "ok",
            "build": {"sha": "1893e86", "warehouse": "warehouse-2026.06"},
            "data": {"asOf": "2026-06", "missing": []},
        }
    ),
    200,
)
DEGRADED = (
    json.dumps(
        {
            "status": "degraded",
            "build": {"sha": "1893e86", "warehouse": "warehouse-2026.06"},
            "data": {"missing": ["dim_carrier"]},
        }
    ),
    503,
)
OLD_BUILD = (
    json.dumps(
        {
            "status": "ok",
            "build": {"sha": "b91e0cb", "warehouse": "warehouse-2026.06"},
            "data": {"asOf": "2026-06", "missing": []},
        }
    ),
    200,
)
CHALLENGE = ("<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>", 403)


def replies(*bodies):
    """A fetch that answers each attempt in turn, repeating the last one after that."""
    seen = list(bodies)

    def fetch():
        return seen.pop(0) if len(seen) > 1 else seen[0]

    return fetch


def no_sleep(_seconds):
    pass


class TestConfirm:
    def test_the_promoted_build_under_ok_confirms(self):
        code, message = confirm(TAG, fetch=replies(OK), sleep=no_sleep)
        assert code == 0
        assert "1893e86" in message

    def test_a_degraded_box_on_the_promoted_build_is_not_a_deploy(self):
        """Catches: deciding on the build alone. #79 -- the box names the promoted sha
        verbatim under a 503, and that is an outage, not a deploy."""
        code, message = confirm(TAG, fetch=replies(DEGRADED), sleep=no_sleep, attempts=3)
        assert code == 1
        assert "degraded" in message
        assert "ROLL BACK" in message

    def test_another_build_serving_is_a_mismatch_naming_it(self):
        code, message = confirm(TAG, fetch=replies(OLD_BUILD), sleep=no_sleep, attempts=3)
        assert code == 1
        assert "b91e0cb" in message

    def test_an_unreadable_box_is_reported_as_blind_not_as_a_failed_deploy(self):
        """Catches: reading a challenge page as success, or as a failed deploy. Blind from
        here too means the hand check decides, and the message must say exactly that."""
        code, message = confirm(TAG, fetch=replies(CHALLENGE), sleep=no_sleep, attempts=3)
        assert code == 1
        assert "NOT evidence" in message
        assert promote._HAND_CHECK in message

    def test_it_polls_until_the_box_answers(self):
        """Catches: deciding on the first attempt. The box takes ~55s from retag to serving."""
        naps = []
        code, _ = confirm(
            TAG,
            fetch=replies(OLD_BUILD, CHALLENGE, OK),
            sleep=naps.append,
            attempts=5,
            interval=7,
        )
        assert code == 0
        assert naps == [7, 7]

    def test_it_gives_up_after_its_budget(self):
        calls = []

        def fetch():
            calls.append(1)
            return OLD_BUILD

        confirm(TAG, fetch=fetch, sleep=no_sleep, attempts=4)
        assert len(calls) == 4


class TestDispatchDecidesLocally:
    """A pinned function is not a pinned call site: these drive `dispatch` itself."""

    @pytest.fixture
    def wired(self, monkeypatch):
        def wire(workflow_rc: int, health):
            monkeypatch.setattr(
                promote, "_run", lambda args, **kw: subprocess.CompletedProcess(args, 0, "", "")
            )
            monkeypatch.setattr(promote, "find_run", lambda _at: 42)
            monkeypatch.setattr(
                promote.subprocess,
                "run",
                lambda args, **kw: subprocess.CompletedProcess(args, workflow_rc),
            )
            monkeypatch.setattr(promote, "fetch_health", lambda: health)
            monkeypatch.setattr(promote.time, "sleep", no_sleep)

        return wire

    def test_a_blind_red_workflow_does_not_fail_a_deploy_this_machine_confirms(self, wired):
        """Catches: returning the workflow's exit code. 2026-10-02's promote was red on a
        healthy deploy because the runner was challenged."""
        wired(workflow_rc=1, health=OK)
        assert promote.dispatch(TAG) == 0

    def test_a_green_workflow_does_not_pass_a_deploy_this_machine_refutes(self, wired):
        """Catches: OR-ing the two verdicts. The local read is the authority both ways."""
        wired(workflow_rc=0, health=OLD_BUILD)
        assert promote.dispatch(TAG) == 1
