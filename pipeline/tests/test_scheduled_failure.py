"""The scheduled-run failure alert (#61).

The adjacent rule to #17's. That alert fires when the data STOPS moving; this one fires when
the data moved correctly and the repository's own gates went red about it. No freshness check
could ever catch the second case, and nothing else was watching:

    2026-08-14 07:59Z  Warehouse publishes warehouse-2026.05; max(year_month) 2026-04 -> 2026-05
    2026-08-15 04:49Z  Verify (reproducibility) fails. FIRST RED
    2026-08-16 04:51Z  fails again
    2026-08-17 05:00Z  fails again
    2026-08-17 16:27Z  an unrelated PR opens and reddens four jobs -- the first human signal

Three nights of red on main reached nobody. `verify.yml` did its job on the very first night.

Every test below names the bug it exists to catch. Three need a fixture built to distinguish a
plausible wrong implementation, because the obvious one passes against the obvious input:

  * Dedupe keyed on the LABEL alone suppresses every workflow after the first, and looks
    correct as long as only one workflow is ever red. `test_an_open_alert_for_a_different_
    workflow_does_not_suppress_this_one` is the only fixture that separates them.
  * Dedupe by substring is correct for every name this repo watches today, and wrong in
    principle -- so `test_dedupe_matches_the_whole_title_not_a_prefix` uses names where one
    contains the other, which no real pair currently does.
  * `conclusion != "success"` and `conclusion in {failure, timed_out}` agree on every run
    except a CANCELLED one, so only the cancelled fixture catches a deny-list written where
    CLAUDE.md requires an allow-list.
  * `SIGNALLED_DISPATCHES` keyed on the TARGET rather than on the EDGE passes every dispatch
    test except `test_a_second_undeclared_dispatch_of_a_signalled_target_is_still_caught`,
    which is the only fixture where one target is dispatched twice.
  * Every dispatch fixture below builds its own workflows, so a parser that matches nothing
    at all leaves them green while this repository's one live dispatch edge stays invisible.
    `test_the_repos_own_dispatch_edge_is_seen` is the guard against that, and
    `test_the_repos_own_workflow_run_edge_is_seen` is its counterpart for the other edge.
  * A dispatch scan bounded by the STEP rather than by the command resolves an unresolvable
    dispatch to a token belonging to a later one -- so it neither raises nor reports the truth.
    A fixture holding the dynamic dispatch ALONE cannot distinguish that, which is what the
    first draft of `test_a_dispatch_target_that_cannot_be_resolved_is_loud` did; the target it
    could borrow has to be in the fixture.
  * The `workflow_run` clause is a SUBSET assertion's blind spot. `test_every_scheduled_
    workflow_in_the_repo_is_watched` asserts `unattended <= watched`, which no missing name can
    fail, so deleting that clause or reversing its direction left the whole suite green. Both
    now die -- against the real directory, and against a fixture that puts the cron on the
    LISTENER, the only arrangement where the two directions disagree.
"""

from __future__ import annotations

import re
import shlex
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from scheduled_failure import ALERTING_CONCLUSIONS, assess, main  # noqa: E402

WORKFLOWS = Path(__file__).parents[2] / ".github" / "workflows"
NOTIFIER = WORKFLOWS / "scheduled-failure.yml"


def _run(
    name: str = "Verify (reproducibility)",
    conclusion: str = "failure",
    event: str = "schedule",
    url: str = "https://github.com/UnderMyBed/upguage/actions/runs/32105217496",
) -> dict:
    """The subset of a `workflow_run` payload this decision needs, named as GitHub names it."""
    return {"name": name, "conclusion": conclusion, "event": event, "html_url": url}


def _issue(title: str) -> dict:
    """The shape `gh issue list --json title` emits."""
    return {"title": title}


# --------------------------------------------------------------------------------------
# Which runs are worth a human's attention
# --------------------------------------------------------------------------------------


def test_a_failed_scheduled_run_files_an_alert():
    """The live case: verify.yml red at 04:49Z on a schedule, three nights running."""
    alert = assess(_run(), open_issues=[])
    assert alert.file_issue is True
    assert "Verify (reproducibility)" in alert.title


def test_a_successful_scheduled_run_never_files():
    """Catches an absent or inverted conclusion check. `workflow_run` fires on `completed`,
    which includes every green nightly -- roughly 364 of them a year."""
    assert assess(_run(conclusion="success"), open_issues=[]).file_issue is False


def test_a_cancelled_run_never_files():
    """The allow-list mutant. CLAUDE.md: a predicate over outcomes is an allow-list, never
    `!= "success"` -- the same rule the cacheability predicate is held to. A cancelled run is
    usually a human superseding it, and an alert that pages on deliberate cancellation is one
    that gets muted. `!= "success"` passes every other test in this file."""
    assert assess(_run(conclusion="cancelled"), open_issues=[]).file_issue is False


def test_a_timed_out_run_files():
    """The other half of the allow-list. `make verify` carries `timeout-minutes: 60` and
    rebuilds the warehouse twice, so a hang reports `timed_out`, not `failure` -- an
    implementation testing `== "failure"` alone goes silent on exactly the slow-death case."""
    assert assess(_run(conclusion="timed_out"), open_issues=[]).file_issue is True


def test_a_push_triggered_failure_never_files():
    """CodeQL runs on `pull_request` and `push: main` as well as its weekly schedule, so
    without an event filter this alert files an issue for every red PR -- on top of the
    existing PR checks that already reach the author. Catches a missing event filter, which no
    other fixture here can: every other run in this file is already a scheduled one."""
    assert assess(_run(name="CodeQL", event="push"), open_issues=[]).file_issue is False


def test_a_dispatched_failure_files():
    """Deliberate, and the reason is demonstrability. `workflow_run` workflows only ever run
    the copy on the default branch, so a hand-dispatched nightly is the ONLY way to exercise
    this path end to end -- the same trick freshness.yml's `as_of` input uses, where the run,
    the failure and the issue are all real and one variable moves. A nightly someone dispatched
    and walked away from is also unwatched, which is the condition this alert is about."""
    assert assess(_run(event="workflow_dispatch"), open_issues=[]).file_issue is True


# --------------------------------------------------------------------------------------
# Not burying its own repeat
# --------------------------------------------------------------------------------------


