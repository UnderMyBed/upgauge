"""`.github/scripts/gh_retry.sh`, exercised rather than read.

Every network call in `warehouse.yml`'s `bump-pin` job goes through this file, and the retry is
the named mitigation for that job being able to redden a Warehouse run whose release is fine --
which also defers `image.yml`'s build, since it gates on that workflow's conclusion.

WHY BEHAVIOURAL AND NOT STRUCTURAL. The workflow-layer tests used to cover part of this: they
asserted `--state open` appeared in the early exit and that `git ls-remote` was handled. When the
calls moved behind these functions, those assertions were rewritten to name the functions instead
-- and the coverage left with the code. Five mutants inside this file then survived the entire
suite, including `2) return 1` -> `*) return 1`, which is the exact transport-failure misread the
file's own docstring exists to prevent, and `--state open` -> `--state all`, which would make a
CLOSED bump PR suppress every future bump forever.

So: a real local bare remote for `branch_exists`, and a stub `gh` on PATH for the rest. `sleep` is
stubbed too -- the real backoff is 5/10/15/20s and these tests must not pay it.
"""

from __future__ import annotations

import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

HELPER = Path(__file__).parents[2] / ".github" / "scripts" / "gh_retry.sh"


def _stub(directory: Path, name: str, body: str) -> Path:
    """Put an executable stub on PATH."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text("#!/usr/bin/env bash\n" + textwrap.dedent(body))
    path.chmod(0o755)
    return path


def _run(
    script: str, tmp_path: Path, cwd: Path | None = None, **env
) -> subprocess.CompletedProcess:
    """Source the helper and run `script` with the stub directory first on PATH."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    # Never sleep the real backoff. `retry` calls `sleep` as a command, so a stub is enough.
    _stub(bin_dir, "sleep", 'echo "slept $1" >> "$SLEEP_LOG"\n')
    environment = {
        "PATH": f"{bin_dir}:{shutil.os.environ['PATH']}",
        "SLEEP_LOG": str(tmp_path / "sleeps"),
        "GITHUB_REPOSITORY": "UnderMyBed/upguage",
        "HOME": str(tmp_path),
        **env,
    }
    (tmp_path / "sleeps").touch()
    return subprocess.run(
        ["bash", "-c", f"set -euo pipefail\nsource {HELPER}\n{script}"],
        capture_output=True,
        text=True,
        cwd=str(cwd or tmp_path),
        env=environment,
    )


def _sleeps(tmp_path: Path) -> list[str]:
    return (tmp_path / "sleeps").read_text().split()[1::2]


# --------------------------------------------------------------------------------------
# retry
# --------------------------------------------------------------------------------------


def test_retry_returns_the_commands_stdout_to_the_caller(tmp_path):
    """`url=$(retry gh pr create …)` is a real call site, so the wrapper must be transparent."""
    _stub(tmp_path / "bin", "flaky", 'echo "https://example/pull/1"\n')
    result = _run('out=$(retry "flaky" flaky); echo "captured=$out"', tmp_path)
    assert "captured=https://example/pull/1" in result.stdout


def test_retry_diagnostics_never_reach_stdout(tmp_path):
    """They would end up INSIDE the captured URL. This is why the helper writes to stderr."""
    _stub(
        tmp_path / "bin",
        "flaky",
        'if [ -f "$PWD/once" ]; then echo ok; else touch "$PWD/once"; exit 1; fi\n',
    )
    result = _run('out=$(retry "flaky" flaky); echo "captured=[$out]"', tmp_path)
    assert "captured=[ok]" in result.stdout
    assert "::warning::" in result.stderr


def test_retry_makes_exactly_five_attempts_before_giving_up(tmp_path):
    """`for attempt in 1` leaves every call site nominally retried and actually not."""
    _stub(tmp_path / "bin", "always_fails", 'echo attempt >> "$PWD/log"; exit 1\n')
    result = _run('retry "always_fails" always_fails || echo "gave up"', tmp_path)
    assert "gave up" in result.stdout
    assert (tmp_path / "log").read_text().split().count("attempt") == 5


