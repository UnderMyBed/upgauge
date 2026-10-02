"""`deploy/promote.py`'s own confirmation of a promote, read from the operator's machine (#209).

`promote.yml` re-tags `:deploy` and nothing else: a GitHub runner cannot read the site, because
Bot Fight Mode serves it a challenge page (30 of 30 attempts a 403 on both 2026-10-02 promotes,
against a box serving the promoted build under `ok`). So the workflow's exit code decides the
RETAG, and `make promote` decides the DEPLOY from what THIS machine reads, through
`promote_check.assess` and `exhausted_report` -- the one verdict and the one set of remedies,
never a second copy of either.

Each test names the mutant it exists to kill:

  * a degraded box counted as a deploy (`assess`'s #79 rule, at this call site);
  * an unreadable box counted as either outcome -- blind is neither success nor failure evidence;
  * stopping on the first attempt, or on a degraded one, rather than polling until `ok`;
  * a shorter default budget than the 300s the box is given (`attempts` 12, not 30);
  * a second, shorter copy of the remedies in place of `exhausted_report`'s;
  * one blind final attempt deciding the verdict over earlier attempts that read a build;
  * deciding the retag from `gh run watch`'s exit code instead of the run's recorded state;
  * confirming after a retag step that did not succeed;
  * calling an unknown retag either "not moved" or "moved";
  * a `RETAG_STEP` that no longer names `promote.yml`'s step;
  * OR-ing a green workflow with a local read that refutes the deploy.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parents[2] / "deploy"))

import promote  # noqa: E402
from promote import confirm  # noqa: E402
from promote_check import assess  # noqa: E402

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
        assert "NOT EVIDENCE EITHER WAY" in message
        assert promote._HAND_CHECK in message

    def test_it_polls_until_the_box_answers(self):
        """Catches: deciding on the first attempt, or stopping on a degraded one. The box takes
        ~55s from retag to serving, and a promote made to FIX a degraded box reads it degraded
        until the new image is up -- failing fast there reds the deploy that repairs the outage.
        Mutant: return on DEGRADED inside the loop."""
        naps = []
        code, _ = confirm(
            TAG,
            fetch=replies(OLD_BUILD, DEGRADED, CHALLENGE, OK),
            sleep=naps.append,
            attempts=5,
            interval=7,
        )
        assert code == 0
        assert naps == [7, 7, 7]

    def test_it_gives_up_after_its_budget(self):
        calls = []

        def fetch():
            calls.append(1)
            return OLD_BUILD

        confirm(TAG, fetch=fetch, sleep=no_sleep, attempts=4)
        assert len(calls) == 4

    def test_the_default_budget_is_the_300s_the_box_is_given(self):
        """30 x 10s, the budget the workflow used to hold. Retag-to-serving is ~55s and a
        rollback ~85s (deploy.md), but the timer tick and the healthcheck's start period stack
        on a slow pull, and this is now the ONLY detector of a bad promote. Mutant:
        `_CONFIRM_ATTEMPTS = 12`, the budget it had while the workflow still polled."""
        calls, naps = [], []

        def fetch():
            calls.append(1)
            return OLD_BUILD

        confirm(TAG, fetch=fetch, sleep=naps.append)
        assert len(calls) == 30
        assert sum(naps) == 290, "30 attempts 10s apart"

    def test_an_exhausted_mismatch_reports_the_one_owned_remedy(self):
        """Catches: a second, shorter copy of the remedies here, which drifts from
        `exhausted_report` the first time either is edited. The message IS that report.
        "The tag moved; the deploy did not." is a phrase only the report carries. Mutant: the
        old short message ("The box is not serving the promoted build: ...")."""
        code, message = confirm(TAG, fetch=replies(OLD_BUILD), sleep=no_sleep, attempts=3)
        assert code == 1
        assert "The tag moved; the deploy did not." in message
        assert message == assess(TAG, *OLD_BUILD).exhausted_report(3)

    def test_one_blind_final_attempt_does_not_downgrade_a_read_mismatch(self):
        """Two reads of the wrong build earn the unconditional rollback; a single challenge
        page on the last attempt must not turn that into "could not read the box". Mutant:
        reporting the last sample instead of the last one that read a build."""
        code, message = confirm(
            TAG, fetch=replies(OLD_BUILD, OLD_BUILD, CHALLENGE), sleep=no_sleep, attempts=3
        )
        assert code == 1
        assert "The tag moved; the deploy did not." in message
        assert "NOT EVIDENCE EITHER WAY" not in message

    def test_one_blind_final_attempt_does_not_downgrade_a_read_degraded_box(self):
        """Same carry, the other outcome that reads a build. Mutant: as above."""
        code, message = confirm(
            TAG, fetch=replies(DEGRADED, DEGRADED, CHALLENGE), sleep=no_sleep, attempts=3
        )
        assert code == 1
        assert message == assess(TAG, *DEGRADED).exhausted_report(3)


def _run_state(status="completed", conclusion="success", retag="success"):
    """`gh run view --json status,conclusion,jobs`, shaped as `gh` emits it. `retag=None`
    leaves the retag step out of the run entirely."""
    steps = [
        {"name": "Set up job", "conclusion": "success"},
        {"name": "Validate the tag's shape before touching the registry", "conclusion": "success"},
    ]
    if retag is not None:
        steps.append({"name": promote.RETAG_STEP, "conclusion": retag})
    return {
        "status": status,
        "conclusion": conclusion,
        "jobs": [{"name": "promote", "steps": steps}],
    }


class TestDispatchDecidesLocally:
    """A pinned function is not a pinned call site: these drive `dispatch` itself, through the
    `gh run view` call it really makes."""

    @pytest.fixture
    def wired(self, monkeypatch, capsys):
        def wire(watch_rc: int, run, health=OK):
            """`run` is the recorded run state, or None for a `gh run view` that fails."""

            def fake_run(args, **kw):
                if args[:3] == ["gh", "run", "view"]:
                    if run is None:
                        return subprocess.CompletedProcess(args, 1, "", "HTTP 502")
                    return subprocess.CompletedProcess(args, 0, json.dumps(run), "")
                return subprocess.CompletedProcess(args, 0, "", "")

            monkeypatch.setattr(promote, "_run", fake_run)
            monkeypatch.setattr(promote, "find_run", lambda _at: 42)
            # `gh run watch`, which `dispatch` calls through `subprocess.run` directly.
            monkeypatch.setattr(
                promote.subprocess,
                "run",
                lambda args, **kw: subprocess.CompletedProcess(args, watch_rc),
            )
            reads = []
            monkeypatch.setattr(promote, "fetch_health", lambda: reads.append(1) or health)
            monkeypatch.setattr(promote.time, "sleep", no_sleep)
            return reads

        return wire

    def test_a_successful_run_confirms_even_when_the_watch_exited_red(self, wired):
        """`gh run watch` is non-zero when the WATCH fails too -- a dropped connection, an
        interrupted terminal -- on a run that retagged fine. Mutant: deciding on the watch
        exit code again."""
        reads = wired(watch_rc=1, run=_run_state())
        assert promote.dispatch(TAG) == 0
        assert reads, "a retag that went through was never confirmed"

    def test_a_green_workflow_does_not_pass_a_deploy_this_machine_refutes(self, wired, capsys):
        """Catches: OR-ing the two verdicts. The local read is the authority both ways.

        The 1 alone is not the property: the UNKNOWN branch also returns 1, without reading
        the box at all, so a successful run misread as unknown passed this test while it
        asserted only the exit code. So it asserts the box WAS read and the verdict is the
        mismatch. Mutants: `code = 0` after `confirm`; `success` read as UNKNOWN."""
        reads = wired(watch_rc=0, run=_run_state(), health=OLD_BUILD)
        assert promote.dispatch(TAG) == 1
        assert reads, "the box was never read, so nothing refuted the deploy"
        assert "The tag moved; the deploy did not." in capsys.readouterr().err

    def test_a_failed_retag_step_is_not_moved_and_is_not_confirmed(self, wired, capsys):
        """The retag step failed or was skipped, so `:deploy` never moved and there is no
        promote to confirm. Health reads `ok` deliberately: a confirmation after a failed
        retag would read the UNCHANGED box and report success. Mutant: the NOT_MOVED branch
        falling through to `confirm`."""
        for retag in ("failure", "skipped", "cancelled"):
            reads = wired(watch_rc=1, run=_run_state(conclusion="failure", retag=retag))
            assert promote.dispatch(TAG) == 1, retag
            assert reads == [], f"the box was polled after a retag that never went through: {retag}"
            err = capsys.readouterr().err
            assert "was not moved" in err, retag
            assert "UNKNOWN" not in err, retag

    def test_a_red_run_whose_retag_succeeded_is_unknown_not_not_moved(self, wired, capsys):
        """The retag step succeeded, so `:deploy` MAY have moved, and the run is red anyway.
        Neither answer is earned. NOT vacuous against a fall-through to NOT_MOVED: that branch
        prints "was not moved", asserted absent here, and a fall-through to `confirm` would read
        `ok` and return 0. Mutant: UNKNOWN reported as "not moved"."""
        reads = wired(watch_rc=1, run=_run_state(conclusion="failure", retag="success"))
        assert promote.dispatch(TAG) == 1
        assert reads == [], "an unknown retag was confirmed as though it had gone through"
        err = capsys.readouterr().err
        assert "UNKNOWN" in err
        assert "was not moved" not in err, "an unknown retag was reported as not moved"
        assert "gh run view 42" in err
        assert promote._HAND_CHECK in err

    def test_an_unreadable_or_unfinished_run_is_unknown(self, wired, capsys):
        """`gh run view` failing on every retry, a run not yet completed, and a run with no
        step by the retag step's name all leave the question open."""
        for run in (
            None,
            _run_state(status="in_progress", conclusion=""),
            _run_state(conclusion="failure", retag=None),
        ):
            reads = wired(watch_rc=1, run=run)
            assert promote.dispatch(TAG) == 1, run
            assert reads == [], run
            err = capsys.readouterr().err
            assert "UNKNOWN" in err and "was not moved" not in err, run

    def test_the_retag_step_name_is_the_one_in_promote_yml(self):
        """A rename of the workflow step that is not mirrored in `RETAG_STEP` sends every red
        run to UNKNOWN, silently. Mutant: `RETAG_STEP` changed."""
        workflow = yaml.safe_load(
            (Path(__file__).parents[2] / ".github" / "workflows" / "promote.yml").read_text()
        )
        names = [
            step.get("name")
            for job in workflow["jobs"].values()
            for step in job["steps"]
            if isinstance(step, dict)
        ]
        assert promote.RETAG_STEP in names, f"{promote.RETAG_STEP!r} is not a step in {names}"