def test_an_open_alert_for_the_same_workflow_suppresses_a_second():
    """A red nightly stays red every night until someone fixes it -- three nights, in the case
    this issue was written from. Without this, that is three issues, and freshness.yml already
    paid for the lesson that an alert which buries its own repeat gets muted."""
    alert = assess(_run(), open_issues=[_issue("Scheduled run failed: Verify (reproducibility)")])
    assert alert.file_issue is False


def test_an_open_alert_for_a_different_workflow_does_not_suppress_this_one():
    """THE mutant. Dedupe keyed on the `scheduled-red` label alone -- `gh issue list --label
    scheduled-red | length`, which is exactly the shape freshness.yml uses for its single
    alert -- passes every other test in this file and silently swallows the second workflow to
    go red. A dataset advance reddens Verify AND Warehouse, so this is the live case, not a
    hypothetical: the Warehouse alert would never be filed."""
    alert = assess(_run(name="Warehouse"), open_issues=[_issue("Scheduled run failed: Freshness")])
    assert alert.file_issue is True
    assert "Warehouse" in alert.title


def test_dedupe_matches_the_whole_title_not_a_prefix():
    """Correct today by accident of naming -- no two watched workflows share a prefix -- and
    wrong in principle. A substring test means adding a workflow named `Verify` would silently
    mute `Verify (reproducibility)` for as long as the shorter one stayed red."""
    alert = assess(
        _run(name="Verify (reproducibility)"), open_issues=[_issue("Scheduled run failed: Verify")]
    )
    assert alert.file_issue is True


def test_a_closed_alert_does_not_suppress_a_new_one():
    """`open_issues` is what the workflow passes -- `gh issue list --state open`. This pins the
    contract from the script's side: whatever it is handed is treated as currently-open, so a
    workflow that drops `--state open` reddens here rather than going quietly silent forever
    after the first alert is closed."""
    alert = assess(_run(), open_issues=[])
    assert alert.file_issue is True


# --------------------------------------------------------------------------------------
# What the human actually receives
# --------------------------------------------------------------------------------------


def test_the_body_links_the_run_that_failed():
    """Without the URL the operator has to find the run by hand across five workflows. The
    whole point of this alert is that nobody was looking at the Actions tab."""
    alert = assess(
        _run(url="https://github.com/UnderMyBed/upguage/actions/runs/999"), open_issues=[]
    )
    assert "https://github.com/UnderMyBed/upguage/actions/runs/999" in alert.body


def test_the_body_names_the_workflow_and_that_it_was_unattended():
    alert = assess(_run(), open_issues=[])
    assert "Verify (reproducibility)" in alert.body
    assert "schedule" in alert.body


def test_the_body_does_not_guess_a_cause():
    """This alert knows a run went red. It does NOT know why, and a body that asserts a cause
    -- 'the dataset advanced' being the tempting one, since that is what happened the day this
    was written -- trains the reader to skip the log. CLAUDE.md: when a compound claim is found
    false, re-derive each clause; the cheaper fix is not to make the claim."""
    body = assess(_run(), open_issues=[]).body.lower()
    for guess in ("the dataset advanced", "re-pin", "data-contract failed"):
        assert guess not in body


def test_the_body_points_at_the_data_contract_as_the_first_thing_to_check():
    """Not a cause claim -- an ordering. The nightly's data-contract step is designed to say
    'any other red is a consequence of this', so it is where a reader should look first."""
    assert "data contract" in assess(_run(), open_issues=[]).body.lower()


# --------------------------------------------------------------------------------------
# The plumbing between the script and the workflow
# --------------------------------------------------------------------------------------


def test_main_writes_file_issue_with_a_title_and_a_body(monkeypatch, tmp_path):
    out = tmp_path / "out"
    out.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    assert main(["Verify (reproducibility)", "failure", "schedule", "https://x/1", "[]"]) == 0
    written = out.read_text()
    assert "file_issue=1" in written
    assert "issue_title<<" in written
    assert "issue_body<<" in written


def test_main_writes_a_zero_file_issue_when_it_should_not_file(monkeypatch, tmp_path):
    """Always written, both branches -- a key that exists only on failure is a key whose
    absence has two meanings, and the workflow's step condition reads it either way."""
    out = tmp_path / "out"
    out.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    assert main(["Verify (reproducibility)", "success", "schedule", "https://x/1", "[]"]) == 0
    written = out.read_text()
    assert "file_issue=0" in written
    assert "issue_body<<" not in written


def test_main_reads_the_open_issues_argument_and_dedupes_on_it(monkeypatch, tmp_path):
    out = tmp_path / "out"
    out.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    existing = '[{"title": "Scheduled run failed: Verify (reproducibility)"}]'
    assert main(["Verify (reproducibility)", "failure", "schedule", "https://x/1", existing]) == 0
    assert "file_issue=0" in out.read_text()


# --------------------------------------------------------------------------------------
# Assertions about the workflow YAML, which no Python test above can reach
# --------------------------------------------------------------------------------------


def _notifier_text() -> str:
    return NOTIFIER.read_text()


def _triggers(path: Path) -> dict:
    """`on:` is YAML 1.1 truthy, so PyYAML hands it back under the key `True`."""
    doc = yaml.safe_load(path.read_text())
    return doc.get("on", doc.get(True)) or {}


def _workflow_run_targets(path: Path) -> set[str]:
    """The names in this workflow's own `workflow_run.workflows` trigger, if it has one."""
    wr = (_triggers(path) or {}).get("workflow_run")
    return set((wr or {}).get("workflows") or []) if isinstance(wr, dict) else set()