def test_retry_does_not_sleep_after_its_final_attempt(tmp_path):
    """Four sleeps for five attempts. Waiting 25s to then give up is pure latency on a job that
    has already failed -- and the worst case runs this six times in one step."""
    _stub(tmp_path / "bin", "always_fails", "exit 1\n")
    _run('retry "always_fails" always_fails || true', tmp_path)
    assert _sleeps(tmp_path) == ["5", "10", "15", "20"]


def test_retry_never_emits_an_error_annotation(tmp_path):
    """Two call sites RECOVER from a failure here -- an optional stale-PR listing, and a
    `gh pr create` whose PR turns out to exist anyway. An `::error::` from the wrapper puts a red
    annotation on a step that then exits 0. The caller emits the error when it means one."""
    _stub(tmp_path / "bin", "always_fails", "exit 1\n")
    result = _run('retry "always_fails" always_fails || true', tmp_path)
    assert "::error::" not in result.stderr + result.stdout
    assert "::warning::always_fails failed after 5 attempts" in result.stderr


# --------------------------------------------------------------------------------------
# branch_exists -- against a real remote, because the exit codes are the whole point
# --------------------------------------------------------------------------------------


@pytest.fixture
def repo_with_remote(tmp_path):
    """A real working repo whose `origin` is a real bare repo carrying one branch."""
    bare, work = tmp_path / "bare.git", tmp_path / "work"
    subprocess.run(["git", "init", "--bare", "-q", str(bare)], check=True)
    subprocess.run(["git", "init", "-q", str(work)], check=True)
    git = ["git", "-C", str(work), "-c", "user.email=t@t", "-c", "user.name=t"]
    (work / "f").write_text("x")
    subprocess.run([*git, "add", "f"], check=True)
    subprocess.run([*git, "commit", "-qm", "init"], check=True)
    subprocess.run([*git, "branch", "-M", "present"], check=True)
    subprocess.run([*git, "remote", "add", "origin", str(bare)], check=True)
    subprocess.run([*git, "push", "-q", "origin", "present"], check=True)
    return work


def test_branch_exists_is_true_for_a_branch_on_the_remote(repo_with_remote, tmp_path):
    result = _run(
        "if branch_exists present; then echo YES; else echo NO; fi", tmp_path, cwd=repo_with_remote
    )
    assert "YES" in result.stdout


def test_branch_exists_is_false_for_an_absent_branch(repo_with_remote, tmp_path):
    """git's documented exit 2, "no matching refs" -- a legitimate answer, never an error."""
    result = _run(
        "if branch_exists nope; then echo YES; else echo NO; fi", tmp_path, cwd=repo_with_remote
    )
    assert "NO" in result.stdout
    assert result.returncode == 0


def test_a_transport_failure_is_never_reported_as_an_absent_branch(repo_with_remote, tmp_path):
    """THE mutant this function exists for. `git ls-remote --exit-code` returns 2 for absent and
    128 for a transport failure, and `if git ls-remote …; then` collapses both to absent -- after
    which the caller creates a branch that already exists and fails non-fast-forward, several
    steps from the cause. Measured against an unreachable remote: 128."""
    subprocess.run(
        [
            "git",
            "-C",
            str(repo_with_remote),
            "remote",
            "set-url",
            "origin",
            "https://invalid.invalid/x.git",
        ],
        check=True,
    )
    result = _run(
        "if branch_exists present; then echo YES; else echo NO; fi", tmp_path, cwd=repo_with_remote
    )
    assert result.returncode != 0, "a transport failure was swallowed as an answer"
    assert "NO" not in result.stdout, "a transport failure was reported as 'branch absent'"
    assert "refusing to guess" in result.stderr


def test_branch_exists_retries_a_transport_failure_before_giving_up(repo_with_remote, tmp_path):
    subprocess.run(
        [
            "git",
            "-C",
            str(repo_with_remote),
            "remote",
            "set-url",
            "origin",
            "https://invalid.invalid/x.git",
        ],
        check=True,
    )
    _run("branch_exists present || true", tmp_path, cwd=repo_with_remote)
    assert _sleeps(tmp_path) == ["5", "10", "15", "20"]


