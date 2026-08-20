# shellcheck shell=bash
# Retry helpers for warehouse.yml's `bump-pin` job. Sourced, never executed.
#
# ONE IMPLEMENTATION, for the reason gha.py's docstring gives about its own delimiter rule: the
# retry is load-bearing (it is the named mitigation for this job being able to redden a run that
# image.yml gates its build on), and three hand-copied loops is one implementation plus two
# places for it to be missing. It was: `gh pr create` and `gh workflow run` had loops and
# `gh pr list` -- the FIRST network call on every real bump -- had none, while two comments and
# a doc claimed "every gh call is retried".
#
# Diagnostics go to STDERR, deliberately. `url=$(retry gh pr create …)` captures stdout, so a
# `::warning::` written there would end up inside the URL.

#: Run a command until it succeeds, five attempts, 5/10/15/20s backoff. No sleep after the last
#: attempt -- waiting 25s to then give up is pure latency on a job that has already failed.
retry() { # retry <label> <command...>
  local label="$1"
  shift
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then
      return 0
    fi
    [ "$attempt" -eq 5 ] && break
    echo "::warning::${label} failed (attempt ${attempt} of 5); retrying" >&2
    sleep $((attempt * 5))
  done
  echo "::error::${label} failed after 5 attempts" >&2
  return 1
}

#: Does the branch exist on the remote? 0 yes, 1 no, and a HARD EXIT on anything else.
#:
#: `git ls-remote --exit-code` returns 2 for "no matching refs" and 128 for a transport failure,
#: and the obvious `if git ls-remote …; then` collapses both to "absent" -- measured: 128 against
#: an unreachable remote, read as absent. That misread is worse than an error, because the caller
#: then tries to create a branch that already exists and fails non-fast-forward, several steps
#: away from the cause.
branch_exists() { # branch_exists <branch>
  local branch="$1" attempt rc
  for attempt in 1 2 3 4 5; do
    git ls-remote --exit-code --heads origin "refs/heads/${branch}" >/dev/null 2>&1
    rc=$?
    case "$rc" in
      0) return 0 ;;
      2) return 1 ;;
    esac
    [ "$attempt" -eq 5 ] && break
    echo "::warning::git ls-remote failed (exit ${rc}, attempt ${attempt} of 5); retrying" >&2
    sleep $((attempt * 5))
  done
  echo "::error::could not determine whether ${branch} exists -- refusing to guess" >&2
  exit 1
}

#: The URL of the open PR for a branch, or empty. Separated from `retry` because an empty result
#: is a legitimate answer here and must not be retried as a failure.
open_pr_for() { # open_pr_for <branch>
  retry "gh pr list" gh pr list --repo "$GITHUB_REPOSITORY" --head "$1" \
    --state open --json url --jq '.[0].url // ""'
}