#: `gh workflow run` edges whose dispatched run already carries a human-visible signal, so the
#: dispatched workflow does not also need the notifier. Keyed on the EDGE -- (dispatching file,
#: dispatched file) -- and never on the target alone: an entry claims "this dispatch is
#: signalled", not "this workflow is attended", so a second, undeclared dispatch of the same
#: target is still caught. An ALLOW-LIST, the shape CLAUDE.md holds the cacheability predicate
#: and `ALERTING_CONCLUSIONS` to: the default for a new edge is CAUGHT, and an exemption costs a
#: deliberate entry with a written reason.
SIGNALLED_DISPATCHES: dict[tuple[str, str], str] = {
    ("warehouse.yml", "image-contract.yml"): (
        "The bump-pin job dispatches the gate only on a run that has just opened a PR "
        "(`if: steps.pr.outputs.opened == '1'`) and targets that PR's own branch "
        '(`--ref "$BRANCH"`). Check runs attach to the head SHA, so the dispatched run '
        "appears on a PR that warehouse.yml assigns to the owner and whose body @mentions "
        "them on its first line (bump_pin.pr_body), and a dispatch that never landed is "
        "reported onto that same PR rather than only into a log. Watching `Image contract` "
        "instead would page on the DISPATCHED run -- its event is `workflow_dispatch`, which "
        "scheduled_failure.UNATTENDED_EVENTS alerts on -- filing a `critical`, owner-assigned "
        "issue for a red already delivered to an assigned, @mentioning PR. Its `pull_request` "
        "runs are dropped by that same event filter, as CodeQL's are."
    ),
}


#: The characters `shlex` is told to emit as tokens in their own right: its default operator
#: set, plus the NEWLINE. Bash ends a simple command on a newline exactly as it does on `;`, and
#: `shlex` otherwise swallows newlines as whitespace -- the hole that let a dispatch's target be
#: read out of a later command (see `_dispatch_targets`). `\n` has to leave `whitespace` for
#: this to take effect, since whitespace is tested before punctuation.
_SHELL_OPERATORS = "();<>|&\n"

#: A trailing `\` is a line CONTINUATION -- bash joins the two lines into ONE command, the exact
#: opposite of the bare newline beside it -- and `shlex` resolves that escape into a token
#: byte-identical to the one a bare newline produces. The tokeniser destroys the distinction, so
#: it has to be made before it: continuations are joined first, and every newline `shlex` then
#: reports is a real command boundary. An ODD run of backslashes ends in a continuation; an even
#: run is escaped backslashes followed by a separator that stands.
_LINE_CONTINUATION = re.compile(r"(?<!\\)((?:\\\\)*)\\\n")


def _bash_tokens(scalar: str) -> list[str]:
    """A `run:` scalar word-split as bash would, with the shell operators kept as tokens.

    THE SEMANTIC READING, and deliberately not the raw one. `test_workflow_expressions.py`
    states that a `#` inside a `run:` block is not a comment, because Actions substitutes
    `${{ }}` into the raw scalar before bash ever parses it -- and that rule governs a
    DIFFERENT question: what a value can be spliced into. The question here is whether bash
    runs the command, and bash strips `#`. Reading the raw form instead turns a commented-out
    dispatch into an unattended path that nothing starts.

    COMMENTS ARE THE TOKENISER'S JOB, because only the tokeniser knows what is quoted. A
    line-level filter can only drop a WHOLE comment line, which leaves a trailing `#` in the
    code it hands on -- and one apostrophe in one (`# don't`) makes the scalar untokenisable,
    reddening this gate with a message about dispatch scanning on a step that dispatches
    nothing. warehouse.yml's `classify` step embeds inline Python inside a double-quoted string,
    which is the shape a `#` arrives in next. Measured on the real directory: 5 of 46 `run:`
    scalars do not tokenise raw, 0 do not tokenise here.

    LIMITATION: `shlex` treats `#` as a comment anywhere outside quotes, where bash only does so
    at the start of a word -- so an unquoted mid-word `#` (`echo a#b`) drops the rest of its
    line. None of the 46 scalars contains one.
    """
    lexer = shlex.shlex(
        _LINE_CONTINUATION.sub(r"\1", scalar), posix=True, punctuation_chars=_SHELL_OPERATORS
    )
    lexer.whitespace_split = True
    lexer.whitespace = " \t\r"
    return list(lexer)


def _ends_a_command(token: str) -> bool:
    """Whether `token` is a run of shell operators rather than a word.

    Tested as "every character is an operator" rather than against a list of spellings, because
    `shlex` groups adjacent operators into one token -- `;;`, `&&`, `>>`, `>&`, and a run of
    blank lines all arrive as a single token, and a list would have to enumerate them.
    """
    return bool(token) and set(token) <= set(_SHELL_OPERATORS)


