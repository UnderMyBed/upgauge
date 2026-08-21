#!/usr/bin/env python3
"""Pick a built image and promote it to `:deploy`.

`promote.yml` takes an immutable tag and nothing else, deliberately -- promoting is a
decision, and a workflow that defaults to "newest" is continuous deployment with a
confirmation step. But the registry gives an operator no way to MAKE that decision: `GET
/v2/.../tags/list` returns tags unordered, and every one of them is
`warehouse-YYYY.MM-<7-char-sha>`, so "which of these is newest" is unanswerable without
leaving the terminal. Measured 2026-08-21: 14 promotable tags, every one of them sharing the
`warehouse-2026.05-` prefix, which leaves a 7-character sha as the only distinguishing part
of any of them.

This closes that gap and nothing else. It does not choose, does not default, and does not
promote anything the operator did not name.

WHAT IT REFUSES TO GUESS
    Three sources feed the table, and each fails differently:

      * the Packages API -- no list, no picker; this exits.
      * `git log` -- a build made from a commit this clone never fetched still gets a row,
        with its subject shown as absent rather than blank.
      * `/api/health` -- if it cannot be read, NO row is marked LIVE, and the table says
        why. A table with no LIVE marker is indistinguishable from a registry nothing has
        ever been promoted from, so silence there is an answer this tool has not earned.
        That is `promote_check.py`'s blind-poll rule (its module docstring has the incident:
        30 attempts served a challenge page, and an unconditional ROLL BACK NOW emitted
        against a healthy deploy) applied to the operator's terminal instead of a runner's.

    `:deploy` IS ITS OWN VERSION IN THIS REGISTRY, not a co-tag on the build it points at --
    `imagetools create` wraps the source manifest in a new index, which `deploy.md` warns
    about for digest comparison and which matters here too: `deploy` and the untagged
    indexes earlier promotes orphaned (2 of 17 versions on 2026-08-21) are filtered out of
    the pick list. Offering either would dispatch `promote.yml` with a tag it cannot
    resolve, or re-point `:deploy` at itself and print a no-op as a deploy.

    What the box is RUNNING therefore cannot come from the registry at all. It comes from
    `/api/health`, which is also why a `degraded` box is called out above the prompt: that
    is a thing to know before picking, not after `promote.yml` spends its 300s budget on it.

The pure/impure split mirrors `promote_check.py`, for the same reason: the deciding half is
where the bugs are, and it is the half a test can reach.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / ".github" / "scripts"))

from promote_check import (  # noqa: E402
    _HAND_CHECK,
    parse_promoted_tag,
    printable,
    read_health,
)

PACKAGE = "upguage"
WORKFLOW = "promote.yml"
HEALTH_URL = "https://upgauge.shipman.dev/api/health"

#: `gh run list` is polled after dispatch rather than read once: a run does not appear the
#: instant `gh workflow run` returns, and `--limit 1` read too early attaches the operator to
#: the PREVIOUS promote's log -- a stale success printed over a dispatch that may not have
#: started. 15 x 2s.
_RUN_LOOKUP_ATTEMPTS = 15
_RUN_LOOKUP_INTERVAL = 2

#: Local clock vs GitHub's. The run is matched by "created after we dispatched", so any skew
#: toward a fast local clock would discard the real run and report it missing.
_CLOCK_SKEW = timedelta(seconds=60)

_UNKNOWN_TS = datetime.min.replace(tzinfo=UTC)


@dataclass(frozen=True)
class Candidate:
    """One promotable tag in the registry."""

    tag: str
    sha: str
    created: datetime | None


@dataclass(frozen=True)
class LiveBuild:
    """What `/api/health` says the box is running, and how it is running it."""

    sha: str
    status: str


@dataclass(frozen=True)
class Row:
    """One printed line. Every field is resolved before rendering, so `render` decides
    nothing and can be asserted against directly."""

    index: int
    tag: str
    sha: str
    built: str
    subject: str | None
    behind: int | None
    ahead: int | None
    is_live: bool
    live_status: str | None


def _timestamp(raw: object) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def promotable(versions: list[dict]) -> list[Candidate]:
    """Warehouse-shaped tags from a Packages `versions` response, newest first.

    The API happens to return newest-first today. That is not relied on: "row 1 is the
    newest build" is the one claim the whole picker rests on, so it is computed here.

    Tag shape is `promote_check.parse_promoted_tag`'s call, never a second regex for the
    same thing -- that function already owns the `-dirty` boundary a naive split gets wrong,
    and two copies of a parse rule is one copy plus a place for it to disagree.
    """
    candidates: list[Candidate] = []
    for version in versions:
        metadata = version.get("metadata") or {}
        container = metadata.get("container") or {}
        for tag in container.get("tags") or []:
            parsed = parse_promoted_tag(tag) if isinstance(tag, str) else None
            if parsed is None:
                continue
            candidates.append(
                Candidate(tag=tag, sha=parsed[1], created=_timestamp(version.get("created_at")))
            )
    # An unparseable timestamp sorts LAST, never first: a row whose age is unknown must not
    # be able to occupy the position an operator reads as "newest".
    candidates.sort(key=lambda c: c.created or _UNKNOWN_TS, reverse=True)
    return candidates


def live_build(body: str, http_status: int) -> tuple[LiveBuild | None, str | None]:
    """`(LiveBuild, None)` when the box named a build, `(None, why-not)` otherwise.

    A 503 still names one, and is not withheld: `build` is baked from the Dockerfile's
    runtime args and `health.ts`'s `identity()` computes it before every return branch, so a
    degraded box reports its sha verbatim (#79). The marker's question is "what is the box
    running", which that answers -- the STATUS is carried alongside rather than used to
    reject, and surfaces in the table.
    """
    report, why_not = read_health(body, http_status)
    if why_not:
        return None, why_not
    sha = (report.get("build") or {}).get("sha")
    if not isinstance(sha, str) or not sha:
        return None, "the health report carries no build sha"
    return LiveBuild(sha=printable(sha), status=printable(str(report.get("status")))), None


def build_rows(
    candidates: list[Candidate],
    live: LiveBuild | None,
    subjects: dict[str, str],
    rel: dict[str, tuple[int, int]],
) -> list[Row]:
    """Resolve every display field. `subjects` and `rel` are what git could answer; a
    missing key is an absence to render, never a zero to print."""
    rows = []
    for index, candidate in enumerate(candidates, start=1):
        is_live = live is not None and candidate.sha == live.sha
        behind, ahead = rel.get(candidate.sha, (None, None))
        rows.append(
            Row(
                index=index,
                tag=candidate.tag,
                sha=candidate.sha,
                built=candidate.created.strftime("%Y-%m-%d %H:%M") if candidate.created else "?",
                subject=subjects.get(candidate.sha),
                behind=behind,
                ahead=ahead,
                is_live=is_live,
                live_status=live.status if (is_live and live) else None,
            )
        )
    return rows


def _rel_column(row: Row) -> str:
    if row.is_live:
        return "LIVE"
    if row.ahead is None:
        return "?"
    if row.ahead:
        return f"+{row.ahead}"
    return f"-{row.behind}" if row.behind else "="


def render(rows: list[Row], live_error: str | None) -> str:
    """The table, plus whatever could not be established under it."""
    width = max((len(r.tag) for r in rows), default=0)
    lines = [f"  {'#':>3}  {'BUILT':<16}  {'REL':>5}  {'TAG':<{width}}  COMMIT"]
    for row in rows:
        subject = row.subject or "(commit not in this clone)"
        lines.append(
            f"  {row.index:>3}  {row.built:<16}  {_rel_column(row):>5}  "
            f"{row.tag:<{width}}  {subject[:64]}"
        )

    degraded = [r for r in rows if r.is_live and r.live_status != "ok"]
    for row in degraded:
        lines += [
            "",
            f"  !  The live build is reporting `{row.live_status}`, not `ok`. The box is up and",
            "     serving that state to every visitor; promoting is how it gets fixed, but the",
            f"     health poll will read `{row.live_status}` until the new image opens its\n"
            "     data layer.",
        ]

    if live_error:
        lines += [
            "",
            "  !  Could not read the live build, so NO row is marked LIVE. That is not evidence",
            f"     nothing is deployed -- {live_error}",
            f"     Check by hand: {_HAND_CHECK}",
        ]
    return "\n".join(lines)


def packages_error(message: str) -> str:
    """A token without package read scope 404s exactly like a package that does not exist,
    and only one of those two is worth going to the registry over."""
    if "404" in message or "not found" in message.lower():
        return (
            f"{message}\n"
            f"Either the `{PACKAGE}` container package is gone, or this `gh` token carries no "
            "package read scope.\nCheck with `gh auth status`; add it with "
            "`gh auth refresh -s read:packages`."
        )
    return message


def _run(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, **kwargs)


def fetch_versions() -> list[dict]:
    done = _run(
        [
            "gh",
            "api",
            "--paginate",
            f"/user/packages/container/{PACKAGE}/versions?per_page=100",
        ]
    )
    if done.returncode != 0:
        raise SystemExit(f"Could not list image versions.\n{packages_error(done.stderr.strip())}")
    # `--paginate` concatenates one JSON array per page rather than merging them.
    versions: list[dict] = []
    decoder = json.JSONDecoder()
    raw, at = done.stdout.strip(), 0
    while at < len(raw):
        page, at = decoder.raw_decode(raw, at)
        versions.extend(page)
        while at < len(raw) and raw[at].isspace():
            at += 1
    return versions


def fetch_health(url: str = HEALTH_URL) -> tuple[str, int]:
    """`(body, status)`, shaped like curl's `-w '%{http_code}'`: 0 means no response line
    arrived at all, which `read_health` reports distinctly from an empty body."""
    request = urllib.request.Request(url, headers={"User-Agent": "upgauge-promote"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            return response.read(8000).decode("utf-8", "replace"), response.status
    except urllib.error.HTTPError as exc:
        return exc.read(8000).decode("utf-8", "replace"), exc.code
    except Exception as exc:  # noqa: BLE001 -- DNS, TLS, timeout: all "could not read it"
        return f"{type(exc).__name__}: {exc}", 0


def git_subjects(shas: list[str]) -> dict[str, str]:
    subjects = {}
    for sha in shas:
        done = _run(["git", "log", "-1", "--format=%s", sha])
        if done.returncode == 0 and done.stdout.strip():
            subjects[sha] = done.stdout.strip()
    return subjects


def git_rel(live_sha: str, shas: list[str]) -> dict[str, tuple[int, int]]:
    """`{sha: (behind, ahead)}` relative to the live build, for the shas git can resolve.

    `--left-right --count A...B` is what separates "3 commits newer" from "3 commits older";
    a plain `rev-list --count A..B` returns 0 for BOTH the live build and every build older
    than it, which would print `+0` next to a rollback target.
    """
    rel = {}
    for sha in shas:
        done = _run(["git", "rev-list", "--left-right", "--count", f"{live_sha}...{sha}"])
        if done.returncode != 0:
            continue
        parts = done.stdout.split()
        if len(parts) == 2 and all(p.isdigit() for p in parts):
            rel[sha] = (int(parts[0]), int(parts[1]))
    return rel


def choose(candidates: list[Candidate]) -> str | None:
    live, why_not = live_build(*fetch_health())
    shas = [c.sha for c in candidates]
    rows = build_rows(
        candidates,
        live=live,
        subjects=git_subjects(shas),
        rel=git_rel(live.sha, shas) if live else {},
    )
    print(render(rows, printable(why_not) if why_not else None))
    print()

    prompt = f"Promote which? [1-{len(rows)}, q to quit]: "
    while True:
        try:
            answer = input(prompt).strip()
        except EOFError:
            print()
            return None
        if answer.lower() in {"q", "quit"}:
            return None
        if answer.isdigit() and 1 <= int(answer) <= len(rows):
            return rows[int(answer) - 1].tag
        print("  Type a row number, or q. Nothing is promoted until you do.")


def find_run(dispatched_at: datetime) -> int | None:
    """The run this invocation just created, or None if it never appeared."""
    for _ in range(_RUN_LOOKUP_ATTEMPTS):
        done = _run(
            [
                "gh",
                "run",
                "list",
                "--workflow",
                WORKFLOW,
                "--json",
                "databaseId,createdAt",
                "--limit",
                "20",
            ]
        )
        if done.returncode == 0:
            fresh = [
                run
                for run in json.loads(done.stdout or "[]")
                if (_timestamp(run.get("createdAt")) or _UNKNOWN_TS) >= dispatched_at
            ]
            if fresh:
                return min(fresh, key=lambda r: _timestamp(r["createdAt"]))["databaseId"]
        time.sleep(_RUN_LOOKUP_INTERVAL)
    return None


def dispatch(tag: str) -> int:
    dispatched_at = datetime.now(UTC) - _CLOCK_SKEW
    done = _run(["gh", "workflow", "run", WORKFLOW, "-f", f"tag={tag}"])
    if done.returncode != 0:
        print(f"Dispatch failed: {done.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"Dispatched {WORKFLOW} with tag={tag}. Finding the run ...")

    run_id = find_run(dispatched_at)
    if run_id is None:
        # The dispatch SUCCEEDED; only the attach failed. Reporting this as a failed promote
        # would be the same mistake `promote_check.py`'s blind branch exists to refuse.
        print(
            "The promote was dispatched but its run could not be found to watch. It is very "
            f"likely running.\n  gh run list --workflow {WORKFLOW}",
            file=sys.stderr,
        )
        return 1

    print(f"Watching run {run_id} -- it polls /api/health for up to 300s.\n")
    return subprocess.run(["gh", "run", "watch", str(run_id), "--exit-status"]).returncode


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "tag",
        nargs="?",
        help="promote this tag without showing the picker, e.g. warehouse-2026.05-9cf20ab",
    )
    tag = parser.parse_args(argv[1:]).tag

    if tag:
        if parse_promoted_tag(tag) is None:
            print(
                f"'{printable(tag)}' is not the warehouse-YYYY.MM-<sha> shape image.yml "
                "publishes. Run `make promote` with no TAG to see what exists.",
                file=sys.stderr,
            )
            return 1
    else:
        candidates = promotable(fetch_versions())
        if not candidates:
            print("No promotable image tags in the registry.", file=sys.stderr)
            return 1
        tag = choose(candidates)
        if tag is None:
            print("Nothing promoted.")
            return 0

    return dispatch(tag)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
