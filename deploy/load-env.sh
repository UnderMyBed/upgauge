#!/usr/bin/env bash
# Sourced -- never executed -- by provision.sh and cloudflare-apply.sh, before their
# `: "${VAR:?}"` guards run. Fills in the five operator credentials from `deploy/.env`, the
# gitignored file whose committed template is `deploy/.env.example`.
#
# THE ENVIRONMENT WINS. A variable already set is left exactly as it is, matching docker
# compose and dotenv. The reverse would make `CLOUDFLARE_API_TOKEN=$rotated make
# cloudflare-apply` apply with the stale token still sitting in .env -- a rotation that
# reports success and changed nothing. An absent file is not an error: both scripts are
# usable with values passed inline, and their own `:?` guards give the better message about
# what is missing.

_env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env"
if [ -f "$_env_file" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in '' | '#'*) continue ;; esac
    case "$_line" in *=*) ;; *) continue ;; esac
    _key="${_line%%=*}"
    _key="${_key#export }"
    _key="${_key# }"
    _key="${_key%% }"
    # Anything not shell-identifier-shaped is a typo, not a variable; exporting it would
    # abort a sourced script under `set -e` with a bash usage error and no useful context.
    case "$_key" in [A-Za-z_]*) ;; *) continue ;; esac
    case "$_key" in *[!A-Za-z0-9_]*) continue ;; esac
    _val="${_line#*=}"
    # Strip one matched pair of surrounding quotes, so both KEY=v and KEY="v" work.
    case "$_val" in
      '"'*'"') _val="${_val#\"}" ; _val="${_val%\"}" ;;
      "'"*"'") _val="${_val#\'}" ; _val="${_val%\'}" ;;
    esac
    if [ -z "${!_key:-}" ]; then
      export "$_key=$_val"
    fi
  done < "$_env_file"
fi
unset _env_file _line _key _val