def _dispatch_targets(path: Path, known: dict[str, str]) -> set[str]:
    """Every workflow FILE this one starts with `gh workflow run` -- the second way a run
    begins with nobody in the loop, and the one a `workflow_run` closure cannot see.

    `known` maps file name -> workflow name for the directory being walked. A target is
    resolved against both, because `gh workflow run` accepts either.

    TOKENISED with `shlex` (`_bash_tokens`), never matched with a regex over the text.
    warehouse.yml's own dispatch-failure comment names `gh workflow run` inside a QUOTED
    `--body`, and telling a human how to dispatch by hand is a message, not a call site. Only
    tokenisation separates them: a quoted body is ONE token and can never produce the three
    consecutive `gh` / `workflow` / `run` tokens a real invocation does. The same tokenising
    survives the retry wrapper, whose quoted label repeats the command verbatim.

    THE TARGET IS AN ARGUMENT OF ONE COMMAND, so the search for it ends where that command
    does -- at a shell operator, or at a second `gh`. Scanning to the end of the STEP instead
    breaks the promise below in both directions at once: an unresolvable dispatch borrows a
    resolvable token from a later command, so it does not raise, AND the edge it reports is one
    nothing performs -- the invented-edge class
    `test_a_quoted_mention_of_the_command_is_not_a_dispatch` exists to prevent, arriving by a
    second route. Measured on the first draft, against `{a.yml, b.yml, image-contract.yml}`:
    `gh workflow run "$WF" --ref main` + `echo done b.yml` returned `{b.yml}` and raised
    nothing.

    RAISES on a target it cannot resolve. `gh workflow run "$WF"` is a dispatch this closure
    genuinely cannot follow, and skipping it silently rebuilds #80's blind spot one level down
    -- a rule that enumerates only the dispatches it happens to understand. A red test asking
    a human what that dispatch starts is the honest outcome, and a cross-repository dispatch
    (`--repo other/repo`) resolves to nothing here for the same reason and gets the same
    answer. The message names only tokens from the failing command, so it can never point the
    reader at a word belonging to a different one.

    LIMITATION: the target is the first argument of the invocation that resolves, so a flag
    VALUE equal to a workflow file name or workflow name (`--ref image-contract.yml`) would
    read as the target. No such call site exists, and modelling `gh`'s flag arity to rule it
    out is more machinery than the risk.

    LIMITATION: a heredoc body is read as commands, not as data, so a `gh workflow run` written
    inside one reads as a call site. The quoted-message defence above is exactly that -- a
    defence for QUOTED text -- and it does not extend to a heredoc. Measured: the real directory
    contains no heredoc in any of its 46 `run:` scalars. Following bash's rule properly needs
    the delimiter tracked through `<<-`, quoting, and arithmetic `<<`, and a mis-read there
    would SKIP tokens, which is the silent direction this whole function is written against.
    """
    file_of_name = {name: filename for filename, name in known.items()}
    doc = yaml.safe_load(path.read_text()) or {}
    targets: set[str] = set()
    for job in (doc.get("jobs") or {}).values():
        for step in job.get("steps") or []:
            if not isinstance(step, dict) or not isinstance(step.get("run"), str):
                continue
            try:
                tokens = _bash_tokens(step["run"])
            except ValueError as exc:
                raise AssertionError(
                    f"{path.name}: a run: scalar cannot be tokenised ({exc}), so nothing can "
                    f"see whether it dispatches a workflow"
                ) from exc
            for i in range(len(tokens) - 2):
                if tokens[i : i + 3] != ["gh", "workflow", "run"]:
                    continue
                # The target is an ARGUMENT OF THIS COMMAND, so the search for it ends where
                # the command does. Reading on into the step is what let an unresolvable
                # dispatch borrow a later command's token and return quietly.
                arguments: list[str] = []
                for token in tokens[i + 3 :]:
                    if _ends_a_command(token) or token == "gh":
                        break
                    arguments.append(token)
                for argument in arguments:
                    if argument in known:
                        targets.add(argument)
                        break
                    if argument in file_of_name:
                        targets.add(file_of_name[argument])
                        break
                else:
                    raise AssertionError(
                        f"{path.name}: `gh workflow run "
                        f"{' '.join(arguments[:3]) or '<nothing>'}` names a target that cannot "
                        f"be resolved to a workflow in {path.parent.name}/. This closure cannot "
                        f"follow it, so it cannot say whether that run is watched. Name the "
                        f"workflow literally in the run: block -- SIGNALLED_DISPATCHES cannot "
                        f"answer this, since it is keyed on a RESOLVED target and is not "
                        f"consulted until after this point, and a cross-repository dispatch "
                        f"has no target in this directory to key on at all"
                    )
    return targets


def _unattended_workflow_names(
    workflows: Path = WORKFLOWS,
    notifier: Path = NOTIFIER,
    signalled: dict[tuple[str, str], str] | None = None,
) -> set[str]:
    """Every workflow name that can run with nobody watching, closed over BOTH ways a run
    starts unattended:

      * a direct `schedule:` trigger;
      * `on.workflow_run` naming a workflow that is itself unattended -- the listener is
        started BY that workflow, so darkness flows target -> listener;
      * `gh workflow run <target>` inside an unattended workflow's `run:` -- the target is
        started BY this workflow, so darkness flows dispatcher -> target, the OPPOSITE
        direction. Running both edges in one direction is the mistake the shared fixed point
        invites.

    image.yml is why the second clause exists, found in the wild: it carries no `schedule:` of
    its own, but one of its three triggers is `workflow_run` on "Warehouse", which IS a daily
    cron. That makes `Warehouse publishes -> Image rebuilds -> Image fails` a chain nobody is
    attending on the days nobody touches this repo. #80 is why the third exists: a closure over
    `workflow_run` edges alone states a property it cannot enforce, since a cron workflow that
    dispatches another starts an unattended run the rule never looks at. A workflow's other,
    attended triggers do not make it attended -- one unattended path is enough to need a
    watcher, the same way `mart_route_health`'s carrier-route grain makes one carrier's
    presence on a route a fact about that carrier, not about the route.

    A dispatch edge listed in `signalled` does not propagate, because the dispatched run
    already carries a human-visible signal; SIGNALLED_DISPATCHES holds why that is keyed on the
    EDGE and not on the target.

    NEVER folds in NOTIFIER. The notifier's own `workflow_run` watches five-plus unattended
    workflows, so if it were a candidate here it would compute itself as unattended and this
    function's caller would then require the notifier to watch itself --
    test_the_notifier_never_watches_itself exists to catch exactly that chain, so this function
    must never let it start: NOTIFIER is excluded from the candidate set below before the fixed
    point runs, not filtered out of the result afterward. It stays in `name_of` so that a
    dispatch naming it still RESOLVES rather than raising.
    """
    signalled = SIGNALLED_DISPATCHES if signalled is None else signalled
    files = sorted(workflows.glob("*.yml"))
    name_of = {p.name: (yaml.safe_load(p.read_text()) or {}).get("name", p.stem) for p in files}
    file_of_name = {name: filename for filename, name in name_of.items()}
    candidates = [p for p in files if p != notifier]
    candidate_files = {p.name for p in candidates}

    unattended = {p.name for p in candidates if "schedule" in (_triggers(p) or {})}
    changed = True
    while changed:
        changed = False
        for p in candidates:
            started_by = {file_of_name[n] for n in _workflow_run_targets(p) if n in file_of_name}
            if p.name not in unattended and started_by & unattended:
                unattended.add(p.name)
                changed = True
            if p.name not in unattended:
                continue
            for target in _dispatch_targets(p, name_of):
                if (p.name, target) in signalled or target not in candidate_files:
                    continue
                if target not in unattended:
                    unattended.add(target)
                    changed = True
    return {name_of[filename] for filename in unattended}


def test_every_scheduled_workflow_in_the_repo_is_watched():
    """The rule, not a snapshot: a workflow that can run with no human in the loop has no human
    attached to it, so it MUST be in the watch list. This is what makes the next scheduled
    workflow somebody adds fail loudly here instead of joining verify.yml in going red at
    nobody -- and, since `_unattended_workflow_names` widened past a literal `schedule:` check,
    the same for a workflow that only inherits its blind spot via `workflow_run` on one (image.yml,
    found unwatched by this same widening: `workflow_run` on "Warehouse", itself a daily cron).

    A workflow starts unattended two ways, and enumerating one of them is a rule that cannot
    see half of what it claims (#80). The closure walks `gh workflow run` edges as well, so a
    cron workflow that dispatches another reddens here unless the dispatched run carries its
    own human-visible signal and that edge is declared in SIGNALLED_DISPATCHES."""
    unattended = _unattended_workflow_names()
    watched = set(_triggers(NOTIFIER).get("workflow_run", {}).get("workflows", []))
    assert unattended <= watched, f"unattended but unwatched: {sorted(unattended - watched)}"