# --------------------------------------------------------------------------------------
# open_pr_for / closed_pr_for
# --------------------------------------------------------------------------------------


def _gh_recording(tmp_path, output: str = "", fail_times: int = 0) -> None:
    _stub(
        tmp_path / "bin",
        "gh",
        f'''
        printf '%s\\n' "$*" >> "$PWD/gh-args"
        n=$(wc -l < "$PWD/gh-args")
        if [ "$n" -le {fail_times} ]; then exit 1; fi
        printf '%s' "{output}"
    ''',
    )


def test_open_pr_for_asks_only_about_open_prs_on_that_branch(tmp_path):
    """Both flags are load-bearing. `--state all` lets a CLOSED bump PR satisfy the caller's
    early exit forever, so the pin never moves again; without `--head`, any open PR in the
    repository does."""
    _gh_recording(tmp_path)
    _run('open_pr_for "bot/warehouse-pin-warehouse-2026.06" >/dev/null', tmp_path)
    args = (tmp_path / "gh-args").read_text()
    assert "--state open" in args
    assert "--head bot/warehouse-pin-warehouse-2026.06" in args
    assert "--state all" not in args


def test_closed_pr_for_asks_only_about_closed_prs_on_that_branch(tmp_path):
    _gh_recording(tmp_path)
    _run('closed_pr_for "bot/warehouse-pin-warehouse-2026.06" >/dev/null', tmp_path)
    args = (tmp_path / "gh-args").read_text()
    assert "--state closed" in args
    assert "--head bot/warehouse-pin-warehouse-2026.06" in args


def test_the_pr_listings_are_retried(tmp_path):
    """`gh pr list` is the FIRST network call on every real bump, and the one that shipped
    un-retried while two comments and a doc said otherwise."""
    _gh_recording(tmp_path, output="https://example/pull/7", fail_times=2)
    result = _run('out=$(open_pr_for br); echo "captured=$out"', tmp_path)
    assert "captured=https://example/pull/7" in result.stdout
    assert len((tmp_path / "gh-args").read_text().splitlines()) == 3


def test_an_empty_listing_is_an_answer_and_is_not_retried(tmp_path):
    """No open PR is the NORMAL case -- it is what lets the bot proceed to open one. Retrying it
    as a failure would add 50s of backoff to every successful bump."""
    _gh_recording(tmp_path, output="")
    result = _run('out=$(open_pr_for br); echo "captured=[$out]"', tmp_path)
    assert "captured=[]" in result.stdout
    assert len((tmp_path / "gh-args").read_text().splitlines()) == 1
    assert _sleeps(tmp_path) == []


def test_branch_exists_still_works_when_called_outside_an_if(repo_with_remote, tmp_path):
    """The `if/else` wrapper around the `git ls-remote` call, not its `case`, is what makes this
    function correct anywhere.

    A bare `git ls-remote …` followed by `rc=$?` cannot work under `set -e`: the shell exits AT
    the failing command and never reaches the assignment, so the retry loop and the whole
    exit-code mapping are dead code -- and the caller gets a bare exit 128 with no diagnostic at
    all. Inside an `if` condition `set -e` is suppressed, so both forms behave identically and
    the defect is invisible; today's single call site is an `if`, which is exactly how this
    would stay latent until someone added a second one.
    """
    subprocess.run(
        [
            "git",
            "-C",
            str(repo_with_remote),
            "remote",
            "set-url",
            "origin",
            "https://invalid.invalid/x.git",
        ],
        check=True,
    )
    result = _run("branch_exists present\necho unreachable", tmp_path, cwd=repo_with_remote)
    assert "unreachable" not in result.stdout
    assert "refusing to guess" in result.stderr, (
        "called bare, the function died inside git ls-remote -- it never retried and never "
        "reported why"
    )
