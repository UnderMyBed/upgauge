"""Tell a human when an unattended workflow goes red (#61).

The adjacent rule to the one `freshness.py` serves. That alert fires when the data STOPS
moving. This one fires when the data moved correctly and the repository's own gates went red
about it -- the opposite case, which no freshness check can ever catch:

    2026-08-14 07:59Z  Warehouse publishes warehouse-2026.05
    2026-08-15 04:49Z  Verify (reproducibility) fails. FIRST RED
    2026-08-16 04:51Z  fails again
    2026-08-17 05:00Z  fails again
    2026-08-17 16:27Z  an unrelated PR opens and reddens four jobs -- the first human signal

`verify.yml` did its job on the very first night. Nothing carried that to anybody.

WHY THIS IS A SEPARATE WORKFLOW, NOT A STEP IN EACH SCHEDULED ONE
    Same argument freshness.yml's header makes: an alert that shares a fate with the thing it
    watches is not an alert. A notify step inside `verify.yml` cannot report `verify.yml` being
    disabled for repository inactivity, being deleted, or failing before the step is reached.
    It also keeps `issues: write` off the workflows that restore a warehouse and run `make`.

WHY THE CONCLUSION TEST IS AN ALLOW-LIST
    CLAUDE.md holds the cacheability predicate to exactly this rule -- an allow-list, never
    `!== "notFound"` -- and the reason generalises. `!= "success"` looks identical on every run
    except a CANCELLED one, which is usually a human superseding a run deliberately. An alert
    that pages on deliberate cancellation is one that gets muted, and muting it costs the real
    signal it exists to carry.

WHY A DISPATCHED RUN COUNTS AS UNATTENDED
    Partly honesty -- a nightly someone dispatched and walked away from is unwatched in exactly
    the way this alert is about. Mostly demonstrability: a `workflow_run` workflow only ever
    runs the copy on the DEFAULT branch, so a hand dispatch is the only way to exercise this
    path end to end. freshness.yml's `as_of` input solves the same problem the same way, and
    for the reason CLAUDE.md gives: a notification that has never fired is a dark guard.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass

from gha import write_multiline_output

#: Outcomes worth waking somebody for. An ALLOW-LIST -- see the module docstring. `timed_out`
#: is here because `verify.yml` carries `timeout-minutes: 60` and rebuilds the warehouse twice,
#: so its slow-death mode reports `timed_out` and never `failure`.
ALERTING_CONCLUSIONS = frozenset({"failure", "timed_out"})

#: Triggers with no human attached to the run. A `push` or `pull_request` red already reaches
#: its author through the checks on the commit or the PR, and duplicating that is how an alert
#: becomes noise. CodeQL is the live case: it runs on all three.
UNATTENDED_EVENTS = frozenset({"schedule", "workflow_dispatch"})


def title_for(workflow: str) -> str:
    """The dedupe key as well as the title.

    Keyed on the WORKFLOW, never on the label alone. A dataset advance reddens more than one
    scheduled workflow, so a label-only key -- the shape freshness.yml can afford, having
    exactly one alert -- would file the first and silently swallow every one after it.
    """
    return f"Scheduled run failed: {workflow}"


@dataclass(frozen=True)
class Alert:
    file_issue: bool
    title: str
    body: str
    reason: str


def _body(workflow: str, conclusion: str, event: str, url: str) -> str:
    """Everything the alert actually knows, and nothing it does not.

    It knows a run went red. It does NOT know why, and a body that asserts a cause -- "the
    dataset moved" being the tempting one, since that is what happened the day this was
    written -- trains the reader to skip the log and would be wrong the first time a run failed
    for any other reason.
    """
    return "\n".join(
        [
            f"**{workflow}** ended in `{conclusion}` on a `{event}` run.",
            "",
            "A scheduled run has no author to notify, so nothing else reports this. Measured "
            "in this repository: three consecutive nights of red on `main` reached nobody, and "
            "the first human signal was an unrelated pull request four days later.",
            "",
            f"- Run: {url}",
            "",
            "## What to check",
            "",
            "1. The run's **data contract** step. It is written to say whether every other red "
            "in the run is a consequence of one upstream change, so it is the cheapest thing "
            "to read first.",
            "2. Whether this is the first night or the fifth. This alert files once per "
            "workflow and then stays quiet, so an old open issue is not an old failure.",
            "",
            "This alert knows the run went red. It does not know why -- the log does.",
        ]
    )


def assess(run: dict, open_issues: list[dict]) -> Alert:
    """`run` is the subset of a `workflow_run` payload this decision needs; `open_issues` is
    what `gh issue list --state open --label scheduled-red --json title` emits."""
    workflow = run["name"]
    conclusion = run["conclusion"]
    event = run["event"]
    title = title_for(workflow)

    if conclusion not in ALERTING_CONCLUSIONS:
        return Alert(False, title, "", f"`{conclusion}` is not an outcome worth alerting on")
    if event not in UNATTENDED_EVENTS:
        return Alert(False, title, "", f"a `{event}` run already reports to its author")
    # Whole title, never a substring: correct today only by accident of naming, since no two
    # watched workflows share a prefix. A `Verify` alert must not mute `Verify
    # (reproducibility)`.
    if any(issue.get("title") == title for issue in open_issues):
        return Alert(False, title, "", "an alert for this workflow is already open")

    return Alert(True, title, _body(workflow, conclusion, event, run["html_url"]), "filing")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 5:
        print("usage: scheduled_failure.py <name> <conclusion> <event> <url> <open-issues-json>")
        return 0
    name, conclusion, event, url, open_issues = args[:5]
    alert = assess(
        {"name": name, "conclusion": conclusion, "event": event, "html_url": url},
        json.loads(open_issues),
    )

    report = [
        f"## Scheduled failure alert — {'filing' if alert.file_issue else 'no alert'}",
        "",
        f"- `{name}` / `{conclusion}` / `{event}`",
        f"- {alert.reason}",
    ]
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write("\n".join(report) + "\n")
    print("\n".join(report))

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            # Always written, both branches: a key that exists only on failure is a key whose
            # absence has two meanings, and the workflow's step condition reads it either way.
            fh.write(f"file_issue={'1' if alert.file_issue else '0'}\n")
            if alert.file_issue:
                write_multiline_output(fh, "issue_title", alert.title)
                write_multiline_output(fh, "issue_body", alert.body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