def test_the_notifier_never_watches_itself():
    """A notifier watching itself turns one failure into an unbounded chain of runs, each
    reporting the previous one's failure to report."""
    assert yaml.safe_load(NOTIFIER.read_text())["name"] not in set(
        _triggers(NOTIFIER).get("workflow_run", {}).get("workflows", [])
    )


def test_the_alert_is_filed_only_by_the_notifier():
    """freshness.yml's header argues the general form: an alert that shares a fate with the
    thing it watches is not an alert. A notify step inside verify.yml cannot report verify.yml
    being disabled for repository inactivity, deleted, or failing before the step is reached.

    Asserted as "no other workflow files THIS alert", not as "no other workflow holds
    issues:write" -- warehouse.yml legitimately holds it to file its own drift issues, and
    freshness.yml to file the staleness alert. Writing the wider assertion would have made this
    test red for two correct reasons and taught the next reader to weaken it."""
    assert NOTIFIER.exists()
    for other in sorted(WORKFLOWS.glob("*.yml")):
        if other == NOTIFIER:
            continue
        text = other.read_text()
        assert "scheduled_failure.py" not in text, f"{other.name} files the alert itself"
        assert "scheduled-red" not in text, f"{other.name} uses the alert's dedupe label"


def test_the_nightly_gains_no_permission_from_being_watched():
    """verify.yml has no legitimate issue-filing role, so `issues: write` appearing there is
    the specific regression of folding the notifier into the thing it watches."""
    assert yaml.safe_load((WORKFLOWS / "verify.yml").read_text())["permissions"] == {
        "contents": "read"
    }


def _run_scalars(path: Path) -> list[str]:
    """Every `run:` string in the file. The `${{ }}` layer sits ABOVE YAML and Actions
    substitutes into these scalars before bash ever parses them, so this is the only context
    where an expression becomes source code."""
    doc = yaml.safe_load(path.read_text())
    return [
        step["run"]
        for job in (doc.get("jobs") or {}).values()
        for step in (job.get("steps") or [])
        if isinstance(step, dict) and isinstance(step.get("run"), str)
    ]


def test_no_untrusted_value_is_spliced_into_a_run_scalar():
    """Actions substitutes `${{ }}` into a `run:` scalar BEFORE bash parses it, so a spliced
    value is source code -- in a job holding issues:write. `workflow_run.name` is whatever the
    watched workflow's `name:` says, and the issue title and body are built from it. Same rule
    as warehouse.yml's PREVIOUS_TAG and freshness.yml's ISSUE_BODY.

    Asserted over `run:` scalars rather than over lines, because an expression in a
    `concurrency.group` or an `if:` is a different context entirely and is not a splice."""
    untrusted = (
        "github.event.workflow_run.name",
        "github.event.workflow_run.html_url",
        "github.event.workflow_run.event",
        "github.repository_owner",
        "steps.assess.outputs.issue_title",
        "steps.assess.outputs.issue_body",
    )
    for scalar in _run_scalars(NOTIFIER):
        for expression in untrusted:
            assert expression not in scalar, (
                f"{expression} is spliced into a run: block; it must arrive through env:"
            )


def test_every_untrusted_value_the_script_reads_arrives_through_env():
    """The other half: not spliced is necessary, actually wired is sufficient. A value that
    reaches neither the shell nor `env:` means the script is being handed something else."""
    doc = yaml.safe_load(NOTIFIER.read_text())
    env_values = {
        value
        for job in doc["jobs"].values()
        for step in job["steps"]
        for value in (step.get("env") or {}).values()
    }
    joined = " ".join(str(v) for v in env_values)
    for expression in ("workflow_run.name", "workflow_run.conclusion", "workflow_run.event"):
        assert expression in joined, f"{expression} never reaches the script through env:"


def test_the_yaml_prefilter_and_the_script_agree():
    """The job-level `if:` is a cost control and the script is the decision, so the prefilter
    may never be NARROWER than the allow-list -- a conclusion the script would alert on but the
    `if:` drops is an alert silently lost, with nothing red to show for it. This is what stops
    the two drifting when someone adds a conclusion to one of them."""
    condition = yaml.safe_load(NOTIFIER.read_text())["jobs"]["alert"]["if"]
    for conclusion in ALERTING_CONCLUSIONS:
        assert f"'{conclusion}'" in condition, (
            f"the script alerts on {conclusion} and the job-level if: drops it"
        )


def test_the_file_step_is_gated_on_the_scripts_decision():
    """The dedupe and the event filter both live in the script, so a file step that does not
    read its verdict has silently discarded both."""
    gated = [
        line for line in _notifier_text().splitlines() if "steps.assess.outputs.file_issue" in line
    ]
    assert gated, "the file step lost its gate on the script's verdict"


def test_the_alert_mentions_and_assigns_the_owner():
    """FILING AN ISSUE IS NOT ALERTING A HUMAN. Measured 2026-08-17: the issue #17's
    demonstration filed was authored by github-actions[bot], in a repo the owner was not
    watching, with zero assignees and no `@` anywhere in its body. It notified nobody."""
    text = _notifier_text()
    assert '"@$OWNER"' in text or "@$OWNER" in text
    assert "--add-assignee" in text


def test_the_notifier_takes_no_more_permission_than_it_needs():
    doc = yaml.safe_load(NOTIFIER.read_text())
    assert doc["permissions"] == {"contents": "read", "issues": "write"}


# --------------------------------------------------------------------------------------
# The other half of #61: the nightly must assert the data contract
# --------------------------------------------------------------------------------------


def test_the_nightly_asserts_the_data_contract():
    """Hole 1. `data-contract` lives only in ci.yml, which triggers on pull_request and
    push:main -- so the gate whose whole purpose is catching the upstream dataset moving was
    gated behind a human opening a PR, while the dataset moves on BTS's schedule."""
    text = (WORKFLOWS / "verify.yml").read_text()
    assert "make stats" in text
    assert "pipeline/reference/stats.generated.json" in text


def test_the_nightly_summary_survives_an_earlier_gate_failing():
    """`if: always()` means Summarise runs even when the data contract short-circuited the job,
    and `/tmp/verify.log` legitimately does not exist on those runs -- `make verify` never ran.
    Reading it unguarded made the step fail for a SECOND, misleading reason (`tail: cannot
    open`), turning one clear red into two on a job whose whole value is an unambiguous red.

    Measured on the #61 demonstration run 32106834513 (2026-08-18): the data contract failed as
    intended and `Summarise` then failed too, for an unrelated reason."""
    steps = yaml.safe_load((WORKFLOWS / "verify.yml").read_text())["jobs"]["verify"]["steps"]
    summarise = next(step for step in steps if step.get("name") == "Summarise")
    assert summarise["if"] == "always()"
    assert "/tmp/verify.log" in summarise["run"]
    assert "[ -f /tmp/verify.log ]" in summarise["run"], (
        "Summarise reads the verify log without checking it exists; on any run where an "
        "earlier gate failed first, that fails the step for a second, misleading reason"
    )


def test_the_data_contract_runs_before_the_expensive_proof():
    """An ordering, so it is asserted as an ordering -- CLAUDE.md's rule: when the property is
    a position, assert the position, never the set of things present. `make verify` rebuilds
    the warehouse twice under a 60-minute timeout; running it first means an hour spent proving
    reproducibility against reference values already known to be stale.

    Over PARSED STEPS, not raw text. The first draft compared `text.index(...)` and stayed
    green when the step was moved to the end of the job -- both needles also occur in the
    explanatory comments, so it was asserting an ordering of prose. Found by running the
    mutant, which is the only thing that could have found it."""
    steps = yaml.safe_load((WORKFLOWS / "verify.yml").read_text())["jobs"]["verify"]["steps"]
    runs = [step.get("run") or "" for step in steps]
    contract = next(i for i, r in enumerate(runs) if "make stats" in r)
    proof = next(i for i, r in enumerate(runs) if "make verify" in r)
    assert contract < proof, (
        f"data contract is step {contract}, the 60-minute proof is step {proof}"
    )


# --------------------------------------------------------------------------------------
# The second way a workflow starts unattended (#80)
# --------------------------------------------------------------------------------------

CRON = "  schedule:\n    - cron: '0 4 * * *'"


def _write_workflow(directory: Path, filename: str, name: str, on: str, run: str = "echo hi"):
    """A minimal, parseable workflow, for fixtures the real directory cannot express."""
    directory.mkdir(parents=True, exist_ok=True)
    body = "\n".join("          " + line for line in run.splitlines())
    (directory / filename).write_text(
        f"name: {name}\non:\n{on}\njobs:\n  main:\n    runs-on: ubuntu-latest\n"
        f"    steps:\n      - run: |\n{body}\n"
    )


def test_a_dispatched_workflow_inherits_the_dispatchers_darkness(tmp_path):
    """#80. `gh workflow run` is the SECOND way a workflow starts with nobody in the loop, and
    a closure over `on.workflow_run` edges alone cannot see it: a cron workflow that dispatches
    another creates an unattended run the rule reports as attended.

    Asserted by VARYING THE DISPATCH, never by asserting a set -- CLAUDE.md's rule. The same
    two workflows with the dispatch line removed must NOT report the target, or this passes
    against an implementation that calls everything unattended.
    """
    dark = tmp_path / "dark"
    _write_workflow(dark, "cron.yml", "Cron", CRON, "gh workflow run target.yml --ref main")
    _write_workflow(dark, "target.yml", "Target", "  workflow_dispatch:")
    assert "Target" in _unattended_workflow_names(dark, dark / "none.yml", {})

    lit = tmp_path / "lit"
    _write_workflow(lit, "cron.yml", "Cron", CRON, "echo nothing is dispatched")
    _write_workflow(lit, "target.yml", "Target", "  workflow_dispatch:")
    assert "Target" not in _unattended_workflow_names(lit, lit / "none.yml", {})


def test_the_repos_own_dispatch_edge_is_seen():
    """THE VACUITY GUARD for every fixture test around it. Those build their own workflows, so
    a parser that matches nothing in the REAL directory leaves all of them green while this
    repository's only live dispatch edge stays invisible -- which is #80 unfixed.

    warehouse.yml's bump-pin job reaches the gate through `retry "gh workflow run" gh workflow
    run image-contract.yml \\` and a line continuation, so this is also what proves the
    tokeniser survives the retry wrapper (a quoted label that repeats the command verbatim) and
    the continuation.
    """
    known = {
        p.name: (yaml.safe_load(p.read_text()) or {}).get("name", p.stem)
        for p in sorted(WORKFLOWS.glob("*.yml"))
    }
    assert _dispatch_targets(WORKFLOWS / "warehouse.yml", known) == {"image-contract.yml"}


def test_a_dispatch_from_an_attended_workflow_is_not_an_unattended_path(tmp_path):
    """Darkness flows dispatcher -> target, so it flows only from a dispatcher that is itself
    dark. A PR-triggered workflow dispatching another has that PR's author in the loop, and an
    implementation propagating every dispatch edge regardless of its source would put most of
    this repo in the watch list -- the noise that gets an alert muted, which is the cost
    scheduled-failure.yml's own header argues against."""
    directory = tmp_path / "wf"
    _write_workflow(directory, "onpr.yml", "On PR", "  pull_request:", "gh workflow run t.yml")
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    assert _unattended_workflow_names(directory, directory / "none.yml", {}) == set()


def test_a_signalled_dispatch_does_not_make_its_target_unattended(tmp_path):
    """The false-positive half. `warehouse.yml` dispatches `image-contract.yml` onto a branch
    whose PR is assigned to the owner and @mentions them, so that run is already delivered to a
    human; a closure with no way to say so would force the gate into the watch list and file a
    duplicate `critical` issue for every red bump. Catches the exemption being ignored."""
    directory = tmp_path / "wf"
    _write_workflow(directory, "cron.yml", "Cron", CRON, "gh workflow run t.yml")
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    names = _unattended_workflow_names(
        directory, directory / "none.yml", {("cron.yml", "t.yml"): "signalled on a PR"}
    )
    assert "Target" not in names
    assert "Cron" in names, "the dispatcher's own schedule is unaffected by the exemption"


def test_a_second_undeclared_dispatch_of_a_signalled_target_is_still_caught(tmp_path):
    """THE mutant. `SIGNALLED_DISPATCHES` is keyed on the EDGE; an implementation keyed on the
    TARGET passes every other dispatch test in this file, because no other fixture dispatches
    one target twice. The entry only ever claims "this dispatch carries its own signal", never
    "this workflow is attended" -- so a second dispatcher, with no PR behind it, is exactly the
    next `gh workflow run` edge #80 was written about and must still redden."""
    directory = tmp_path / "wf"
    _write_workflow(directory, "signalled.yml", "Signalled", CRON, "gh workflow run t.yml")
    _write_workflow(directory, "silent.yml", "Silent", CRON, "gh workflow run t.yml")
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    names = _unattended_workflow_names(
        directory, directory / "none.yml", {("signalled.yml", "t.yml"): "signalled on a PR"}
    )
    assert "Target" in names


def test_a_quoted_mention_of_the_command_is_not_a_dispatch(tmp_path):
    """warehouse.yml names `gh workflow run` inside the `--body` of the comment it posts when a
    dispatch FAILED, telling a human to run it by hand. That is a message, not a call site, and
    a scan over the text reads it as an edge and invents a dispatch nothing performs -- the same
    class as this repo's smoke needles matching their own comments. The invented edge would push
    somebody to widen the watch list for a run that never happens."""
    directory = tmp_path / "wf"
    _write_workflow(
        directory,
        "cron.yml",
        "Cron",
        CRON,
        'gh pr comment "$URL" --body "Not dispatched. Run it by hand: '
        'gh workflow run t.yml --ref main"',
    )
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    assert "Target" not in _unattended_workflow_names(directory, directory / "none.yml", {})


def test_a_commented_out_dispatch_is_not_a_dispatch(tmp_path):
    """The accessor choice, asserted rather than only argued in `_bash_code`'s docstring. A `#`
    inside a `run:` block is not a comment to ACTIONS -- `${{ }}` is substituted into the raw
    scalar first, which is `test_workflow_expressions.py`'s rule and the reason the splice
    assertions elsewhere in this repo read the raw form. It is still a comment to BASH, and
    whether bash runs the command is the question this closure asks. Read the raw form here and
    a line nothing executes becomes an unattended path."""
    directory = tmp_path / "wf"
    _write_workflow(directory, "cron.yml", "Cron", CRON, "# gh workflow run t.yml\necho hi")
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    assert "Target" not in _unattended_workflow_names(directory, directory / "none.yml", {})


def test_a_dispatch_target_that_cannot_be_resolved_is_loud(tmp_path):
    """`gh workflow run "$WF"` is a dispatch this closure cannot follow. Skipping it silently
    rebuilds #80's blind spot one level down -- a rule that enumerates only the dispatches it
    happens to understand, and passes for the wrong reason on the rest. The honest outcome is a
    red test naming the call site and asking a human what it starts.

    THE FIXTURE CARRIES A RESOLVABLE TOKEN IN THE NEXT COMMAND, and that is the whole test. The
    first draft's `run:` held the dynamic dispatch alone, so it passed against a scan that ran
    to the end of the STEP rather than the end of the command -- an outcome the holed
    implementation also produces, which is the vacuity CLAUDE.md's mutant rule is about. With
    `t.yml` sitting one line below, a scan that overruns resolves the dispatch to a workflow
    nothing dispatches and returns quietly. The message is asserted not to name `t.yml` for the
    same reason: a fix that raises while still pointing the reader at a token from a different
    command has moved the defect rather than closed it."""
    directory = tmp_path / "wf"
    _write_workflow(
        directory, "cron.yml", "Cron", CRON, 'gh workflow run "$WF" --ref main\necho done t.yml'
    )
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    with pytest.raises(AssertionError, match="cannot be resolved to a workflow") as raised:
        _unattended_workflow_names(directory, directory / "none.yml", {})
    assert "t.yml" not in str(raised.value), (
        "the failure names a token from the NEXT command as the dispatch target"
    )


def test_a_literal_dispatch_later_in_the_step_does_not_resolve_a_dynamic_one(tmp_path):
    """The same overrun, in the shape that hides best: two real dispatches, the first dynamic.
    A scan bounded by the step rather than the command walks out of the unresolvable call site,
    finds the SECOND dispatch's target, and reports one edge where there are two -- no raise,
    and the dynamic dispatch silently attributed to a workflow it never starts. Measured on the
    first draft: `targets=['b.yml']`, no raise."""
    directory = tmp_path / "wf"
    _write_workflow(
        directory, "cron.yml", "Cron", CRON, 'gh workflow run "$WF"\ngh workflow run t.yml'
    )
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    with pytest.raises(AssertionError, match="cannot be resolved to a workflow"):
        _unattended_workflow_names(directory, directory / "none.yml", {})


def test_a_target_is_not_read_across_a_shell_operator(tmp_path):
    """The one-line form of the same boundary. `&&`, `;` and `|` end a simple command exactly
    as a newline does, so an argument of the NEXT command is not an argument of the dispatch --
    and `>` matters most of the four, since a scan that overruns a redirection reads the file
    being written to as the workflow being started."""
    directory = tmp_path / "wf"
    _write_workflow(directory, "cron.yml", "Cron", CRON, 'gh workflow run "$WF" && echo t.yml')
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    with pytest.raises(AssertionError, match="cannot be resolved to a workflow"):
        _unattended_workflow_names(directory, directory / "none.yml", {})


def test_a_second_invocation_does_not_supply_the_first_ones_target(tmp_path):
    """The same overrun with no operator to stop it: one command, two invocations. `retry "gh
    workflow run" gh workflow run ...` already puts two `gh workflow run` mentions inside one
    command in this repo, so the arrangement is not exotic even though this exact fixture is --
    and no real call site provides it, which is why the fixture builds it, the same reason
    `test_dedupe_matches_the_whole_title_not_a_prefix` uses a name pair the repo does not have.
    A second `gh` starts a new invocation, so its arguments are not the first one's."""
    directory = tmp_path / "wf"
    _write_workflow(
        directory, "cron.yml", "Cron", CRON, 'gh workflow run "$WF" gh workflow run t.yml'
    )
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    with pytest.raises(AssertionError, match="cannot be resolved to a workflow"):
        _unattended_workflow_names(directory, directory / "none.yml", {})


def test_a_dispatch_split_across_a_line_continuation_still_resolves(tmp_path):
    """The other half of making the newline a boundary: a `\\`-continuation is bash JOINING two
    lines into one command, the opposite of the bare newline beside it, and `shlex` resolves the
    escape into a token byte-identical to the one a bare newline produces. Treating that token
    as a boundary would redden a dispatch that names its target perfectly well, one line down --
    a gate red for a reason the message it prints cannot explain. warehouse.yml continues AFTER
    its target, so only a fixture continuing BEFORE one can fail this way."""
    directory = tmp_path / "wf"
    _write_workflow(directory, "cron.yml", "Cron", CRON, "gh workflow run \\\n  t.yml --ref main")
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    assert "Target" in _unattended_workflow_names(directory, directory / "none.yml", {})


def test_a_trailing_comment_does_not_break_tokenisation(tmp_path):
    """Comments are stripped by the tokeniser, which knows what is quoted, and not by a
    line-level filter, which does not. A whole-line filter leaves a TRAILING `#` in place, so an
    apostrophe in one -- `# don't` -- makes the scalar untokenisable and reds this gate with a
    message about a dispatch scan on a step that has nothing to do with dispatching. Measured on
    the real directory: 5 of 46 `run:` scalars do not tokenise raw, and 0 do not tokenise once
    the tokeniser owns comments.

    warehouse.yml's `classify` step embeds inline Python in a double-quoted string, so this is
    the shape a `#` is most likely to arrive in next."""
    directory = tmp_path / "wf"
    _write_workflow(
        directory, "cron.yml", "Cron", CRON, "echo hi  # don't tokenise me\ngh workflow run t.yml"
    )
    _write_workflow(directory, "t.yml", "Target", "  workflow_dispatch:")
    assert "Target" in _unattended_workflow_names(directory, directory / "none.yml", {})


# --------------------------------------------------------------------------------------
# The `workflow_run` edge, which the same fixed point walks in the OPPOSITE direction
# --------------------------------------------------------------------------------------


def test_a_workflow_run_listener_inherits_the_watched_workflows_darkness(tmp_path):
    """The clause `image.yml` is the live case for, and it had no test of its own. The rule test
    asserts `unattended <= watched` -- a SUBSET -- so dropping a name from `unattended` can never
    fail it, and nothing pinned `Image` INTO the watch list. Measured: deleting this clause left
    all 705 tests green.

    Asserted by VARYING THE EDGE, never by asserting a set: the same two workflows with the
    `workflow_run` trigger replaced by a `workflow_dispatch` one must NOT report the listener,
    or this passes against an implementation that calls every workflow unattended."""
    dark = tmp_path / "dark"
    _write_workflow(dark, "cron.yml", "Cron", CRON)
    _write_workflow(dark, "listener.yml", "Listener", '  workflow_run:\n    workflows: ["Cron"]')
    assert "Listener" in _unattended_workflow_names(dark, dark / "none.yml", {})

    lit = tmp_path / "lit"
    _write_workflow(lit, "cron.yml", "Cron", CRON)
    _write_workflow(lit, "listener.yml", "Listener", "  workflow_dispatch:")
    assert "Listener" not in _unattended_workflow_names(lit, lit / "none.yml", {})


def test_workflow_run_darkness_flows_to_the_listener_and_never_back(tmp_path):
    """THE direction mutant, and the reason it needs a fixture of its own. A `workflow_run`
    listener is started BY the workflow it names, so darkness flows target -> listener; the
    dispatch edge beside it in the same fixed point flows the other way, which is exactly the
    invitation to collapse both into one direction. Reversed, this clause makes a workflow
    unattended because something unattended WATCHES it -- but being watched starts no run at
    all, so nothing about the watcher's schedule reaches it.

    The fixture separates them by giving the LISTENER the cron and the watched workflow none.
    Read correctly nothing propagates; reversed, `Plain` is dragged in. Measured: reversing the
    clause left all 705 tests green, because every other fixture here puts the cron on the
    watched side, where both directions agree on the answer."""
    directory = tmp_path / "wf"
    _write_workflow(directory, "plain.yml", "Plain", "  workflow_dispatch:")
    _write_workflow(
        directory, "watcher.yml", "Watcher", f'{CRON}\n  workflow_run:\n    workflows: ["Plain"]'
    )
    names = _unattended_workflow_names(directory, directory / "none.yml", {})
    assert names == {"Watcher"}, "being watched is not being started; darkness flows the other way"


def test_the_repos_own_workflow_run_edge_is_seen():
    """THE VACUITY GUARD over the two fixture tests above, the same role
    `test_the_repos_own_dispatch_edge_is_seen` plays for the dispatch half. Both build their own
    workflows, so a clause that reads nothing from the REAL directory leaves them green while
    the edge this rule was widened for stays invisible.

    `image.yml` is that edge: no `schedule:` of its own, one of its three triggers a
    `workflow_run` on "Warehouse", itself a daily cron -- so `Warehouse publishes -> Image
    rebuilds -> Image fails` is a chain nobody attends on a day nobody touches this repo.
    Nothing else reaches `Image`; no workflow dispatches it."""
    assert "Image" in _unattended_workflow_names(), (
        "image.yml inherits Warehouse's cron through `workflow_run` and the closure lost it"
    )


def test_every_signalled_dispatch_still_exists():
    """The exemption list is a rule, not a snapshot. An entry outliving the dispatch it excuses
    is a standing licence nobody re-derived, and it silently covers the next edge added between
    the same two files. Asserted against the dispatch actually present in the workflow, never
    against the files merely existing."""
    known = {
        p.name: (yaml.safe_load(p.read_text()) or {}).get("name", p.stem)
        for p in sorted(WORKFLOWS.glob("*.yml"))
    }
    for (dispatcher, target), reason in SIGNALLED_DISPATCHES.items():
        assert (WORKFLOWS / dispatcher).exists(), f"{dispatcher} no longer exists"
        assert target in _dispatch_targets(WORKFLOWS / dispatcher, known), (
            f"{dispatcher} no longer dispatches {target}; the exemption outlived its edge"
        )
        assert reason.strip(), f"{dispatcher} -> {target} is exempt with no reason written down"
