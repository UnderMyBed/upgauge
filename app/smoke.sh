#!/usr/bin/env bash
# The gate for production-only bugs. Every unit test in this repo passes through a mocked or
# hand-built request; none of them cross Next's URL normalization, its bundler, or its route
# segment config. Five bugs on the M3b branch had exactly that shape -- green tests, broken
# production:
#
#   1. __dirname resolving to "/" under Turbopack
#   2. decodeURIComponent throwing on a malformed escape
#   3. process.chdir() unavailable in a worker thread
#   4. the DuckDB platform-switch require() failing the build
#   5. Next form-encoding the query string, breaking EVERY filtered query on BOTH entry
#      points (`malformed filter 'origin_state%3AOR'`) -- found only by curling a real server
#
# So this builds, serves, and curls. It asserts on status, headers and body substrings.
#
# MEMORY: this box has 8 GB against 12 cores with zram-only swap, and a `next build` plus a
# server plus a desktop is close to the ceiling. Both heavy steps run inside a MemoryMax
# cgroup scope so a regression here degrades this script instead of wedging the machine.
set -uo pipefail

PORT="${SMOKE_PORT:-3199}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The gate must serve from the PINNED next, not whatever `npx` resolves. Running `next start
# app` via npx from $ROOT cannot resolve app/node_modules (no root node_modules, no root
# package.json) -- traced 2026-08-09, it resolved ~/.npm/_npx/8b377f6eec906bc4/node_modules/next,
# a cached download that happened to match the pin. On a cold cache npx fetches next@latest. A
# gate serving a different Next than the build under test certifies nothing.
NEXT_BIN="${ROOT}/app/node_modules/.bin/next"
if [ ! -x "$NEXT_BIN" ]; then
  echo "  FAIL ${NEXT_BIN} is missing or not executable. Run 'make install' first."
  exit 1
fi
# Through `mise exec --`, like every other runtime call in this file -- a bare `node` is not
# guaranteed on $PATH (a fresh clone before `mise activate`, a cron shell, `make app-smoke`'s
# own invocation below, which calls this script directly rather than through `$(MISE)`).
#
# Fix round 1: the first version of this guard called bare `node -p ...` with `set -uo
# pipefail` (no `-e`), and command substitution never propagates a child's exit status into
# `$?` for an `if`, only its stdout. If `node` is unresolvable, BOTH substitutions silently
# yield "" and "" != "" is false -- the mismatch check never fires, `==> next  ()` prints, and
# the whole suite runs "certified" having verified nothing. Reproduced:
#   $ bash -c 'set -uo pipefail; X=$(nonexistent -p a); Y=$(nonexistent -p b); [ "$X" != "$Y" ] && echo MISMATCH || echo EQUAL-PASSES-SILENTLY'
#   EQUAL-PASSES-SILENTLY
# So an explicit non-empty check on EACH value, before the comparison, is not optional --
# routing through `mise exec --` narrows WHEN node is missing, it does not stop the silent-pass
# shape if it still is.
PINNED_NEXT=$(mise exec -- node -p "require('${ROOT}/app/node_modules/next/package.json').version")
DECLARED_NEXT=$(mise exec -- node -p "require('${ROOT}/app/package.json').dependencies.next")
if [ -z "$PINNED_NEXT" ] || [ -z "$DECLARED_NEXT" ]; then
  echo "  FAIL could not determine the next version (installed='${PINNED_NEXT}' declared='${DECLARED_NEXT}')."
  echo "       node/mise is unresolvable or a package.json is unreadable -- the guard could NOT"
  echo "       run, this is not a report that the versions matched."
  exit 1
fi
if [ "$PINNED_NEXT" != "$DECLARED_NEXT" ]; then
  echo "  FAIL installed next ${PINNED_NEXT} != declared ${DECLARED_NEXT} in app/package.json."
  echo "       Every check below would run against a Next this repo does not pin."
  exit 1
fi
echo "==> next ${PINNED_NEXT} (${NEXT_BIN})"

# One serve path for all four servers this script starts, so the pinned binary cannot be
# reintroduced as npx in one site and missed in the others.
#
# `cap` (below) is a SHELL FUNCTION, not a binary, so it cannot follow `env` -- `env NAME=val
# cap ...` execs "cap" via PATH lookup and fails (`env: 'cap': No such file or directory`,
# verified). `env`'s VAR=value args go inside cap's OWN forwarded command instead, immediately
# before `mise` (a real binary): `cap 2G env "$@" mise exec -- ...`. The plain assignment form
# the four call sites used before this (`UPGAUGE_DB="$BROKEN_DB" cap 2G mise exec -- ...`)
# cannot be reused as-is here either -- that form is parsed at PARSE TIME as a prefix on the
# literal word `cap`, but this function receives its assignments as already-expanded strings in
# "$@", and bash does not re-parse an expanded string as an assignment prefix (verified: `set --
# FOO=bar; "$@" printenv FOO` fails with "FOO=bar: command not found", not a set variable) --
# only the real `env` binary can turn a runtime string into a child's environment.
serve_next() { # serve_next <port> <logfile> [VAR=value ...]
  local port="$1" log="$2"; shift 2
  cap 2G env "$@" mise exec -- "$NEXT_BIN" start app -p "$port" >"$log" 2>&1 &
}

SMOKE_MODE="${SMOKE_MODE:-host}"
SMOKE_IMAGE="${SMOKE_IMAGE:-upgauge:local}"

# Container mode keeps port_free_or_die AND adds what it cannot express. The guard proves
# "I started this server"; the identity assertion proves "it is the build under test". Two
# independent guards, because the orphan incident (kill_port's own comment, below) got through
# the only one that existed, and in container mode a container is SUPPOSED to hold the port --
# so the guard alone would be watching for exactly the thing that is now correct.
start_container() { # start_container <port>
  port_free_or_die "$1"
  # `|| exit` is not belt-and-braces: `set -e` is off, so an unchecked `docker run` failure falls
  # straight through to the readiness loop, which burns 90 s and then dumps `docker logs
  # upgauge-smoke` -- from the container that ALREADY held that name, i.e. it points the diagnosis
  # at the previous run's build. The name collision is the case the port guard cannot see: a stale
  # container not publishing $1 leaves the port free, so port_free_or_die passes. All three
  # `docker run`s in `make portability` carry this guard; this one was the omission.
  docker run -d --rm --name upgauge-smoke --read-only \
    -p "127.0.0.1:${1}:3000" "$SMOKE_IMAGE" >/dev/null || {
    echo "  FAIL docker run could not start upgauge-smoke -- NOTHING is under test."
    echo "       Most likely a container of that name already exists (\`docker rm -f"
    echo "       upgauge-smoke\`), the image ${SMOKE_IMAGE} is missing, or the daemon is down."
    exit 1
  }
}

assert_identity() { # assert_identity <base-url>
  local body sha tag
  body=$(curl -s --max-time 10 "${1}/api/health")
  # `mise exec -- node`, never bare `node`: this script is invoked as ./app/smoke.sh and does
  # NOT go through $(MISE), so nothing guarantees a mise-activated shell. And the empty checks
  # below are not belt-and-braces -- `set -e` is off and command substitution never propagates
  # the child's status, so an absent node yields "" for both values. Task 1 shipped this exact
  # bug: `"" != ""` is false, so the guard printed a blank version and certified the whole suite
  # having verified nothing. A guard whose failure mode is silently-green is the one thing this
  # file cannot contain.
  sha=$(printf '%s' "$body" | mise exec -- node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).build.sha")
  tag=$(printf '%s' "$body" | mise exec -- node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).build.warehouse")
  if [ -z "$sha" ] || [ -z "$tag" ]; then
    echo "  FAIL could not read build identity from ${1}/api/health -- the assertion did not run."
    echo "       Body was: ${body:-<empty>}"
    exit 1
  fi
  if [ -n "${SMOKE_EXPECT_SHA:-}" ] && [ "$sha" != "$SMOKE_EXPECT_SHA" ]; then
    echo "  FAIL the server on this port reports build ${sha}, expected ${SMOKE_EXPECT_SHA}."
    echo "       Every check below would pass against a build that is not under test."
    exit 1
  fi
  if [ -n "${SMOKE_EXPECT_WAREHOUSE:-}" ] && [ "$tag" != "$SMOKE_EXPECT_WAREHOUSE" ]; then
    echo "  FAIL the server reports warehouse ${tag}, expected ${SMOKE_EXPECT_WAREHOUSE}."
    exit 1
  fi
  echo "==> serving build ${sha}, warehouse ${tag}"
}

BASE="http://127.0.0.1:${PORT}"
CACHE_EXPECTED="public, s-maxage=2592000, stale-while-revalidate=86400"
# M5 Task 7, Part B split proxy.ts's one 30-day CACHE constant into two: /api/pivot (its own
# route.ts, untouched) and, as of M5 Task 8, /sitemap.xml and /robots.txt keep CACHE_EXPECTED
# above; /explore and all four entity pages (/route, /airport, /carrier, /aircraft) -- both
# their 200s and their 308s -- get the shorter HTML_CACHE instead (docs/architecture/hosting.md
# § "The gap": bounding a 5xx's cache exposure to an hour rather than a month, since the
# route-handler fix that would have closed the gap outright turned out not to be reachable).
#
# This file's own checks did NOT move when proxy.ts's constant did -- Task 7 touched proxy.ts
# and proxy.test.ts but not this file, so every HTML-page Cache-Control check below was
# asserting the WRONG (stale, 30-day) value against a served build that actually returns the
# 1-hour one, which is exactly the "green tests, broken production" shape this file exists to
# prevent, just inverted (a RED check for a correct header, not a green one for a broken one).
# M5 Task 8 is the fix: CACHE_EXPECTED stays the literal /api/pivot, /sitemap.xml and
# /robots.txt use; HTML_CACHE_EXPECTED is the new one for /explore and the four entity pages.
HTML_CACHE_EXPECTED="public, s-maxage=3600, stale-while-revalidate=86400"
FAILED=0

cap() { # run under a memory cap when systemd-run is available, plainly otherwise
  if command -v systemd-run >/dev/null 2>&1; then
    systemd-run --user --scope -q -p MemoryMax="$1" -p MemorySwapMax=512M --unit="upg-smoke-$$-$RANDOM" "${@:2}"
  else
    "${@:2}"
  fi
}

# NEVER `grep -q` in these helpers, and never take the -q back.
#
# `set -o pipefail` is on (it has to be: these pipelines start with a curl whose failure must
# not be swallowed). `grep -q` exits the instant it matches -- so on any body larger than the
# 64 KB pipe buffer, the `printf` still feeding it dies of SIGPIPE and the PIPELINE's status is
# 141 even though the needle was found. `check` then reports a false FAIL, and -- far worse --
# `check_not` reports a silent false **ok** for a needle that IS present, because 141 sends it
# down the else branch. A gate that passes for the wrong reason is exactly what this file
# exists to prevent.
#
# Latent since M3b and invisible while every response stayed under 64 KB. Mounting the M4c
# chart took /route/JFK-LAX from 32,087 to 96,112 bytes and it fired immediately: measured on
# the served build, needles at byte offsets 1,489 and 2,723 returned 141 while identical
# lookups for needles at 6,773 and beyond returned 0 -- i.e. the results depended on WHERE in
# the page the string sat. Without -q, grep reads its input to the end, so printf always
# completes and the status is grep's own. stdout goes to /dev/null because these bodies are one
# enormous line.
has()     { printf '%s' "$1" | grep -F  -- "$2" >/dev/null; }
has_re()  { printf '%s' "$1" | grep -E  -- "$2" >/dev/null; }
# How many times a fixed string occurs in a body. Same no-`-q` discipline: `grep -o` reads to
# EOF and `wc` drains it, so printf always completes. Used where PRESENCE is not the claim --
# a band drawn in two pieces and a band drawn in one both contain the needle.
count()   { printf '%s' "$1" | grep -oF -- "$2" | wc -l | tr -d ' '; }

# Isolates one region of a single-line body -- every curl body in this file is one line, so
# this is bash's own shortest-match parameter expansion, not sed or awk. `#*"$2"` strips the
# SHORTEST prefix ending in the FIRST occurrence of the start marker; `%%"$3"*` then strips the
# LONGEST suffix starting from the FIRST occurrence of the end marker that follows it (longest
# removal finds the leftmost match, which is the nearest end marker, not the last one). Needed
# for M6's Gauge Watch section: its two tables (Upgauging / Downgauging) sort oppositely and
# share a row shape, so a needle asserted against the WHOLE body proves nothing about which
# table it is actually in -- the exact "either half alone is vacuous" trap this file's Gauge
# Watch checks below exist to avoid. Every marker used with this is the served HTML's FIRST
# occurrence of that string; the RSC flight payload repeats it further down the same body, but
# `#*"$2"` and `%%"$3"*` both resolve to the nearest, not the last, occurrence.
between() { # between <haystack> <start-marker> <end-marker>
  local rest="${1#*"$2"}"
  printf '%s' "${rest%%"$3"*}"
}

check() { # check <name> <haystack> <needle>
  if has "$2" "$3"; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n       expected to find: %s\n       got: %.300s\n' "$1" "$3" "$2"
    FAILED=1
  fi
}

check_not() {
  if has "$2" "$3"; then
    printf '  FAIL %s\n       expected NOT to find: %s\n' "$1" "$3"
    FAILED=1
  else
    printf '  ok   %s\n' "$1"
  fi
}

check_re() {   # check_re <name> <haystack> <extended-regex>
  if has_re "$2" "$3"; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n       expected to match: %s\n       got: %.300s\n' "$1" "$3" "$2"
    FAILED=1
  fi
}

check_not_re() {
  if has_re "$2" "$3"; then
    printf '  FAIL %s\n       expected NOT to match: %s\n' "$1" "$3"
    FAILED=1
  else
    printf '  ok   %s\n' "$1"
  fi
}

# The one check in this file that reads BYTES instead of a text haystack, because an OG card is
# a PNG. Every helper above takes a body that has already been through `$( )`, which mangles a
# binary payload (NUL bytes dropped, trailing newlines stripped), so a card can only be asserted
# from a file on disk.
#
# THE STATUS CODE AND THE CONTENT-TYPE ARE DELIBERATELY NOT THE ASSERTION. `ImageResponse` builds
# its body as a lazy ReadableStream (next/dist/server/og/image-response.js), so the headers are
# committed before Satori and resvg have drawn anything: a route that resolves and then fails to
# rasterize still answers `200 image/png`. Only the bytes tell a card from an error page wearing
# a card's headers -- proven by mutant (an OG route returning a 200 with an HTML body keeps this
# section's header checks green and turns every check_png red; task-9-report.md).
#
# The four opengraph-image.test.tsx suites cannot cover this at all: they read `.status` and the
# content-type off the returned Response without draining it, so no PNG byte exists anywhere in
# the app suite. This gate is the only thing in the repo that runs the rasterizer.
#
# CARD_MIN_BYTES is a FLOOR, not a fixture. The four cards measured 85,274-93,592 bytes on the
# served build at 7dc9fc6; a blank 1200x630 fill compresses to a couple of KB. What the floor
# catches is a card that rasterized to an empty frame -- correct signature, correct IHDR, nothing
# drawn -- which is why it is a floor and not an equality: the byte count moves with the data.
CARD_MIN_BYTES=20000
check_png() { # check_png <name> <path>
  local f code w h size msg=""
  f="$(mktemp "${TMPDIR:-/tmp}/upgauge-smoke-card-XXXXXX.png")"
  code=$(curl -s -o "$f" -w '%{http_code}' --max-time 60 "${BASE}${2}")
  size=$(wc -c <"$f" | tr -d ' ')
  if [ "$(head -c 8 "$f" | od -An -tx1 | tr -d ' \n')" != "89504e470d0a1a0a" ]; then
    msg="no PNG signature: HTTP ${code}, ${size} bytes, starts: $(head -c 120 "$f" | tr -c '[:print:]' ' ')"
  else
    # IHDR is the first chunk by spec -- 8-byte signature, 4-byte length, the type `IHDR`, then
    # width and height as big-endian uint32 at byte 16 and byte 20. A truncated file yields ""
    # here, which fails the comparison rather than passing it.
    w=$(od -An -tu4 -j16 -N4 --endian=big "$f" | tr -d ' ')
    h=$(od -An -tu4 -j20 -N4 --endian=big "$f" | tr -d ' ')
    if [ "$w" != "1200" ] || [ "$h" != "630" ]; then
      msg="IHDR says ${w:-?}x${h:-?}, want 1200x630 (HTTP ${code}, ${size} bytes)"
    elif [ "$size" -lt "$CARD_MIN_BYTES" ]; then
      msg="${size} bytes is under the ${CARD_MIN_BYTES}-byte floor -- a card that rasterized empty"
    fi
  fi
  rm -f "$f"
  if [ -z "$msg" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n       %s\n' "$1" "$msg"
    FAILED=1
  fi
}

# Dataset-pinned checks assert values that can CHANGE when the warehouse advances -- totals,
# counts, rankings ("leads with X"), and window endpoints (the trailing/prior-12 boundary, the
# current year's own partial-month and asterisk, the dataset's own year range). A production
# image is built from the NEWEST release, so these cannot be right there by construction -- they
# are skipped, never rewritten, and the count is PRINTED: a gate that silently drops checks
# reports "ok" for less coverage than the reader assumes. Structural facts that stay true across
# an advance (a route exists, a page renders a table, a header is set) are NOT in this set --
# marking those too would make the flag a blanket off-switch by another name.
#
# One helper, dispatching to the underlying check FUNCTION named as its own first argument --
# not three near-identical copies, one per check()/check_not()/check_re() -- since all three
# share the same skip-and-count shell and only their pass/fail predicate differs.
SMOKE_DATASET_PINNED="${SMOKE_DATASET_PINNED:-1}"
DATASET_SKIPPED=0
check_dataset() { # check_dataset <fn> <name> <haystack> <needle> -- <fn> is check, check_not or check_re
  local fn="$1"
  shift
  if [ "$SMOKE_DATASET_PINNED" = "0" ]; then
    DATASET_SKIPPED=$((DATASET_SKIPPED + 1))
    echo "  skip  $1 (dataset-pinned)"
    return 0
  fi
  "$fn" "$@"
}

# Turns a literal string into an ERE that matches only itself, so a `$`-anchored `check_re` is
# actually exact. Section 15 needed this: `check_re ... "^[Ll]ocation: ${WANT}$"` interpolated
# `/robots.txt` and `/sitemap.xml` unescaped, and an unescaped `.` matches ANY character -- the
# very block whose header argues that a substring Location needle is a trap was itself asserting
# `/robots<any>txt`. Pure bash rather than sed: no delimiter to collide with the `/` in every
# pathname, and no shell-quoting layer between the pattern and grep.
re_escape() { # re_escape <literal> -> ERE source matching exactly that literal
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [\\.^\$*+?\(\)\[\]\{\}\|]) out+="\\${c}" ;;
      *) out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

# GAP_PORT/GAP_PID/BROKEN_DB belong to the Task 7 Part A gap check at the very end of this
# file, which runs a SECOND, short-lived server against a deliberately broken copy of the
# database -- declared here, not there, so cleanup() can always find them regardless of where
# the script stops (a `check` failure never exits early -- FAILED is a flag, not a trap -- but
# a hard error before that section runs must still not leak the temp file or process).
# GAP_PORT2/GAP_PID2/BROKEN_DB2 are M6 Task 8's own instance of the identical pattern, a THIRD
# short-lived server run strictly after the second one has been killed (never concurrently --
# same 8 GB reasoning), against a copy broken a different way (mart_route_health dropped, not
# meta_pivot_dimensions). GAP_PORT3/GAP_PID3/BROKEN_DB3 are M7 Task 10's own instance, a FOURTH
# short-lived server, run strictly after the third has been killed, against a copy broken a
# THIRD way again (dim_airport's lat/lon columns dropped, not a whole catalog view or table).
# Kill whatever is LISTENING on a port, whatever it calls itself.
#
# `pkill -f "next start app -p <port>"` cannot work and silently did nothing for every run
# before this. Two independent reasons, either one sufficient: Next rewrites its own process
# title to `next-server (v16.3.0)`, so the pattern matches no process at all; and `cap` runs
# the server under `systemd-run --user --scope`, which execs, so `$SERVER_PID` is not the pid
# holding the port by the time the server is up. Verified directly -- with an orphan holding
# :3199, `pgrep -f "next start app -p 3199"` matched nothing (a first attempt appeared to match
# and was the probing shell finding its own command line, which is its own lesson).
#
# The consequence was not a stray process. It was a DISHONEST GATE. The orphan keeps :PORT, so
# the next run's `next start` cannot bind and dies -- and every content curl is answered by the
# PREVIOUS run's build. All ~260 needles pass, because the orphan serves the same routes.
# Measured: one orphan held :3199 for 34 minutes across two consecutive runs, each reporting
# 266 ok against a build that did not contain the change under test. The ONLY check that
# noticed was the open-handle count reading 0 instead of 1, and it noticed by accident -- that
# check is about DuckDBInstance memoization and knows nothing about staleness. A gate that
# certifies the wrong build is worse than no gate, which is this file's entire premise.
kill_port() {
  local pid
  for pid in $(ss -lptnH "sport = :${1}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
    kill -9 "$pid" 2>/dev/null
  done
}

# Refuse to start against an occupied port rather than silently testing someone else's server.
# This is the half that actually makes the gate honest: kill_port above stops THIS run leaking,
# but only this guard stops a run inheriting a leak it did not create (a crashed run, a kill -9,
# a developer's own `make dev` on the same port).
port_free_or_die() {
  if ss -lntH "sport = :${1}" 2>/dev/null | grep -q .; then
    echo "  FAIL port ${1} is already in use before this run started."
    echo "       Refusing to continue: every check would pass against THAT server's build"
    echo "       instead of the one just built. Kill it and re-run."
    ss -lptnH "sport = :${1}" 2>/dev/null | sed 's/^/       /'
    exit 1
  fi
}

cleanup() {
  # Container teardown first: `docker rm -f` tears down the port mapping cleanly, so
  # `kill_port "$PORT"` below is a harmless no-op in container mode rather than a fallback
  # that kills docker-proxy and leaves the container itself running, unreachable and leaked.
  [ "$SMOKE_MODE" = "container" ] && docker rm -f upgauge-smoke >/dev/null 2>&1
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  kill_port "$PORT"
  [ -n "${GAP_PID:-}" ] && kill "$GAP_PID" 2>/dev/null
  [ -n "${GAP_PORT:-}" ] && kill_port "$GAP_PORT"
  [ -n "${BROKEN_DB:-}" ] && rm -f "$BROKEN_DB"
  # M6 Task 8's own gap check, appended after the M5 Task 7 Part A one below: a SECOND broken
  # copy and a SECOND short-lived server, same reason the first pair exists (an 8 GB box with
  # zram-only swap does not run two `next start` processes at once).
  [ -n "${GAP_PID2:-}" ] && kill "$GAP_PID2" 2>/dev/null
  [ -n "${GAP_PORT2:-}" ] && kill_port "$GAP_PORT2"
  [ -n "${BROKEN_DB2:-}" ] && rm -f "$BROKEN_DB2"
  # M7 Task 10's own gap check, appended after M6 Task 8's: a THIRD broken copy and a THIRD
  # short-lived server, same reason the first two pairs exist.
  [ -n "${GAP_PID3:-}" ] && kill "$GAP_PID3" 2>/dev/null
  [ -n "${GAP_PORT3:-}" ] && kill_port "$GAP_PORT3"
  [ -n "${BROKEN_DB3:-}" ] && rm -f "$BROKEN_DB3"
}
trap cleanup EXIT

cd "$ROOT"
if [ "$SMOKE_MODE" = "container" ]; then
  echo "==> container ${SMOKE_IMAGE} on :${PORT}"
  start_container "$PORT"
else
  echo "==> build"
  cap 4G mise exec -- npm --prefix app run build >/dev/null 2>&1 || { echo "  FAIL build"; exit 1; }
  echo "==> serve on :${PORT}"
  port_free_or_die "$PORT"
  serve_next "$PORT" /tmp/upgauge-smoke.log
  SERVER_PID=$!
fi
# Readiness probes /api/health, not "/": it is the one route that reports WHY it is not ready.
for _ in $(seq 1 90); do curl -sf -o /dev/null --max-time 2 "${BASE}/api/health" && break; sleep 1; done
# `curl -sf` treats the 503 this endpoint returns for a broken data layer as "not up", so the loop
# above cannot distinguish "nothing is listening" from "a server is answering, and telling us
# why". Reporting the second as "server never came up" throws away the one diagnostic the
# readiness probe was pointed at /api/health to get -- so re-probe without -f and print what it
# said. %{http_code} is 000 exactly when there was no HTTP response at all.
#
# THIS GUARD *IS* THE SERVED-BUILD 200 ASSERTION for /api/health -- there is deliberately no
# `check` for the status code below it. One was added and removed in the same review round: a
# `check "$READY_CODE" '200'` placed AFTER this `exit 1` can only ever run when READY_CODE is
# already exactly 200, so it could never be red, and it inflated both published counts by one.
# CLAUDE.md: a test that has never been red proves nothing. This form is the stronger one anyway --
# it aborts instead of continuing, so a degraded server cannot spend five minutes reporting a mass
# of consequential failures whose single cause is the line printed here. (No count is quoted for
# that: it is a property of one broken build, in the same way this repo declines to quote the
# `.Size` delta of one pair of Docker builds. The point is the ratio of noise to cause, not a
# number.) Twice proven red, by name, as an abort: HTTP 000 (stale container holding the name,
# nothing listening) and HTTP 503 (data/parquet emptied) -- see task-6-report.md's mutants I and J.
# Note that assert_identity below would NOT stop such a run: it reads build.sha/build.warehouse,
# which a degraded 503 body still carries. Identity and health are separate questions, correctly.
READY_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE}/api/health")
if [ "$READY_CODE" != "200" ]; then
  echo "  FAIL server not serving a healthy /api/health: HTTP ${READY_CODE} (000 = nothing listening)"
  echo "       Body: $(curl -s --max-time 5 "${BASE}/api/health" | head -c 500)"
  [ "$SMOKE_MODE" = "container" ] && docker logs upgauge-smoke 2>&1 | tail -30 \
                                  || cat /tmp/upgauge-smoke.log
  exit 1
fi
assert_identity "$BASE"

# /api/health's OWN served-build HEADER contract. Its status code is owned by the readiness guard
# above (see the note there); these two checks are what nothing asserted on a served build at all,
# in either mode -- the guard reads only whether it answered 200, and assert_identity reads only
# build.sha/build.warehouse out of the body.
#
# `no-store` is this route's defining property and the reason it is the ONE route deliberately
# absent from proxy.ts's matcher (route.ts's header comment). proxy.test.ts pins that absence in
# the matcher ARRAY; the vitest at api/health/route.test.ts calls GET() directly. Neither crosses
# a served response, so a Next upgrade -- or an "add every route to the matcher" sweep -- could
# ship the project's 30-day s-maxage on this endpoint with all 805 app tests and both smoke gates
# green, and a shared CDN would pin `{"status":"ok"}` for a month in front of a degraded container.
HDRS=$(curl -s -o /dev/null -D - --max-time 10 "${BASE}/api/health")
# The needle is the header LINE, not the bare value: Next's own fallback for a route that set no
# header at all is `private, no-cache, no-store, max-age=0, must-revalidate`, which contains the
# substring `no-store` -- route.test.ts asserts the exact value for that same reason.
check "health: is never cached" "$HDRS" 'cache-control: no-store'
# And the negative is not redundant with it. A response carrying TWO Cache-Control values (a proxy
# appending to a header the handler already set, comma-joined or as a second line) still contains
# `cache-control: no-store` while being cacheable for 30 days -- the positive check alone would
# print ok. This one names the value that must never appear on this route, so a red also says
# which of the two failures happened.
check_not "health: never gets the project cache" "$HDRS" 's-maxage=2592000'

echo "==> checks"

# 1. A filtered query works at all. Before proxy.ts this returned 400 "malformed filter
#    'origin_state%3AOR'" -- with NO reserved characters involved.
BODY=$(curl -s --max-time 15 "${BASE}/api/pivot?v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&f=origin_state:OR&n=2&g=op")
check "api: a plain filtered query returns rows" "$BODY" '"rows"'
check_not "api: a plain filtered query is not rejected" "$BODY" '"error"'

# 2. The golden `filter_value_reserved_characters` values survive as SEVEN values, not as the
#    nine a re-split would produce. This is the permalink contract in features.md.
RESERVED='v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&f=origin_state:14%2C771,13%26487,9%255,12%3A34,a%3Db,a%2Bb,a%20b&n=100&g=op'
BODY=$(curl -s --max-time 15 "${BASE}/api/pivot?${RESERVED}")
check "api: reserved-character filter round-trips exactly" "$BODY" 'origin_state:14%2C771,13%26487,9%255,12%3A34,a%3Db,a%2Bb,a%20b'

BODY=$(curl -s --max-time 15 "${BASE}/explore?${RESERVED}")
check "explore: reserved-character permalink renders" "$BODY" '14,771'
# NEEDLES CROSS JSX, SO THEY MUST BE WRITTEN IN THE BYTES REACT ACTUALLY EMITS, NOT IN THE
# SOURCE. This check used to read 'can&rsquo;t be read', copied from explore/page.tsx's
# `<h1>This permalink can&rsquo;t be read</h1>`. JSX decodes HTML entities in text at COMPILE
# time and React's serializer escapes only & < > " ' -- U+2019 goes out as raw UTF-8, so the
# literal string `can&rsquo;t` was never in the response and this printed `ok` unconditionally,
# including in the case it exists to catch (M4c final review, F3). A dark guard in the one file
# this repo keeps because the other gates can pass for the wrong reason.
#
# The regex spans the apostrophe rather than pinning it, the same way line 222 already does --
# the character differs between the HTML body (React escapes ' to &#x27;) and the RSC flight
# payload (JSON-encoded, apostrophes intact), and this check reads a body containing both.
# Verified by mutation: forcing /explore to reject this permalink turns it red.
check_not_re "explore: reserved-character permalink is not rejected" "$BODY" 'permalink can.{1,6}t be read'

# 3. An invalid permalink still names the offending key rather than falling back to a default.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=nope&m=seats&t=2025-05:2026-04&n=5&g=op")
check "explore: invalid permalink names the key" "$BODY" 'unknown dimension'

# 4. A query that did not select departures_performed must not mark every row below floor.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op")
check_not "explore: no false below-floor marking without a departure count" "$BODY" 'data-below-floor="true"'
check "explore: DATA AS OF is present" "$BODY" 'DATA AS OF'

# 4b. The Explorer builder (epic #6, Task 6) -- composed onto all three states of /explore.
#
# EVERY NEEDLE BELOW IS WRITTEN IN THE BYTES REACT EMITS, not the bytes page.tsx contains, and the
# difference bites twice here: `className` is emitted as `class`, and `&` inside an href attribute
# is emitted as `&amp;` -- so a needle copied from a permalink literal (`?v=1&k=seg`) can never
# fire on an anchor. Each was mutation-run before it was allowed to count as coverage.
BUILDER_Q='v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op'
BODY=$(curl -s --max-time 15 "${BASE}/explore?${BUILDER_Q}")
check     "explore: renders the builder"           "$BODY" 'class="builder"'
check     "explore: labels a row with its URL key" "$BODY" 'class="chip-key">d<'
# Real anchors only. A <button> would be inert in the served HTML -- every view here works with
# JS off, and a native form GET cannot emit this permalink format at all.
#
# SCOPED TO THE BUILDER, and that is not a nicety: `TopBar` renders a real search form on every
# page, so `<button` and `<input` are BOTH present in this body legitimately. Run against `$BODY`
# these two report FAIL for the right page -- measured, not predicted. `between` cuts from the
# builder's own class to the `.body` div that follows it. If the builder were missing entirely
# the cut would start at the top of the document and sweep the top bar's form back in, so the
# absence checks go RED rather than vacuously green; the positive check below pins that the
# region extracted really is the builder.
BUILDER=$(between "$BODY" 'class="builder"' 'class="body"')
check     "explore: the extracted region really is the builder" "$BUILDER" 'class="chip-key"'
check_not "explore: the builder emits no button"   "$BUILDER" '<button'
check_not "explore: the builder emits no input"    "$BUILDER" '<input'

# THE INBOUND LINK THAT ENDS /explore/filter's ISLAND. Task 5 shipped that route with nothing
# linking to it; CLAUDE.md's rule is that neither sitemap.ts nor proxy.ts's matcher counts, and
# `/watch` shipped exactly this way one milestone after a review existed to prevent it. Asserted
# on the SERVED bytes, because that is the only place "a visitor can reach it" is actually true.
check     "explore: links into the filter value list" \
  "$BODY" 'href="/explore/filter/op_airline_id?v=1&amp;k=seg'
check     "explore: offers the either-end filter too" \
  "$BODY" 'href="/explore/filter/endpoint_airport_id?v=1&amp;'

# The ERROR state gets one too -- the state a "render it above the results table" implementation
# skips, because decode() threw and there is no table for it to sit above.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=nope&m=seats&t=2025-05:2026-04&n=5&g=op")
check     "explore: the error state still gets a builder" "$BODY" 'class="builder"'

# A filter chip shows the RESOLVED value, not the raw BTS id. `d=year_month` groups by month, so
# runPivot resolves NOTHING for op_airline_id -- the page has to resolve its own filter values or
# this reads `Carrier = 19790`.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=year_month&m=seats&t=2025-05:2026-04&f=op_airline_id:19790&s=-seats&n=25&g=op")
check     "explore: a filter chip resolves its id to a code" "$BODY" 'Carrier = DL'

# D4, gated on BOTH operands, and the three bodies are the check: keyed on the grouping alone the
# disclosure fires on the second, keyed on the filter alone it fires on the third.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&f=op_airline_id:19790&s=-seats&n=25&g=ml")
check     "explore: discloses a mainline rollup filtered on the operating carrier" \
  "$BODY" 'rolled-up row can show more seats'
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=ml")
check_not "explore: no rollup disclosure on an unfiltered mainline view" "$BODY" 'rolled-up row'
check     "explore: ...and that mainline view really rendered its foot" "$BODY" 'quarantined row'
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&f=op_airline_id:19790&s=-seats&n=25&g=op")
check_not "explore: no rollup disclosure on a filtered operating view" "$BODY" 'rolled-up row'
check     "explore: ...and that operating view really rendered its foot" "$BODY" 'quarantined row'

# 5. The caching header is the cost control, so it is a test, not a hope.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=5&g=op")
check "explore: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op")
check "api: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?v=1&bogus=1")
check "api: does not cache an error" "$HDRS" "no-store"

# 5b. /explore/filter/:dim -- the Explorer builder's value list (epic #6).
#
# THE ONLY GATE THAT CAN SEE ANY OF THIS. proxy.test.ts calls proxy() directly and never crosses
# Next's routing layer, so a route missing from `config.matcher` keeps every unit test green
# while shipping uncached, with no raw-query header, and with its 404 reduced to Next's error
# shell (docs/architecture/hosting.md § "What omitting one actually costs" has the measurement).
EXPLORE_Q='v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op'
ROUTE_Q='v=1&k=route&d=route&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op'

BODY=$(curl -s --max-time 15 "${BASE}/explore/filter/op_airline_id?${EXPLORE_Q}")
check "filter: lists resolved values"          "$BODY" '>WN<'
check "filter: links back into the Explorer"   "$BODY" 'f=op_airline_id:19393'
check "filter: DATA AS OF is present"          "$BODY" 'DATA AS OF'

# The either-end dimension is filter_only, so `renderPivot` refuses it as a grouping key -- an
# implementation that grouped by it 500s, and the proxy has already committed to an hour of
# public cache by then. Both ends must be listed, and both must write the either-end filter.
BODY=$(curl -s --max-time 15 "${BASE}/explore/filter/endpoint_airport_id?${EXPLORE_Q}")
check "filter: either-end explains its two lists" "$BODY" 'either end'
check "filter: either-end writes its own key"     "$BODY" 'f=endpoint_airport_id:'
check_not "filter: either-end did not 500"        "$BODY" 'Application error'

HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/explore/filter/op_airline_id?${EXPLORE_Q}")
check     "filter: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
# Not redundant with the line above, and the same discriminator `/` uses: Next's own
# force-dynamic fallback CONTAINS the substring "no-store", so a positive HTML_CACHE check plus a
# negative "no-store" check would BOTH stay green under a "remove this route from the matcher"
# mutant. `must-revalidate` is the one token in Next's fallback that no header proxy.ts sets has.
check_not "filter: is not Next's own force-dynamic fallback (proves proxy.ts ran)" \
  "$HDRS" "must-revalidate"

# TWO WAYS TO 404, AND THE PROBE MUST DECLINE THE CACHE FOR BOTH. `isFilterListCacheable`
# returning a bare `true` -- or gating on `allowlist.dims.has(dim)` instead of on the grain --
# leaves these long-cached, and the dataset is rebuilt monthly, so a cached 404 outlives the
# condition that caused it. The bodies are checked too: a missing matcher entry keeps the 404
# STATUS and destroys the MESSAGE, which is the failure mode no header check can see.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore/filter/not_a_dimension?${EXPLORE_Q}")
HDRS=$(curl -s -o /dev/null -D -             --max-time 15 "${BASE}/explore/filter/not_a_dimension?${EXPLORE_Q}")
BODY=$(curl -s                               --max-time 15 "${BASE}/explore/filter/not_a_dimension?${EXPLORE_Q}")
check     "filter: an unknown dimension is a 404"       "$CODE" '404'
check     "filter: an unknown dimension is not cached"  "$HDRS" 'no-store'
check     "filter: the 404 names the slug"              "$BODY" 'not_a_dimension'
check     "filter: the 404 names WHICH way it failed"   "$BODY" 'No such dimension'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore/filter/aircraft_type?${ROUTE_Q}")
HDRS=$(curl -s -o /dev/null -D -             --max-time 15 "${BASE}/explore/filter/aircraft_type?${ROUTE_Q}")
BODY=$(curl -s                               --max-time 15 "${BASE}/explore/filter/aircraft_type?${ROUTE_Q}")
check     "filter: a wrong-grain dimension is a 404"      "$CODE" '404'
check     "filter: a wrong-grain dimension is not cached" "$HDRS" 'no-store'
# A DIFFERENT sentence from the unknown-slug one, and the pairing is the point: this dimension is
# real, so the page must not say it is not a dimension.
check     "filter: the wrong-grain 404 says so"           "$BODY" 'Not filed at this grain'
check_not "filter: the wrong-grain 404 is not the unknown-slug sentence" \
  "$BODY" 'is not a dimension'
# And the SAME slug against the segment permalink renders -- without this the two checks above
# are satisfied by a page that 404s aircraft_type unconditionally.
BODY=$(curl -s --max-time 15 "${BASE}/explore/filter/aircraft_type?${EXPLORE_Q}")
check     "filter: the same slug renders at the grain that carries it" "$BODY" 'f=aircraft_type:'

# The QUERY_ROWS entry, from the served side. Without it rule 1's `clean` default applies and
# `?x=1..N` is an unbounded family of distinct CDN keys on a page that runs a live pivot.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore/filter/op_airline_id?${EXPLORE_Q}&bogus=1")
HDRS=$(curl -s -o /dev/null -D -             --max-time 15 "${BASE}/explore/filter/op_airline_id?${EXPLORE_Q}&bogus=1")
check "filter: a junk key is a 307"        "$CODE" '307'
check "filter: a junk key is not cached"   "$HDRS" 'no-store'
# Totality, the axis that 500ed every matcher path once: `proxy.ts` strips ONE leading `?`.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore/filter/op_airline_id??${EXPLORE_Q}")
check "filter: a doubled question mark redirects rather than 500ing" "$CODE" '307'

# 6. The front door is ours, not the scaffold's.
#
# M4c final review, F6: the absence check below was the only unpaired check_not left in the
# file, so an empty body, an error shell or a 500 page satisfied it just as well as the real
# front door did. It is now paired with two positives on the same body -- the page's own h1,
# which nothing else in this app renders, and the DATA AS OF badge, which is what makes / a
# data view rather than a static splash.
BODY=$(curl -s --max-time 15 "${BASE}/")
check     "home: renders our own front door"        "$BODY" 'Is this route healthy'
check     "home: DATA AS OF is present"             "$BODY" 'DATA AS OF'
check_not "home: no create-next-app boilerplate"    "$BODY" 'vercel.com/new'

# M8 Task 1 (#13): the header, not just the content. `/` was absent from proxy.ts's matcher
# (eleven entries through M7 Task 9), so it served Next's own force-dynamic fallback --
# `private, no-cache, no-store, max-age=0, must-revalidate` -- which forbids caching at the CDN
# too, on the most-requested URL of the site. Only THIS gate can see it: proxy.test.ts calls
# proxy() directly and never crosses Next's routing layer, so a missing matcher entry leaves
# every one of its tests green.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/")
check     "home: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
# Not decoration, and not redundant with the check above. Next's own fallback string CONTAINS
# the substring "no-store", so a positive HTML_CACHE check paired with a negative "no-store"
# check would BOTH stay green under a "remove / from the matcher" mutant. `must-revalidate` is
# the one token present in Next's fallback and absent from every header proxy.ts sets -- the
# same discriminator the /search block and the /explore gap check already use.
check_not "home: is not Next's own force-dynamic fallback (proves proxy.ts ran)" "$HDRS" "must-revalidate"

# 7. Resolution: the reader must see codes, never the catalog's ids.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op")
check     "explore: renders a carrier code"        "$BODY" '>DL<'
check_not "explore: renders no bare airline id"    "$BODY" '>19790<'
check     "explore: legend states current identity" "$BODY" 'current identity'

BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=route&d=route&m=seats&t=2025-05:2026-04&s=-seats&n=10&g=op")
check_re     "explore: route renders as two resolved codes"  "$BODY" '>[A-Z]{3}–[A-Z]{3}<'
check_not_re "explore: route renders no raw airport ids"     "$BODY" '>[0-9]{4,5}–[0-9]{4,5}<'

# 8. The route entity page, served for real.
BODY=$(curl -s --max-time 15 "${BASE}/route/JFK-LAX")
check     "route: renders the pair"            "$BODY" 'JFK–LAX'
check     "route: renders a carrier code"      "$BODY" '>DL<'
check     "route: DATA AS OF is present"       "$BODY" 'DATA AS OF'
check     "route: links to the Explorer"       "$BODY" '/explore?'
# M5 "connect the graph": every resolved dimension cell links to its own entity page
# (docs/design/system.md § The data table, entityLink.ts's entityHref). The exact attribute,
# not just the code text -- 'DL' alone is already covered by the check above and would stay
# green if the link were ever dropped and the bare code kept rendering as plain text.
check     "route: links a carrier cell to /carrier/DL" "$BODY" 'href="/carrier/DL"'

# Final whole-branch review, M11: nothing in this file asserted Task 2's two visible
# deliverables in the SERVED bytes -- the site-wide search form TopBar renders on all ten
# pages, and the four entity pages' self-referential <link rel="canonical">. Both are cheap to
# drop silently: neither changes a page's status code or its other content, so every other
# check in this file stays green if one regresses. UPGAUGE_BASE_URL is unset for this script,
# so BASE_URL (lib/siteUrl.ts) falls back to its documented default, http://localhost:3000 --
# NOT this script's own $BASE (a different port) -- which is why the needle below is a literal
# localhost:3000 URL rather than ${BASE}.
check "route: renders the site-wide search form (TopBar, M5 Task 2)" "$BODY" 'action="/search"'
check "route: the search form is role=search"                        "$BODY" 'role="search"'
check "route: carries a self-referential canonical link (Task 2)" "$BODY" \
  '<link rel="canonical" href="http://localhost:3000/route/JFK-LAX"'

# Critical fix, final whole-branch review: this section copied the body checks above but not
# a header check, which is exactly why /route shipped `no-store` -- every OTHER check here
# passes whether or not the Cache-Control header is set. See proxy.ts and CLAUDE.md's "every
# response gets Cache-Control" rule.
#
# M5 Task 7 Part B shortened this from the project's 30-day value to HTML_CACHE (1 hour, see
# proxy.ts's own doc comment) -- checked against HTML_CACHE_EXPECTED, not CACHE_EXPECTED, which
# stays the literal /api/pivot (and, as of Task 8, /sitemap.xml/robots.txt) still use.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/route/JFK-LAX")
check     "route: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/route/LAX-JFK")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/route/LAX-JFK")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "route: reversed pair redirects"     "$CODE" '308'
check     "route: redirect targets canonical"  "$LOC"  '/route/JFK-LAX'
# Fix wave 3, item 4: the 308's Cache-Control was the ONE row of hosting.md's cache table no
# served-build check covered, and it is the row a status-shaped rule ("cache 200s") would
# silently drop -- the redirect target is derived from the two codes alone, so it is exactly
# as stable as the 200 and must stay long-cached. Only proxy.test.ts pinned it, and that test
# calls proxy() directly without crossing Next's header plumbing.
check     "route: 308 keeps the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/route/ZZZZ-LAX")
check     "route: unknown code is a 404"       "$CODE" '404'

# Fix wave 2, NEW-1: the cache header used to be set on EVERY /route/ response, so a 404 was
# pinned in a shared CDN cache for 30 days -- longer than the monthly ingest that can make the
# pair real. proxy.ts now resolves the pair BEFORE the page runs (a Next proxy cannot see the
# downstream status) and caches only well-formed known pairs. The 200 and the 308 above must
# stay long-cached; these three must not. Nothing but a served build can check this: the unit
# tests never cross Next's own header plumbing.
for P in ZZZZ-LAX JFK-LHR LAX-LAX; do
  HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/route/${P}")
  check_not "route: 404 (${P}) is not long-cached" "$HDRS" "s-maxage"
  check     "route: 404 (${P}) is no-store"        "$HDRS" "no-store"
done

# Fix wave 2, Important 2: four doc sites promise a 404 "naming the offending code". The 404
# body used to come from a Client Component reading usePathname(), which named the whole PAIR
# and which no server test and no curl could observe -- so usePathname() returning null would
# have degraded the page to a generic sentence with every gate green. It is now a Server
# Component re-running routePair.ts against the real database (lib/rawPath.ts). Each case
# asserts a phrase only ITS reason produces AND the absence of a sibling case's phrase,
# because a single generic sentence enumerating all the causes would satisfy any lone
# positive check -- that sentence is exactly what shipped before.
#
# What these checks DO and DO NOT prove. Next serves a 404 from a force-dynamic page as an
# `<html id="__next_error__">` shell with an EMPTY <body>; the page's markup arrives in the
# streamed React payload further down the same response and is rendered client-side. That is
# pre-existing -- verified by building and curling d158726, before any of this fix wave -- and
# it is why these greps read the whole response body, not a <p> tag. They still prove exactly
# the thing the fix is about: the payload is generated on the SERVER, so a hit here means the
# server resolved this pair and shipped this specific reason. They do NOT prove the sentence
# is visible with JavaScript off. That gap is logged, not fixed here.
#
# Fix wave 3, item 5: both of the first two checks here used to be weaker than the unit tests
# they mirror. 'unknown airport code' alone asserts the CATEGORY, where the whole promise is
# that the page names the offending CODE -- so the needle now carries ZZZZ. And asserting that
# 'ZZZZ-LAX' appears anywhere was very nearly vacuous: the payload echoes the requested
# pathname into the router state ("c":["","route","ZZZZ-LAX"]) whatever the page renders. The
# needle is now the slug IMMEDIATELY AFTER the sentence the page itself composes, which only
# the rendered <p role="alert"> produces. The regex spans the payload's own string-escaping
# between the two (`show ‘\",\"ZZZZ-LAX`) rather than pinning that escaping exactly.
BODY=$(curl -s --max-time 15 "${BASE}/route/ZZZZ-LAX")
check     "route 404: names the offending code, not just the pair" "$BODY" "unknown airport code 'ZZZZ'"
check_re  "route 404: the SENTENCE carries the slug, not just the router state" "$BODY" 'We can.{1,3}t show .{1,12}ZZZZ-LAX'
check     "route 404: DATA AS OF is present"                       "$BODY" 'DATA AS OF'
check_not "route 404: does not offer every cause at once"          "$BODY" 'domestic-only'

BODY=$(curl -s --max-time 15 "${BASE}/route/JFK-LHR")
check     "route 404: a real airport outside the dataset says so"  "$BODY" 'domestic-only'
check_not "route 404: LHR is not reported as an unknown code"      "$BODY" 'unknown airport code'

# 9. M4c: the aircraft-mix chart, in the SERVED HTML.
#
# This is the section the milestone exists to produce. Before it, `AircraftMixChart` had 262
# green unit tests and a clean `next build` while being reachable from no route at all: nothing
# in CI ever executed its Plot path, so a bundler or serverExternalPackages regression would
# have shipped with every gate green -- the exact shape of the five M3b bugs at the top of this
# file. Plot + jsdom + Next's server bundler is a seam no unit test crosses by construction.
BODY=$(curl -s --max-time 30 "${BASE}/route/JFK-LAX")
check "chart: the SVG is in the served HTML, not an empty client-side container" "$BODY" '<svg role="img"'
check "chart: the aria-label describes the series, not the word 'chart'" "$BODY" 'Stacked area of monthly seats by aircraft type'
# `var(--gN)` has to survive Plot's ordinal colour scale, jsdom's serializer AND React's HTML
# escaping to reach the browser. globals.css is the single source for the ramp only if it does;
# the spec's fallback was hardcoded hex, which this check is what rules out. Both ends, because
# a range collapsed to one colour still emits a fill.
#
# `<path fill=... d=`, not the bare `fill="var(--g5)"` this was first written as: mutating the
# chart out of the page left that weaker needle GREEN, because the legend rail's own fleet
# swatch is a `<rect fill="var(--g5)">` drawn from the same token. Anchoring to a path WITH
# geometry is what makes this a claim about the chart rather than about the rail beside it.
check "chart: the ramp tokens reach the SVG area fills (lightest)" "$BODY" '<path fill="var(--g0)" d='
check "chart: the ramp tokens reach the SVG area fills (darkest)"  "$BODY" '<path fill="var(--g5)" d='
check "chart: COVID is drawn and labelled, not smoothed away" "$BODY" 'COVID — in window on purpose.'
check "chart: the page states the chart's own window"         "$BODY" 'chart: the full window'
check "chart: the rail explains what the ramp encodes"        "$BODY" 'ordered by seats per departure'
# The pre-existing server-side text of this page, re-checked AFTER the chart mounted above it:
# a chart that threw during render would take the whole Server Component down, and every check
# in section 8 runs against a body fetched before this one.
check "chart: the rest of the page still server-renders"      "$BODY" '>DL<'

# The annotation, as a FALSIFIABLE PAIR. Absence alone would be satisfied by a component that
# never renders an annotation at all, and presence alone by one that manufactures one on every
# chart -- which is the specific failure the spec forbids ("it must never fall back to
# labelling the largest type"). Both routes are measured against the built warehouse:
# JFK-LAX's A321nXLR leads every year 2015-2026 (no crossover, 46% of routes are like this),
# and ATL-MCO's leader goes A321nXLR -> B757-2 in 2018. If a data refresh moves ATL-MCO's
# crossover this check fails loudly and is re-measured; that is the point of pinning the
# derived string rather than the word.
#
# It fired for real at the 20260807 refresh -- but on the NAME, not the crossover: BTS renamed
# type 699's SHORT_NAME from 'A321/LR' to 'A321nXLR' (T_AIRCRAFT_TYPES carries current identity
# with no name history, exactly like dim_carrier's carrier_code). The crossover itself was
# re-measured and had not moved at all: B757-2 still takes ATL-MCO in 2018, and JFK-LAX's
# yearly leaders are byte-identical to the pre-refresh table in crossover.test.ts. So a
# rename can redden this check without any underlying fact changing -- re-measure before
# assuming a data movement.
check_dataset check_not "chart: a route with no crossover gets NO annotation (JFK-LAX)" "$BODY" 'overtakes'
# The negative half of the gap pair below. JFK-LAX filed in all 136 months of the window
# (measured), so it must claim no gaps AND draw each band in exactly one piece.
check_not "chart: a route with no gaps claims none (JFK-LAX)" "$BODY" 'no filings'
check_re  "chart: an ungapped band is ONE path (JFK-LAX)" "$(count "$BODY" '<path fill="var(--g5)" d=')" '^1$'
BODY=$(curl -s --max-time 30 "${BASE}/route/ATL-MCO")
check_dataset check "chart: a route with one gets the derived annotation (ATL-MCO)" "$BODY" 'B757-2 overtakes A321nXLR · 2018'

# M4c final review, F1, IN THE SERVED BYTES. HNL-LAS (7.07 M seats over the window) filed
# nothing at all for 2020-04..2020-09 -- six months INSIDE the --panel-2 band this chart
# labels "COVID -- in window on purpose." The shipped M4c built its x domain from the months
# PRESENT in the pivot result, so those six were not on the axis and Plot drew one straight
# edge from 37,441 seats down to 6,804 across them; a reader read roughly 30k, 22k, 15k seats
# for months that filed nothing. 14,293 of 23,041 route pairs (62%) have such a gap.
#
# Two claims, because the sentence alone would be satisfied by a chart that says "6 months"
# and still draws across them: the page STATES the absence, and the darkest band arrives as
# TWO paths -- one either side of the hole. `count`, not `has`: `<path fill="var(--g5)" d=`
# is present either way, and only its multiplicity distinguishes a broken area from a
# smoothed one. Exactly 2 and not "at least 2" -- one gap means two pieces, and a third would
# mean the area is being shattered somewhere it should not be. The literal (unescaped) form
# occurs only in the HTML body; the RSC flight payload's copy is backslash-escaped.
BODY=$(curl -s --max-time 30 "${BASE}/route/HNL-LAS")
check    "chart: the unfiled months are stated (HNL-LAS)" "$BODY" '6 months with no filings, drawn as gaps rather than interpolated.'
check_re "chart: the band BREAKS at them, drawn as two paths (HNL-LAS)" "$(count "$BODY" '<path fill="var(--g5)" d=')" '^2$'

# The OTHER branch of the window line, in the served bytes. ATL-CAK filed 67 months, 2015-01 ->
# 2022-06, and nothing since; the chart is fetched over the full window but can only draw to
# 2022-06. The line shipped naming the REQUESTED window, putting "the full window · 2015-01 →
# 2026-05" above a chart that stops in 2022 -- the aria-label was already right, so only the
# text a sighted reader sees was wrong. 12,115 of 23,041 pairs last filed before the current
# trailing-12 window, so this branch is the majority case, not an edge.
#
# Checked HERE and not only in page.test.tsx because the fix's first form was `chart: {a} → {b}`
# -- adjacent JSX expressions, which React's SSR separates with `<!-- -->` in the served HTML.
# `textContent` skips comment nodes, so all 281 unit tests passed while this tier went red. That
# is the whole reason this file exists, and it is why the assertion below is over raw bytes.
BODY=$(curl -s --max-time 30 "${BASE}/route/ATL-CAK")
check_dataset check     "chart: a subject that stopped filing names ITS range (ATL-CAK)" "$BODY" 'chart: 2015-01 → 2022-06'
check_dataset check_not "chart: ...and does not claim the full window there"            "$BODY" 'chart: the full window'

# Page weight, recorded rather than asserted: the chart is ~136 months x 6 bands of path data
# on a force-dynamic page, and M4d mounts this same component on three more pages. A threshold
# here would be a number invented in a shell script; the measurement is the useful part.
printf '  note %s bytes of HTML for /route/JFK-LAX (32,087 before the chart, M4c task 6)\n' \
  "$(curl -s --max-time 30 "${BASE}/route/JFK-LAX" | wc -c)"

# ---------------------------------------------------------------------------------------------
# 10-12. M4d: /airport, /carrier, /aircraft -- the three entity pages, and the routing tier
#        that none of them could wire up for itself.
#
# READ THIS BEFORE ADDING A PAGE. Each of the three sections below asserts the SAME FIVE THINGS,
# in the same order, and the order is not decorative:
#
#   a. the page renders                       (a positive on content only this page produces)
#   b. its Cache-Control is the project one   <-- M4b's Critical. THE ONE THAT WAS MISSING.
#   c. a real code renders, a bare id doesn't (M4a's rule, per page)
#   d. the chart's <svg> and ramp fills are in the SERVED bytes (M4c's gate, per page)
#   e. its 404 names the code AND is no-store, and its 308 keeps the long cache
#
# (b) and (e) exist because `proxy.ts`'s matcher is invisible to every other gate in this repo.
# A page missing from it builds, serves, renders and passes (a), (c) and (d) -- while shipping
# `private, no-cache, no-store` on the 200 AND turning every 404 on that page into a **500**
# (each `not-found.tsx` reads the pathname header the proxy sets, and throws without it). M4b
# shipped exactly that on /route because this file copied /explore's BODY checks and not its
# HEADER check. Both halves are mandatory for any page added after this one.
#
# Verified by mutation on a served build, not by inspection (M4d task 5): removing
# `/airport/:code` from the matcher turns (b) red and takes the airport 404s to 500; widening
# `isCacheable` to `!== "notFound"` turns exactly the CE-180 no-store check red.

# 10. /airport/<code> -- the airport is both endpoints.
BODY=$(curl -s --max-time 30 "${BASE}/airport/SEA")
check     "airport: renders the code"        "$BODY" '>SEA<'
check     "airport: DATA AS OF is present"   "$BODY" 'DATA AS OF'
# The one figure that distinguishes this page's implementation from the plausible wrong one.
# `origin OR dest` at SEA over 2025-06..2026-05 is 53,372,100 seats; an origin-only page renders
# every stat, row and band in the right shape and reads 26,708,918. Carrier and aircraft-type
# COUNTS are identical either way (13 and 25), so they are not discriminators -- see
# docs/data/invariants.md § Route identity. Dropping the inclusion-exclusion overlap term
# instead reads 53,384,307.
check_dataset check "airport: counts BOTH endpoints, not just departures" "$BODY" '53,372,100'
check     "airport: says so in words"        "$BODY" 'at <b>both</b> endpoints'
# `>14747<`, not a bare `14747`: SEA's airport_id legitimately appears in this page's Explorer
# permalink (`f=endpoint_airport_id:14747` -- ONE link since M7, not the two origin/dest halves
# this comment used to describe), which is why the task-2 handoff's "must not contain 14747"
# cannot be taken literally. The claim is that no CELL renders the raw id.
check_not "airport: renders no bare AIRPORT_ID" "$BODY" '>14747<'
check     "airport: the chart SVG is in the served HTML" "$BODY" '<svg role="img"'
check     "airport: ramp tokens reach the area fills (lightest)" "$BODY" '<path fill="var(--g0)" d='
check     "airport: ramp tokens reach the area fills (darkest)"  "$BODY" '<path fill="var(--g5)" d='
# The positive half of /aircraft's "not by aircraft type" below. An absence check whose needle
# is served by no page in the app is an absence check that can never fire; this is the page that
# proves the string exists and reaches the served bytes.
check     "airport: the chart stacks by aircraft type" "$BODY" 'Seats by aircraft type'
# Final whole-branch review, M11 (second of four canonical checks -- see /route's own comment
# for why this is a literal localhost:3000 URL, not ${BASE}).
check     "airport: carries a self-referential canonical link (Task 2)" "$BODY" \
  '<link rel="canonical" href="http://localhost:3000/airport/SEA"'

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/airport/SEA")
check     "airport: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/airport/sea")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/sea")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "airport: lower-case code redirects"  "$CODE" '308'
check     "airport: redirect targets canonical" "$LOC"  '/airport/SEA'
# The 308 target here is `toUpperCase()` and nothing else -- resolveAirportCode redirects on case
# BEFORE it looks anything up -- so it cannot be invalidated by an ingest and stays long-cached,
# same as /route's. (`/airport/zzzz` therefore gets a cached 308 to `/airport/ZZZZ`, which then
# 404s no-store. That is the correct split: the redirect is a fact about the string.)
check     "airport: 308 keeps the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

# Fix round 1 (M7 Task 9 review): a handler returning a redirect Response object and a served
# app returning one over the wire are not the same claim -- this is the smoke half of the
# unit-tested "preserves a valid year query param across the case-normalization redirect", and
# the reason this repo keeps app/smoke.sh at all. Without this check, a served build could still
# silently drop `?y=2019` on this exact path with every other gate green.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/sea?y=2019")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check "airport?y: the case-redirect preserves the query string, not just the code" "$LOC" '/airport/SEA?y=2019'

for A in ZZZZ LHR; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/airport/${A}")
  HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/${A}")
  check     "airport: ${A} is a 404"                 "$CODE" '404'
  check_not "airport: 404 (${A}) is not long-cached" "$HDRS" "s-maxage"
  check     "airport: 404 (${A}) is no-store"        "$HDRS" "no-store"
done
# 404 body, paired the way /route's is: each case asserts a phrase only ITS reason produces AND
# the absence of the sibling case's, because one generic sentence listing every cause would
# satisfy any lone positive. A 500 from a missing matcher entry fails all four.
BODY=$(curl -s --max-time 15 "${BASE}/airport/ZZZZ")
check     "airport 404: names the offending code"       "$BODY" "unknown airport code 'ZZZZ'"
check_not "airport 404: not every cause at once"        "$BODY" 'domestic-only'
BODY=$(curl -s --max-time 15 "${BASE}/airport/LHR")
check     "airport 404: a real airport outside the dataset says so" "$BODY" 'domestic-only'
check_not "airport 404: LHR is not reported as unknown"             "$BODY" 'unknown airport code'
# The SENTENCE carries the slug, not just the reason. Both checks above are satisfied by a page
# that stopped echoing the requested code entirely, because the reason names it too -- the trap
# Task 3 found on /carrier and left open here. Unlike /carrier there is no lower-case variant to
# contrast with: resolveAirportCode 308s on case BEFORE it looks anything up, so the typed and
# canonical spellings are equal by construction on this path (pinned in not-found.test.tsx).
BODY=$(curl -s --max-time 15 "${BASE}/airport/ZZZZ")
check_re  "airport 404: the SENTENCE carries the requested code" "$BODY" 'We can.{1,3}t show .{1,12}ZZZZ'

# 10b. M7 Task 9: /airport/<code>?y=<year>, and the cache-header split proxy.ts's matcher
# section warns can only be seen by a served build. asOf is 2026-05 as measured (M4d's own
# convention of hardcoding the current measured asOf elsewhere in this file, e.g. the carrier
# chart-window check below) -- 2015-2025 are complete calendar years and 2026 is partial.
BODY=$(curl -s --max-time 30 "${BASE}/airport/SEA?y=2019")
check     "airport?y: states the map's own calendar-year window"     "$BODY" 'map: calendar year 2019'
check     "airport?y: the track offers every year, 2019 marked current" "$BODY" '>2019<'
check_not "airport?y: a complete prior year is not called partial"   "$BODY" 'calendar year 2019 — partial'

BODY=$(curl -s --max-time 30 "${BASE}/airport/SEA")
check_dataset check "airport: the default view states the current year is partial" "$BODY" \
  '2026 is a partial year — filed through May 2026 only.'
check_dataset check "airport: the current year's own tick carries the asterisk" "$BODY" '>2026*<'

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/airport/SEA?y=2019")
check     "airport?y=2019: a valid year still gets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

# The pair this task's own mutant table exists to prove: a `no-store`-everywhere regression
# would pass the "declines" half below vacuously, so BOTH must be checked against a served
# build, not just the unit suite -- proxy.test.ts pins the same pair, but only a served build
# proves proxy.ts's matcher and cacheability branch actually run together in production.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/SEA?y=1999")
check     "airport?y=1999: an out-of-range year is no-store"          "$HDRS" "no-store"
check_not "airport?y=1999: ...and is never long-cached"              "$HDRS" "s-maxage"

BODY=$(curl -s --max-time 15 "${BASE}/airport/SEA?y=1999")
check_dataset check "airport?y=1999: names the offending value and the covered range" "$BODY" \
  "unknown year '1999' — this dataset covers 2015–2026"
check_dataset check_not "airport?y=1999: does not silently fall back to the default view" "$BODY" '53,372,100'

BODY=$(curl -s --max-time 15 "${BASE}/airport/SEA?y=nonsense")
check     "airport?y=nonsense: malformed input is the same named error, not a 500" "$BODY" \
  "unknown year 'nonsense'"

# 10c. M7 Tasks 4-8: the airport network map, in the served HTML. ORD, not SEA -- it is the
# database's own worst case (measured 273 destinations after the same-airport row is excluded,
# vs. SEA's much smaller network), so this is the section that would first show a truncation or
# a rendering blow-up if one existed. Same five-part discipline the comment above states for
# every entity page (renders, Cache-Control, real-vs-bare id, chart/map svg, 404/308 caching),
# applied to the map specifically since nothing above this line has curled it at all: the map
# reached 718+ app tests green and a clean `next build` while being reachable from no served
# route this file ever checked -- the same "green unit tests, mounted on no route at all"
# shape the mix chart hit before it.
#
# The `<svg ... role="img"` needle is anchored on this map's own `viewBox`, not the bare
# `<svg role="img"` M4c's chart check uses -- that
# bare form also matches AircraftMixChart's own SVG (mounted on this same page, M7 Task 3 kept
# it) and, per the M4d comment two sections up, the per-row sparkline in DataTable. Anchoring on
# this map's own pixel size is what makes the check a claim about the MAP rather than
# about any other SVG this page happens to also render.
#
# THE viewBox IS NO LONGER ONE CONSTANT, and that is #123's whole point: the canvas is cropped
# to the panels a network reaches, so a conterminous page reads `0 12 960 532` while an
# Alaska-only one reads `0 354 960 190`. Both forms appear below and they are NOT
# interchangeable -- pasting the conterminous needle onto an Alaskan page would be a check that
# can only ever fail, and pasting the Alaskan one onto ORD would silently stop asserting the
# thing this block exists for. Every value here was read off a served build (`next start app`
# from the REPO ROOT -- from `app/` the SQL directory does not resolve and every page 500s),
# never computed from source.
BODY=$(curl -s --max-time 30 "${BASE}/airport/ORD")
check     "airport map: the network SVG is in the served HTML" "$BODY" \
  '<svg viewBox="0 12 960 532" width="960" height="532" role="img"'
# The positive control for A18's two negatives below: on a page whose chart DOES draw, the
# fleet-shading group and its COVID sentence must both be present. Without this, deleting the
# group outright would satisfy every negative needle in this file.
check     "airport map: a page whose chart draws DOES get the fleet-shading rail group" "$BODY" \
  'Fleet shading'
# THE SENTENCE ITSELF, not just the group heading, and it is the needle FIVE assertions depend on
# being matchable: A18's `check_not` below, plus four `not.toContain` in the page tests. A copy
# edit to this string would turn every one of them silently vacuous while staying green -- the
# self-defect class `smoke.sh`'s own header says to assume a fourth of. Verified against emitted
# bytes: React renders it from a JS string literal, so the em dash and apostrophe in the
# surrounding prose never reach this substring and it needs no entity handling.
check     "airport map: ...and the COVID-window sentence the A18 negatives are written against" \
  "$BODY" 'COVID is in the window on purpose'
check     "airport map: ...and a page that draws arcs DOES get the arc-rendering group" "$BODY" \
  'Arc rendering'
# EXACTLY 273, not "at least" and not 274. ORD carries a same-airport row (53 rows / 76,236
# seats over the trailing 12 -- networkMap.ts's own NetworkMapInput doc) that renderNetworkMap
# deliberately excludes from the drawn set (a same-airport great circle has zero length and
# would draw an invisible mark atop the origin disc) while keeping its seats in the STATED
# total -- so 274 arcs worth of destinations produce 273 polylines, and a mutant that drew the
# same-airport row anyway would produce 274 here without moving any other check in this file.
# `count`, not `has`: presence alone cannot distinguish "the exclusion runs" from "it doesn't."
#
# NOT doubled the way M4c's chart-path checks are (a normal JSX SVG ships once in the HTML body
# and again, `<`-escaped to `<`, in the RSC flight payload) -- measured directly against
# this same served build: `<polyline` occurs exactly 273 times in the WHOLE response, because
# this SVG is a single pre-serialized string injected via `dangerouslySetInnerHTML`
# (NetworkMap.tsx), and Next's RSC payload re-encodes that string's own `<` as `<` before
# embedding it, so the literal 4-byte substring `<polyline` never appears a second time. A
# doubled-count assumption carried over from the chart checks would have made this section
# assert 546 and fail against the real build.
check_dataset check_re "airport map: exactly 273 polylines (same-airport arc excluded)" \
  "$(count "$BODY" '<polyline')" '^273$'
# An inset label -- ORD's own network reaches ak/hi/car (measured against this served build;
# no ORD route touches a Pacific panel, which is why section 10b uses GUM), each drawn as a
# labelled `<rect>`+`<text>` frame (INSETS,
# networkMap.ts). Plain "ALASKA", not the bare `>ALASKA<` M5-style checks use elsewhere in this
# file: the RSC payload escapes this SVG string's `>`/`<` to `>`/`<` (see the polyline
# comment just above) but NOT the plain word between them, so the bracketed form appears once
# and the bare word appears twice -- the bare form is what a mutant that dropped the inset
# LOOP entirely (rather than just its frame) would still fail, since the loop draws the `<text>`
# that carries this word and nothing else on the page does.
check     "airport map: an inset is labelled (ALASKA)" "$BODY" 'ALASKA'
# Final whole-branch review, Important #8: every check above this line proves the ARCS,
# insets, window line and cache pair reach the served bytes, but NONE of them proves the
# COASTLINE does -- the one output produced by a committed GENERATED module
# (basemapPaths.generated.ts) rather than by code under test. A collapsed or empty basemap
# renders a map with no landmass, which is visually IDENTICAL to the legitimately-empty `nwhi`
# (Midway) panel (docs/design/system.md § The map) -- so this is the map's own analogue of the
# aircraft-mix chart's ramp-fill checks, and the one thing this section was missing.
# `data-panel="us"` is the attribute `build-basemap.mjs` stamps on every `<path>` it emits
# (basemapPathsFor's own docstring); ORD's network reaches `us` on every build (it IS the
# conterminous panel), so this is the check that would catch a basemap import wired to the
# wrong module, a `basemapPathsFor` call passed the wrong panel list, or an artifact
# regenerated to empty strings -- none of which any check above this line would fail against.
check     "airport map: the us panel's coastline reaches the served bytes" "$BODY" \
  'data-panel="us"'
# `data-name="AK"` specifically (not just `data-panel="ak"`): ORD's network reaches the ak
# INSET (already proven by the "ALASKA" label check above), and this proves the inset frame
# is not merely drawn EMPTY under that label -- Alaska's own coastline path is really there.
check     "airport map: Alaska's own coastline path reaches the served bytes" "$BODY" \
  'data-name="AK"'
# The window this map drew, stated in words on the map itself (networkMap.ts's own `body +=
# ... input.window ...` line) -- not just in the aria-label, mirroring the aircraft-mix chart's
# `chartWindow` line one panel over. ORD's default view draws the trailing 12, matching the
# table above it (M7 Task 9's `mapWindowLine`, page.tsx).
check     "airport map: the window is stated in words" "$BODY" \
  'map: trailing 12 months, matching the table above'

# The year track's own link to a specific calendar year -- the element a visitor actually
# clicks, not just the year NUMBER (`>2019<`, already checked against SEA above and satisfied
# by inert text with no link at all). `href`, on ORD specifically, so this section's checks
# never depend on the SEA-only ones above having run first.
check     "airport map: the year track links to ?y=2019" "$BODY" 'href="/airport/ORD?y=2019"'

# The cache-header pair this task's own mutant table exists to prove, repeated against ORD
# because the SEA-only checks above (M7 Task 9) never curled the map path at all -- a regression
# scoped to the map's own data fetch (fetchAirportNetwork) could leave every SEA check green.
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/airport/ORD?y=2019")
check     "airport map ?y=2019: a valid year gets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/ORD?y=nonsense")
check     "airport map ?y=nonsense: malformed input is no-store"            "$HDRS" "no-store"
check_not "airport map ?y=nonsense: ...and is never long-cached"           "$HDRS" "s-maxage"
BODY=$(curl -s --max-time 15 "${BASE}/airport/ORD?y=nonsense")
check     "airport map ?y=nonsense: names the offending year" "$BODY" "unknown year 'nonsense'"

# 10b. The Pacific panels' coastline (#111). Before this block `grep -in "pac" app/smoke.sh`
# returned two COMMENTS and zero checks -- so the one thing a unit test structurally cannot
# see (that the committed generated artifact's paths reach the SERVED bytes) had no coverage
# at all on the panels that were about to change. ORD's own `data-panel="us"` check above
# exists for exactly this reason and says so; this is its Pacific half.
#
# /airport/GUM is the subject: its trailing-12 network reaches `pac` (SPN, ROP), `hi` (HNL)
# and `us` (SFO). Needles measured against a real served build, not copied from source --
# `data-panel="pac"` occurs twice (the GU path and the MP path) and `MARIANAS` twice (the
# `<text>` label, plus the RSC payload's copy, which escapes the SVG string's own angle
# brackets but not the plain word between them -- see the ALASKA comment above).
BODY=$(curl -s --max-time 30 "${BASE}/airport/GUM")
check     "airport map GUM: the network SVG is in the served HTML" "$BODY" \
  '<svg viewBox="0 12 960 532" width="960" height="532" role="img"'
# The label, not just the frame: `pac` was "PACIFIC" until #111 split American Samoa and
# Midway into their own panels, at which point a panel holding only the Marianas could not
# keep a name that also covers the two panels beside it.
check     "airport map GUM: the Marianas inset is labelled for what it holds" "$BODY" 'MARIANAS'
# Both `data-name`s, not just the panel attribute. MP is a 6-ring MultiPolygon and GU a single
# polygon; a regression dropping one feature while keeping the other would pass a check that
# only looked for `data-panel="pac"`.
check     "airport map GUM: Guam's own coastline reaches the served bytes"    "$BODY" 'data-name="GU"'
check     "airport map GUM: the Northern Marianas coastline reaches the bytes" "$BODY" 'data-name="MP"'
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/airport/GUM")
check     "airport map GUM: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

# The other two Pacific panels, and the one gap left. Dataset-pinned as a block: MDY has
# EXACTLY ONE filing in the whole window (MDY-HNL, HA, 2021-09, 278 seats), so a BTS revision
# that dropped it would take `nwhi` off this page entirely -- which is a real signal, not
# noise, but it is a claim about the dataset rather than about the build.
BODY=$(curl -s --max-time 30 "${BASE}/airport/HNL?y=2021")
check_dataset check     "airport map HNL 2021: American Samoa is labelled"   "$BODY" 'AMERICAN SAMOA'
check_dataset check     "airport map HNL 2021: its coastline reaches the bytes" "$BODY" 'data-name="AS"'
check_dataset check     "airport map HNL 2021: the Midway inset is labelled" "$BODY" 'MIDWAY'
# The paired positive for the check_not below is the four checks above, on this same body --
# an empty body would fail them, so the negative cannot pass vacuously. `nwhi` is the one panel
# with a frame and no coastline: Natural Earth carries Midway only inside a feature that also
# spans the Caribbean (build-basemap.mjs's header). If it ever gains geometry, this check and
# the caption check below must BOTH be rewritten -- they are two halves of one claim.
check_dataset check_not "airport map HNL 2021: Midway genuinely has no coastline" "$BODY" 'data-panel="nwhi"'
# CLAUDE.md: a correction is not landed until the user-facing copy carries it. This is the
# only served-build coverage the caption has. ASCII prefix only -- the sentence continues into
# a U+2014 em dash, which React emits raw from a JS string literal.
check_dataset check     "airport map HNL 2021: the Midway gap is disclosed on the page" "$BODY" \
  'The Midway inset has no coastline under its arcs'
# And the page that would have LOST ITS OWN SUBJECT. Baking a `pac` fit takes `pac` off
# networkMap.ts's subject-derived fallback; folding Midway in with it would project MDY to
# (1367.6, -429.7), off the canvas, so /airport/MDY?y=2021's origin disc would simply not
# be drawn while the caption still said only the landmass was missing. The origin disc is
# r="4.5" (segmentMap.ts) and its cx/cy are asserted EXACTLY: a presence check on `<circle`
# passes under that bug, since the destination dot is still emitted.
#
# `cy` moved 430.0 -> 474.0 with #122's tray: `nwhi` has no coastline, so its fit is
# subject-derived and centres Midway in the frame -- move the frame 44px down and the disc
# follows it exactly. Re-measured off a served build, not adjusted by arithmetic.
BODY=$(curl -s --max-time 30 "${BASE}/airport/MDY?y=2021")
check_dataset check     "airport map MDY 2021: Midway's own origin disc is inside its inset" "$BODY" \
  '<circle cx="388.0" cy="474.0" r="4.5"'

# 10c. #114 -- a route pair whose every filing was quarantined is COUNTED, never drawn as zero.
#
# Every measure is `SUM(x) FILTER (WHERE NOT is_quarantined)`, so such a pair sums to NULL, and
# `?? 0` used to turn that into an ordinary arc reading 0 seats and 0 departures -- drawn dotted
# and muted below DEPARTURE_FLOOR, which SAYS "barely flown" about a pair the data cannot
# describe. Worse than unsupported: all 11 such pairs over the trailing 12 are quarantined
# `zero_seats`, meaning the aircraft PERFORMED a departure and filed no seats, so the drawn
# "0 departures" contradicted the filing behind it.
#
# DATASET-PINNED as a block. These are small Alaskan pairs and a BTS revision can move them --
# which is a real signal (the quarantine set changed), not noise. If this block reddens, re-derive
# the wholly-quarantined pairs at route grain before touching a needle; docs/data/invariants.md
# § A wholly-quarantined group sums to NULL carries the query and the current measurement.

# Bettles: 16 route-grain rows over the trailing 12, one of them the wholly-quarantined BTT-UMT.
BODY=$(curl -s --max-time 30 "${BASE}/airport/BTT")
check_dataset check "airport BTT: the network SVG is in the served HTML" "$BODY" \
  '<svg viewBox="0 354 960 190" width="960" height="190" role="img"'
# A COUNT, not a presence check, for the reason ORD's 273 gives one section up: presence cannot
# distinguish "the quarantined pair was excluded" from "it was drawn as zero". 15 arcs reach the
# renderer and one is same-airport, so 14 polylines are drawn; before #114 it was 15.
check_dataset check_re "airport BTT: exactly 14 polylines (the quarantined pair is not one)" \
  "$(count "$BODY" '<polyline')" '^14$'
# The disclosure a sighted reader actually sees -- rendered as HTML beneath the map, not only in
# the aria-label. The em dash is U+2014 written LITERALLY: NetworkMap.tsx builds this from a JS
# string, so React emits the raw code point and a needle copied off an `&mdash;` could never fire.
check_dataset check "airport BTT: the quarantined pair is disclosed with a count and a reason" \
  "$BODY" '1 quarantined route not drawn — failed an invariant, never clamped.'

# Kantishna: the case the disclosure exists for. A18's ENTIRE trailing-12 network is one
# wholly-quarantined pair, so there is nothing to draw and everything to say -- and `sitemap.ts`
# lists it, because A18 is one of four airports that resolve only via quarantined rows. Before
# #114 this page's single arc was the fabricated one.
BODY=$(curl -s --max-time 30 "${BASE}/airport/A18")
check_dataset check "airport A18: the map still renders with nothing drawable" "$BODY" \
  '<svg viewBox="0 354 960 190" width="960" height="190" role="img"'
check_dataset check_re "airport A18: draws no arc at all" "$(count "$BODY" '<polyline')" '^0$'
check_dataset check "airport A18: and still says why the map is empty" "$BODY" \
  '1 quarantined route not drawn'
# The pair's far endpoint must not appear as a destination label -- that is the fabricated arc
# coming back, and it is the one thing the polyline count alone would not name.
check_dataset check_not "airport A18: no destination label for the undrawable pair" "$BODY" '>LMA<'

# #123, ON THE SURFACE IT WAS REPORTED ON. Two symptoms of one cause, and both are things only a
# served build can show: the rail is composed by a Server Component and the canvas size is
# decided inside the SVG string, so a unit test sees each in isolation and neither in the page.
#
# 1. THE RAIL MUST NOT EXPLAIN A CHART THAT WAS NOT DRAWN. A18 has exactly one filed month, so
#    `AircraftMixChart` takes its `plot === null` branch and prints a line of text -- while the
#    legend rail rendered the two gauge swatches and the COVID-window sentence beside it. Both
#    needles are NEGATIVE, because the positive form ("the group is present") passes under the
#    bug; the positive control is on ORD below, where a chart genuinely draws.
#    Written in the bytes React EMITS: both strings are plain ASCII in the source with no entity
#    and no apostrophe, so they survive JSX compilation unchanged -- checked against the served
#    page, where they occur 0 times here and twice on ORD (once in the HTML, once in the RSC
#    payload, the same doubling every other text needle in this file sees).
check_dataset check_not "airport A18: no fleet-shading rail group, because no chart was drawn" \
  "$BODY" 'Fleet shading'
check_dataset check_not "airport A18: and no COVID-window sentence about a ramp that is not there" \
  "$BODY" 'COVID is in the window on purpose'
# THE SAME RULE, ON THE GROUP NEXT DOOR. Every row of "Arc rendering" describes an ARC, and this
# page draws none -- a hub map still paints its origin disc, so "a map rendered" is the wrong gate
# there too. The MAP itself must stay: it carries the quarantine disclosure this whole block exists
# for, so the repair is to drop the group, never the map.
check_dataset check_not "airport A18: no arc-rendering rail group either, because no arc was drawn" \
  "$BODY" 'Arc rendering'
# NOT VACUOUS: the rail is mounted and carries the groups this page genuinely earns -- a rail
# that failed to render at all would satisfy all three negatives above. `Gauge rail` is
# unconditional and its axis IS drawn here (tickless, since the one row's gauge is unknowable).
check_dataset check "airport A18: the rail is still mounted, with the groups the page does earn" \
  "$BODY" 'Gauge rail'

# 2. THE CANVAS IS CROPPED TO THE PANELS THAT CARRY POINTS. A18's network is entirely Alaskan,
#    so the conterminous panel is not in the picture: the viewBox needle above reads
#    `0 354 960 190` against the `0 12 960 532` a conterminous page serves -- an Alaska-only
#    network must not spend the lower 48's height on blank canvas above a small ALASKA inset,
#    which is what #124 reported and #123 absorbed. Asserted as the HEIGHT
#    ATTRIBUTE as well, because that is the byte the browser lays the element out from
#    (`globals.css` gives `.map svg` `height: auto`, so the intrinsic ratio is what decides how
#    much vertical space the page spends).
check_dataset check "airport A18: the canvas is cropped to the Alaska band, not the full 500" \
  "$BODY" 'height="190"'
check_dataset check_not "airport A18: the old full-canvas height is gone" "$BODY" 'height="500"'

# #122, ON A SERVED PAGE, AND THE FIXTURE IS THE DEFECT ITSELF. The Caribbean inset's frame used
# to be drawn over the bottom-right of the conterminous panel, so 17 fact-present `us` airports
# projected inside a box labelled CARIBBEAN -- 12 Florida, 5 south Texas. MIA was one of them,
# and `/airport/MIA` is the page that shows it: MIA files real Puerto Rico service, so its
# network reaches `car` and the frame is actually drawn, which is the condition the defect needs.
# A page that never draws the frame (`/airport/EYW` -- no `car` pairing in any year) cannot fail
# this way, which is why the subject is MIA and not the southernmost airport.
#
# THE FRAME'S OWN RECT, read off the served bytes: `renderMapCore` emits it at rect +/- 6, so
# `PANEL_RECTS.car`'s y of 436 is drawn at 430. MIA's subject disc is at cy="401.0" -- 29px
# ABOVE that edge. Both needles together are the claim; the frame check alone would pass on a
# page that drew no map at all, and the disc check alone would pass if the frame moved off
# somewhere absurd.
BODY=$(curl -s --max-time 30 "${BASE}/airport/MIA")
check_dataset check "airport MIA: the CARIBBEAN inset is drawn, so the overlap is testable here" \
  "$BODY" '<rect x="418" y="430" width="308" height="88"'
check_dataset check "airport MIA: and the subject disc sits above that frame, not inside it" \
  "$BODY" '<circle cx="708.4" cy="401.0" r="4.5"'



# The negative, on a clean network. `quarantined route` is the needle and the stem matters: this
# page ALREADY says "N quarantined rows excluded from these totals" in the endpoints table, so a
# `quarantin` needle would match that and report a silent ok forever -- the exact class of
# self-defect app/smoke.sh has shipped three times. Paired with the ORD checks above on this same
# path, so it cannot pass vacuously against an empty body.
BODY=$(curl -s --max-time 30 "${BASE}/airport/ORD")
check     "airport ORD: says nothing about quarantined ROUTES on a clean network" "$BODY" \
  'quarantined row'
check_not "airport ORD: ...and states no quarantined-route disclosure"            "$BODY" \
  'quarantined route'

# 10d. #118 -- the same NULL, one surface over: the endpoints TABLE and the stat strip.
#
# 10c above proves the MAP excludes a wholly-quarantined pair. The table below it was still
# applying `?? 0` to the identical FILTERed sums, so on A18 the map correctly said "1 quarantined
# route not drawn" while the table underneath it reported the same filing as 0 seats and 0
# departures. Both halves of one page, disagreeing.
#
# A18 (Kantishna) is the whole-page case: ONE row in the entire dataset -- 2025-06, op_airline
# 20333, seats 0.0, departures_performed 1.0, quarantined `zero_seats`, with A18 as the
# DESTINATION -- so its only table row and its stat strip are both unknowable.
#
# THE SEQUENCE IS THE NEEDLE, NOT THE DASH. `<td class="num">—</td>` is ALREADY served by the
# buggy page: load factor and average gauge have zero denominators and render `—` either way, so
# a bare em-dash needle here would print ok forever against a page reading "0 / 0 / 0 / — / —".
# Only the position of each dash separates the two. Verified by mutation on a served build
# (restore `?? 0`, rebuild): this needle reddens, the two below it redden, the gutter one does not.
# The dash is U+2014 written LITERALLY -- lib/format.ts's DASH is a JS string, so React emits the
# raw code point, and a needle copied off an `&mdash;` could never fire.
#
# DATASET-PINNED as a block, for 10c's reason: a BTS revision that un-quarantines A18 must redden
# this rather than silently stop testing anything. docs/data/invariants.md
# § A wholly-quarantined group sums to NULL carries the query and the current measurement.
BODY=$(curl -s --max-time 30 "${BASE}/airport/A18")
check_dataset check "airport A18: every measure cell is absence, in order" "$BODY" \
  '<td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>'
check_dataset check_not "airport A18: no measure cell is a fabricated zero" "$BODY" \
  '<td class="num">0</td>'
# The stat strip, fed by the same fold one level up. Its COUNTS are real facts about what was
# filed and must survive -- a page that blanked those too would pass the check_not vacuously.
check_dataset check_not "airport A18: nor is the stat strip a fabricated zero" "$BODY" \
  '<div class="v">0</div>'
check_dataset check "airport A18: the strip still counts the carrier that filed" "$BODY" \
  '<div class="k">Carriers</div><div class="v">1</div>'
# The dash says nothing can be stated; the gutter says why. /airport rebuilds its rows in
# TypeScript rather than handing DataTable a raw pivot row, so unlike the other four table
# surfaces it carries `quarantine_reasons` through deliberately -- drop that and the title
# silently degrades to the generic label while every other needle here stays green.
check_dataset check "airport A18: the gutter carries the quarantine reason, not just the glyph" \
  "$BODY" 'title="Quarantined — failed an invariant: zero_seats"'

# THE PROSE THAT EXPLAINS THE DASHES, in the served bytes. Design review found the foot claiming
# the quarantined row was "excluded from these totals" on a page whose totals are entirely em
# dashes -- and whose Carriers and Destinations counts are counts OF that row, not figures net of
# it. Built as ONE template literal in page.tsx so a raw-bytes grep can reach it: React's SSR puts
# `<!-- -->` between adjacent expression children, which `textContent` skips and this does not.
check_dataset check "airport A18: the foot explains the dashes instead of miscounting them" \
  "$BODY" 'Every filing at A18 in this window is quarantined'
# /airport states TWO counts, so its tail is the plural one -- the single place the shared clause
# genuinely varies between pages, and therefore the one worth pinning in the served bytes.
check_dataset check "airport A18: ...and its tail names both counts" "$BODY" \
  'The carrier and destination counts are counted from those rows, not net of them.'
check_dataset check_not "airport A18: ...and does not claim the counts are net of an exclusion" \
  "$BODY" 'excluded from these totals'
# `1 destination`, singular, on the only prose left explaining five em dashes. The other half of
# this same sentence has always agreed with its count.
check_dataset check_not "airport A18: the foot agrees with its own count on the plural" \
  "$BODY" '1 destinations'

# THE OTHER ABSENCE, and the branch this round's regression actually came from. 05A is
# fact-present but filed NOTHING in the trailing 12, so its sums are unknowable for a reason
# quarantine had no part in -- 290 airports are in that state against A18's 3. Every defect this
# page's fixes chased was a consumer keying on "the sum is null" and answering the wrong one of
# the two: the card said `Quarantined 0`, the foot claimed rows were "excluded from these totals"
# that never existed, and the legend named quarantine as the cause. Unit and page tests covered
# it; nothing served did, on a page whose whole class of bug this file exists to catch.
BODY=$(curl -s --max-time 30 "${BASE}/airport/05A")
check_dataset check "airport 05A: an unfiled window is unknowable, not zero traffic" "$BODY" \
  '<div class="k">Seats</div><div class="v">—</div>'
# The counts are not measures: zero carriers filed is a fact. Blanking them alongside the sums
# would be the mirror image of the defect this whole change refuses.
check_dataset check "airport 05A: the counts are still stated" "$BODY" \
  '<div class="k">Quarantined</div><div class="v">0</div>'
check_dataset check "airport 05A: names which absence it is" "$BODY" 'No filings at'
# The foot must claim NO exclusion here -- there is nothing to have been excluded from, and
# nothing was quarantined. Both needles are served by A18 and by SEA, so neither is vacuous.
check_dataset check_not "airport 05A: claims no exclusion that never happened" "$BODY" \
  'excluded from these totals'
check_dataset check_not "airport 05A: and does not blame quarantine" "$BODY" 'quarantined row'

# The negative, on a page with real traffic: SEA must NOT have acquired em-dash measure cells.
# Paired with SEA's own 53,372,100 check above so it cannot pass against an empty body.
BODY=$(curl -s --max-time 30 "${BASE}/airport/SEA")
check     "airport SEA: a healthy page states figures, not absence" "$BODY" \
  '<td class="num">'
check_not "airport SEA: no measure row is wholly unknowable" "$BODY" \
  '<td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>'

# 10e. #121 -- the SAME NULL, on the three pages /airport is not: the stat strip and the card on
# /route, /carrier and /aircraft, whose totals come from `sumTotals` rather than `airportTotals`.
#
# 10c proved the MAP excludes a wholly-quarantined pair and 10d proved the TABLE and strip do on
# /airport. `sumTotals` was still applying `?? 0` inside a `+` fold, so on /route/A18-LMA the
# table cell correctly rendered an em dash while the stat strip directly above it -- summing the
# very same NULL -- reported 0 seats and 0 departures. Both halves of one page, disagreeing,
# exactly as /airport's map and table did before #118.
#
# THE ORDER OF THE STRIP IS THE NEEDLE, NOT THE DASH. Load factor and average gauge have zero
# denominators here and rendered an em dash under the bug TOO, so a bare `<div class="v">—</div>`
# needle prints ok forever against a page reading `0 · 0 · — · — · 0`. Only the first five ALL
# being dashes separates the two. The dash is U+2014 written LITERALLY: lib/format.ts's DASH is a
# JS string, so React emits the raw code point and a needle copied off an `&mdash;` could never
# fire. Same for the EN dash U+2013 in the route title below, which `routeTitle` produces.
#
# DATASET-PINNED as a block, for 10c's reason: a BTS revision that un-quarantines these must
# redden this rather than silently stop testing anything. docs/data/invariants.md
# § A wholly-quarantined group sums to NULL carries the query and the current measurement.

# A18-LMA (Kantishna-Lake Minchumina): ONE filing in the whole trailing 12 -- 2025-06, seats 0
# against 1 PERFORMED departure, quarantined `zero_seats`. One of the 10 reachable route pages.
BODY=$(curl -s --max-time 30 "${BASE}/route/A18-LMA")
check_dataset check "route A18-LMA: the five measures are absence, in order" "$BODY" \
  '<div class="v">—</div></div><div class="stat"><div class="k">Passengers</div><div class="v">—</div>'
check_dataset check "route A18-LMA: departures is absence, not a fabricated zero" "$BODY" \
  '<div class="k">Departures</div><div class="v">—</div>'
# The COUNTS are real facts about what was filed and must survive -- a page that blanked those
# too would pass the check_not below vacuously.
check_dataset check "route A18-LMA: the strip still counts the carrier that filed" "$BODY" \
  '<div class="k">Carriers</div><div class="v">1</div>'
check_dataset check "route A18-LMA: ...and still counts the quarantined row" "$BODY" \
  '<div class="k">Quarantined</div><div class="v">1</div>'
check_dataset check_not "route A18-LMA: no measure in the strip is a fabricated zero" "$BODY" \
  '<div class="v">0</div>'
# THE PROSE THAT EXPLAINS THE DASHES. "1 quarantined row excluded from these totals" is a
# compound claim whose second clause is false here: there are no totals to have been excluded
# from, and Carriers is a count OF the excluded row. Built as ONE template literal in page.tsx so
# this raw-bytes grep can reach its PREFIX. Narrowly: React's SSR emits `<!-- -->` between
# ADJACENT expression children, so `{n} quarantined row{s}` was unreachable; the tail
# " excluded from these totals, never clamped." was a single static JSX child and always was
# greppable. The rewrite is still right -- half a sentence is not a needle.
check_dataset check "route A18-LMA: the foot explains the dashes instead of miscounting them" \
  "$BODY" 'Every filing on A18–LMA in this window is quarantined'
# THE TAIL, which is the half that says what the numbers that SURVIVE actually mean -- and the
# half nothing checked until review pointed out that garbling it left every gate green. The
# opening clause alone does not make the sentence honest: "Carriers 1" above five em dashes is
# derived FROM the quarantined rows, not a count OF them.
check_dataset check "route A18-LMA: ...and says what the surviving counts mean" "$BODY" \
  'so no measure above can be summed. The carrier count is counted from those rows, not net of them.'
check_dataset check_not "route A18-LMA: ...and claims no exclusion that could not have happened" \
  "$BODY" 'excluded from these totals'
check_dataset check_not "route A18-LMA: the foot agrees with its own count on the plural" \
  "$BODY" '1 rows, each having failed'

# THE OTHER ABSENCE. ATL-CAK filed 67 months and nothing since 2022-06; 12,115 route pairs are in
# that state, against the 10 above. Quarantine had no part in it, and a surface keying on "the sum
# is null" alone answers the wrong one of the two -- on the 12,115 rather than the 10.
BODY=$(curl -s --max-time 30 "${BASE}/route/ATL-CAK")
check_dataset check "route ATL-CAK: an unfiled window is unknowable, not zero traffic" "$BODY" \
  '<div class="k">Seats</div><div class="v">—</div>'
check_dataset check "route ATL-CAK: the counts are still stated" "$BODY" \
  '<div class="k">Quarantined</div><div class="v">0</div>'
check_dataset check "route ATL-CAK: names which absence it is" "$BODY" 'No scheduled service'
check_dataset check_not "route ATL-CAK: claims no exclusion that never happened" "$BODY" \
  'excluded from these totals'
check_dataset check_not "route ATL-CAK: and does not blame quarantine" "$BODY" 'is quarantined'
# The derived-measure disclosure is a CLAUDE.md hard rule and must survive an empty clause -- the
# quarantine sentence and this one share a paragraph.
check     "route ATL-CAK: still labels the derived measures as computed" "$BODY" 'never averaged'

# /aircraft, the grain issue #121 never measured: BTS 201 has no un-quarantined filing in the
# window either (F4, 2025-08, 5 performed departures against 0 seats), so the footprint is 12
# reachable pages and not the 10 the issue states.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/TRISLNDR")
check_dataset check "aircraft TRISLNDR: seats is absence, not a fabricated zero" "$BODY" \
  '<div class="k">Seats</div><div class="v">—</div>'
check_dataset check "aircraft TRISLNDR: departures is absence too" "$BODY" \
  '<div class="k">Departures</div><div class="v">—</div>'
check_dataset check "aircraft TRISLNDR: the strip still counts the quarantined rows" "$BODY" \
  '<div class="k">Quarantined</div><div class="v">2</div>'
check_dataset check_not "aircraft TRISLNDR: no measure in the strip is a fabricated zero" "$BODY" \
  '<div class="v">0</div>'
check_dataset check "aircraft TRISLNDR: the foot explains the dashes" "$BODY" \
  'Every filing on the TRISLNDR in this window is quarantined'
# The same tail, on the grain that DISPROVED the original wording: this page renders
# "Carriers 1 · Quarantined 2", so "the carrier count is a count of those rows" was 1 = 2.
# /airport never surfaced it -- A18, JZM and OQZ are each 1 row, 1 carrier, 1 destination, and so
# are all ten route pages, which makes the false sentence numerically indistinguishable there.
check_dataset check "aircraft TRISLNDR: ...and its counts are derived, not equal" "$BODY" \
  'The carrier count is counted from those rows, not net of them.'
check_dataset check_not "aircraft TRISLNDR: the foot does not equate the two counts" "$BODY" \
  'is a count of those rows'
check_dataset check_not "aircraft TRISLNDR: ...and claims no exclusion" "$BODY" \
  'excluded from these totals'

# /carrier can reach only the OTHER absence: no carrier's every trailing-12 filing is quarantined
# on this warehouse. VX has been dormant since 2018-03. 45 `airline_id`s are; 44 of them have a
# page. This is a page-grain sentence, so 44 is its number.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/VX")
check_dataset check "carrier VX: an unfiled window is unknowable, not zero traffic" "$BODY" \
  '<div class="k">Seats</div><div class="v">—</div>'
check_dataset check "carrier VX: the counts are still stated" "$BODY" \
  '<div class="k">Quarantined</div><div class="v">0</div>'
check_dataset check_not "carrier VX: claims no exclusion that never happened" "$BODY" \
  'excluded from these totals'
check_dataset check_not "carrier VX: and does not blame quarantine" "$BODY" 'is quarantined'

# QUARANTINE BESIDE REAL TRAFFIC, which is what makes the clause's second operand undeletable.
# Wright Air Service filed 118 quarantined rows in this window AND stateable traffic on 3 aircraft
# types. Its figures are honest and its foot must claim the ordinary exclusion.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/8V")
check_dataset check "carrier 8V: quarantined rows beside real traffic keep the ordinary clause" \
  "$BODY" '118 quarantined rows excluded from these totals'
check_dataset check_not "carrier 8V: ...and are not reported as a wholly-quarantined page" "$BODY" \
  'is quarantined —'

# The negatives, on pages with real traffic. Without these every check_not above could pass
# against a page that had stopped rendering a stat strip at all.
BODY=$(curl -s --max-time 30 "${BASE}/route/JFK-LAX")
check     "route JFK-LAX: a healthy page states figures, not absence" "$BODY" \
  '<div class="k">Seats</div><div class="v">'
check_not "route JFK-LAX: its seats are not an em dash" "$BODY" \
  '<div class="k">Seats</div><div class="v">—</div>'
check     "route JFK-LAX: and its foot claims the ordinary exclusion" "$BODY" \
  'excluded from these totals'

# 10f. #121, second half -- the CHART. The stat strip and the card were the first half; the
# stacked area above them was still coercing the identical NULL.
#
# `fetchAircraftMix` applied `?? 0` to `SUM(x) FILTER (WHERE NOT is_quarantined)`, so a
# (month, band) cell whose every filing failed an invariant was drawn as a zero-height band --
# "this type flew nothing that month", invented from a value nobody has, on the one surface whose
# entire gap treatment exists to refuse exactly that. Same defect #114 fixed on the map and #118
# on the table.
#
# TWO SHAPES, TWO SENTENCES, and the two fixtures below are chosen so each carries exactly ONE of
# them and therefore disproves the other two needles:
#   DFW-SJU  1 wholly-quarantined month (2020-05, a single B787-9 cell), 0 gaps, 0 understated
#   HNL-OGG  11 understated months (the ATR-72 quarantined beside real traffic), 0 of the others
# A single fixture carrying both counts could not tell a merged sentence from two separate ones,
# which is the whole property under test.
#
# THE WORDING IS THE NEEDLE. "with no filings" is FALSE of a month that was filed and wholly
# quarantined, and both are false of a month that is drawn but understated -- so a merged
# "N months not drawn" would be true of none of the three. These strings are written in the bytes
# React EMITS: they carry no entity, apostrophe or angle bracket, and the em dash in the
# unknowable sentence is U+2014 written literally, since `mixPlotConfig.ts` builds it as a JS
# string and React emits the raw code point.
#
# DATASET-PINNED as a block, for 10c's reason: a BTS revision that un-quarantines these cells must
# redden this rather than silently stop testing anything.
BODY=$(curl -s --max-time 30 "${BASE}/route/DFW-SJU")
check_dataset check "route DFW-SJU: names a filed-but-quarantined month as filed" "$BODY" \
  '1 month filed but wholly quarantined'
check_dataset check "route DFW-SJU: ...and says why the stack cannot be drawn there" "$BODY" \
  'every filing failed an invariant, so the stack cannot be drawn there'
# The false sentence, which the pre-#121 code would have printed for this month.
check_dataset check_not "route DFW-SJU: does not call a filed month unfiled" "$BODY" \
  'month with no filings'
check_dataset check_not "route DFW-SJU: and does not call it understated -- nothing is drawn" \
  "$BODY" 'month understated'
# In the aria-label too, not only on the key: `role="img"` means the label is the ONLY thing a
# screen reader is given, so a sentence missing there is a hole for every non-sighted reader.
check_dataset check "route DFW-SJU: the screen reader is told the same thing" "$BODY" \
  'aria-label="Stacked area'
check_dataset check_re "route DFW-SJU: ...including the quarantine sentence" \
  "$(printf '%s' "$BODY" | grep -o 'aria-label="Stacked area[^"]*"')" 'filed but wholly quarantined'

BODY=$(curl -s --max-time 30 "${BASE}/route/HNL-OGG")
check_dataset check "route HNL-OGG: discloses the months its stack understates" "$BODY" \
  '11 months understated'
# The note names the MARK, not just a total. A stacked area's y is cumulative, so an unstateable
# cell inside a DRAWN month cannot be holed -- it is painted at zero height, and 249 of the 420
# such cells belong to a top-five MEMBER band across 87 pairs. A reader watching the ATR-72 band
# flatten on 2020-07 can only recover that from this sentence, so it has to describe the mark.
check_dataset check "route HNL-OGG: ...and says what the mark actually is" "$BODY" \
  'a quarantined filing is drawn at zero height there, so its band flattens'
check_dataset check "route HNL-OGG: ...and that the stack understates the month" "$BODY" \
  'the stack is lower than the real total by an amount that cannot be stated'
check_dataset check_not "route HNL-OGG: an understated month is not a gap" "$BODY" \
  'month with no filings'
check_dataset check_not "route HNL-OGG: nor is it wholly quarantined" "$BODY" \
  'wholly quarantined'

# THE 100% CASE, and the one the disclosure could not reach at all. BGR-DAB filed two months,
# 2020-08 and 2020-09, and BOTH are wholly quarantined. `prepareMixPlot` gated on every FILED
# month while the axis was built from the STATEABLE ones, so this passed a `>= 2` gate and
# rendered a frame carrying the COVID band, ZERO `<path>` elements, and an aria-label naming a
# band ("SF-340/B") drawn nowhere -- under a DATA AS OF badge, with no sentence explaining any of
# it. The maximum case for the sentence, and the one case it printed nothing.
BODY=$(curl -s --max-time 30 "${BASE}/route/BGR-DAB")
check_dataset check "route BGR-DAB: states the finding in words instead of drawing a blank frame" \
  "$BODY" '2 months of filings in this window, every one wholly quarantined'
check_dataset check "route BGR-DAB: ...and says why nothing can be drawn" "$BODY" \
  'every filing failed an invariant, so no aircraft-type seats can be stated'
# The two sentences that would be FALSE here: filings exist, so "no filings" is wrong, and there
# are two of them, so "only one month" is wrong. Both are strings this same function can return.
check_dataset check_not "route BGR-DAB: does not claim nothing was ever filed" "$BODY" \
  'No aircraft-type filings in this window'
check_dataset check_not "route BGR-DAB: nor that only one month was filed" "$BODY" \
  'Only one month of filings'
# No frame, so no band may be announced to a screen reader.
check_dataset check_not "route BGR-DAB: announces no band it never drew" "$BODY" \
  'Bands lightest to darkest'

# THE AXIS MUST COVER THE WINDOW EVERY SENTENCE AROUND IT NAMES. Plot infers its x domain from
# the marks, and since the quarantine fix the marks carry only DRAWABLE months -- while the
# window line, the aria-label and both absence counts all name first->last FILED month. Those
# were the same range until a wholly-quarantined month stopped being plotted.
#
# LIT-MOB is filed 2017-05 -> 2024-08 but drawable only to 2019-06, its 2024-08 being wholly
# quarantined. Before the domain was pinned this page said `chart: 2017-05 → 2024-08` over an
# axis whose last tick was 2021 -- and the 2021 came from the COVID rect stretching the frame,
# the very thing that rect's clamp exists to prevent. 38 of its 85 claimed gap months, and the
# quarantined month itself, were three years off the right edge. 43 of 16,694 drawn route pairs
# diverged this way. docs/design/system.md states the invariant verbatim.
BODY=$(curl -s --max-time 30 "${BASE}/route/LIT-MOB")
check_dataset check "route LIT-MOB: the window line names the filed range" "$BODY" \
  'chart: 2017-05 → 2024-08'
# The tick that only exists once the domain is pinned: under the inferred domain the axis stopped
# at 2021, so no 2024 tick was emitted at all. `>2024<` is a tick label specifically -- the window
# line and the aria-label both spell the month as `2024-08`, so neither can satisfy this.
check_dataset check "route LIT-MOB: ...and the axis actually reaches it" "$BODY" '>2024<'
check_dataset check "route LIT-MOB: ...with the years between it drawn too" "$BODY" '>2022<'
# The month the legend claims, now inside the frame it is claimed for.
check_dataset check "route LIT-MOB: the quarantined month it names is on the axis" "$BODY" \
  '1 month filed but wholly quarantined'

# The negative, on a route with nothing quarantined anywhere in its window. Without it every
# check_not above could pass against a chart that had stopped printing its key.
BODY=$(curl -s --max-time 30 "${BASE}/route/JFK-LAX")
check     "route JFK-LAX: the chart key is still rendered" "$BODY" 'seats per departure'
check_not "route JFK-LAX: a clean chart claims no quarantined months" "$BODY" 'wholly quarantined'
check_not "route JFK-LAX: ...and none understated"                    "$BODY" 'months understated'

# 11. /carrier/<code> -- the page has to say what it is counting.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/DL")
check     "carrier: renders the code"        "$BODY" '>DL<'
check     "carrier: DATA AS OF is present"   "$BODY" 'DATA AS OF'
# The two standing caveats, in the served bytes. Both are built as SINGLE template literals in
# page.tsx precisely so a raw-bytes grep can find them: React's SSR emits `<!-- -->` between
# adjacent JSX expressions, which is M4c's window-line bug and would make them ungreppable here
# while every unit test (which reads textContent, skipping comment nodes) stayed green.
check     "carrier: states operating-carrier grain"  "$BODY" 'Operated, not marketed.'
check     "carrier: names the absent field"          "$BODY" 'no marketing-carrier field'
check     "carrier: states codes are current identity" "$BODY" 'current identity in BTS'
# Resolution, per M4a: the table's rows are aircraft types, so a real short name must render and
# the BTS code must not. `888` appears in this page's Explorer permalink; only a CELL is checked.
check     "carrier: renders a real aircraft short name" "$BODY" '>B737-9ER<'
check_not "carrier: renders no bare aircraft code"      "$BODY" '>888<'
# M5 "connect the graph": the fleet table's aircraft-type cells link out too (measured: DL
# flies 13,504,318 trailing-12 seats on B737-8, so this href is really on the page, not a
# fixture invented for the check).
check     "carrier: links an aircraft cell to /aircraft/B737-8" "$BODY" 'href="/aircraft/B737-8"'
check     "carrier: the chart SVG is in the served HTML" "$BODY" '<svg role="img"'
check     "carrier: ramp tokens reach the area fills (lightest)" "$BODY" '<path fill="var(--g0)" d='
check     "carrier: ramp tokens reach the area fills (darkest)"  "$BODY" '<path fill="var(--g5)" d='
check_dataset check "carrier: the page states the chart's own window" "$BODY" 'chart: the full window · 2015-01 → 2026-05'
# Final whole-branch review, M11 (third of four canonical checks -- see /route's own comment).
check     "carrier: carries a self-referential canonical link (Task 2)" "$BODY" \
  '<link rel="canonical" href="http://localhost:3000/carrier/DL"'

# ---- #110: the diff map's three small multiples, in the SERVED bytes ----
# Every needle below is written against what React EMITS, not what the source contains: the
# component writes U+2019/U+2014 literally for exactly this reason, and each needle sits inside
# ONE text node, never across a `{...}` boundary -- React's SSR puts `<!-- -->` between adjacent
# text nodes, which is how a greppable sentence stops being greppable while every unit test
# still passes (grainNote's comment on carrier/[code]/page.tsx carries the same rule).
check     "carrier: the diff map renders its panels" "$BODY" 'data-testid="diff-panel-label"'
# The `title` fix, live. Added and downgauged SHARE the trailing window, so without a per-panel
# title BOTH of these are the string `aria-label="Route map, 2025-06 → 2026-05.` -- byte-
# identical, and position is the only thing left telling them apart. Two needles, because that
# is the pair that collided.
check     "carrier: the added panel names itself and its carrier"      "$BODY" 'aria-label="DL added.'
check     "carrier: the downgauged panel does too, distinctly"         "$BODY" 'aria-label="DL downgauged.'
check     "carrier: the dropped panel names itself and its carrier"    "$BODY" 'aria-label="DL dropped.'
# The two honesty claims that exist nowhere else in the product, because no other surface knows
# this map is a diff. map_carrier_diff.sql: 3,640 of 5,959 dropped carrier-routes had another
# carrier flying the pair inside the trailing window; 4,691 of 8,357 added ones had filed that
# pair before the prior window.
check     "carrier: the diff map discloses the per-carrier grain" "$BODY" 'another carrier may still be flying it'
check     "carrier: the diff map says added is re-entry"          "$BODY" 're-entry, not first appearance'
check_not "carrier: the diff map claims nothing about the industry" "$BODY" 'nobody flew'
# The downgauged panel cannot render the ordering it was cut by, and says so. Without this a
# disclosure reading "400 of 512 routes drawn." is taken to mean the largest 400 ROUTES, which
# is not what the cut selects.
check     "carrier: the downgauged panel names its ranking key" "$BODY" 'by the fall in seats per departure'

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL")
check     "carrier: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

# 11b. #107 -- /carrier's network map, filtered by aircraft type. Every needle below was read
# out of a SERVED body, never copied from the JSX: this file has shipped three self-defects, one
# of them a needle carrying an entity that JSX had already decoded at compile time, so it printed
# `ok` unconditionally. The two anchors here are quoted verbatim from `curl` output.
#
# `<svg role="img"` is deliberately NOT the needle for the map. The aircraft-mix chart already
# emits it on this very page (checked above), so it is green whether or not a map renders --
# exactly the assertion-an-outcome-the-bug-also-produces shape. `data-testid="network-map"`
# discriminates. NOT `segment-map`, which names the shared component and matches #110's three
# diff panels on this same page -- so the positive check below would pass with the network map
# absent entirely, green off a string the diff map supplies. The needle names the ROLE.
check     "carrier: unfiltered renders the type picker"          "$BODY" 'data-testid="map-picker"'
check_not "carrier: unfiltered draws no arcs"                    "$BODY" 'data-testid="network-map"'
check_not "carrier: unfiltered offers no way to clear nothing"   "$BODY" '>Clear the filter</a>'

# The filtered view. `?type=` takes an aircraft SLUG, never the BTS id -- `proxy.ts` and
# `mapFilter.ts` agree on that and `?type=614` is refused.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/DL?type=B737-8")
check     "carrier?type: the map SVG is in the served HTML"      "$BODY" 'data-testid="network-map"'
check     "carrier?type: the picker marks the showing type"      "$BODY" '<a href="/carrier/DL?type=B737-8" aria-current="page">'
check     "carrier?type: offers the way back to the unfiltered page" "$BODY" '<a href="/carrier/DL">Clear the filter</a>'
check     "carrier?type: the map's disclosures render as HTML too"   "$BODY" 'data-testid="map-notes"'
# The cap sentence, which is the disclosure a reader needs and the one A13 warns is easy to
# assert vacuously: `not.toContain("not drawn")` cannot die, because "not drawn" belongs to the
# QUARANTINE sentence. This is the real cap wording, with both counts.
check_dataset check "carrier?type: states the cap it drew under" "$BODY" '400 of 519 routes drawn.'
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL?type=B737-8")
check     "carrier?type: a resolved filter stays cacheable"      "$HDRS" "$HTML_CACHE_EXPECTED"

# CE-180 names BTS codes 030 (CESSNA 180) and 031 (CESSNA 180A/B), both fact-present. The page
# refuses rather than picking one -- the silent-pick failure /carrier/PA exists to refuse -- and
# the refusal must not be a cacheable 200.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/DL?type=CE-180")
check_not "carrier?type: an ambiguous type draws no map"         "$BODY" 'data-testid="network-map"'
check     "carrier?type: ...names every holder instead"          "$BODY" 'data-testid="mp-holder"'
check     "carrier?type: ...and leaves the picker reachable"     "$BODY" 'data-testid="map-picker"'
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL?type=CE-180")
check     "carrier?type: an ambiguous filter is never cached"    "$HDRS" 'no-store'

# An unknown type is a DIFFERENT finding from an ambiguous one and is worded apart.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/DL?type=NOPE-1")
check_not "carrier?type: an unknown type draws no map"           "$BODY" 'data-testid="network-map"'
check     "carrier?type: ...and still offers the list"           "$BODY" 'data-testid="map-picker"'
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL?type=NOPE-1")
check     "carrier?type: an unknown filter is never cached"      "$HDRS" 'no-store'

# A type that RESOLVES for a carrier that never flew it: VX stopped filing in 2018-03, so the
# filter is `ok` and the map is null. Without this sentence the heading sits over a silent gap.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/VX?type=B737-8")
check_not "carrier?type: a carrier with no such filings draws no map" "$BODY" 'data-testid="network-map"'
check_dataset check "carrier?type: ...and says so, naming the window" "$BODY" 'VX filed no B737-8 routes in 2025-06 → 2026-05.'

# The other branch of the window line, and the negative half of the pair. VX (Virgin America)
# stopped filing in 2018-03; the chart is fetched over the full window and can only draw to
# there, so naming the REQUESTED window would put "the full window · … → 2026-05" over a chart
# that ends in 2018 -- M4c's bug, one page over. Both caveats render here too, with no table.
# #110: F4 (Air Flamenco, 21615) is the ONE carrier of 114 whose diff has a non-zero
# carrier-wide quarantine count and ZERO drawable arcs. A section gated on `panels.length` drops
# that count silently -- the "no trace that anything was there" the field exists to prevent --
# and no other carrier page can catch it. Dataset-pinned: the 3 is a measured count.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/F4")
check_not "carrier: F4 draws no diff panel"                    "$BODY" 'data-testid="diff-panel-label"'
check_dataset check "carrier: F4 still states what was withheld" "$BODY" '3 of F4’s route pairs are on no panel above'
check     "carrier: ...with the reason THIS exclusion has"     "$BODY" 'window that decides the category was wholly quarantined'

BODY=$(curl -s --max-time 30 "${BASE}/carrier/VX")
check     "carrier: a carrier that stopped filing names ITS range" "$BODY" 'chart: 2015-01 → 2018-03'
check_not "carrier: ...and does not claim the full window there"   "$BODY" 'chart: the full window'
check     "carrier: the caveats render without a table"            "$BODY" 'Operated, not marketed.'
check_not "carrier: a dormant carrier gets no diff section"       "$BODY" 'data-testid="diff-map"'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/carrier/dl")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/carrier/dl")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "carrier: lower-case code redirects"  "$CODE" '308'
check     "carrier: redirect targets canonical" "$LOC"  '/carrier/DL'
check     "carrier: 308 keeps the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

# ZZ is in dim_carrier not at all -- the MINORITY carrier 404 (114 of dim_carrier's 1,657
# distinct codes are fact-present; the other 1,543 land in PA's bucket below). PA (Pan American)
# is in dim_carrier three times over and has filed zero T-100 Segment rows.
#
# M5 Task 6 split resolveCarrier's 404 the way /route's and /airport's already were: "no such
# code" versus "a real, recognized carrier this dataset has no rows for" -- two DIFFERENT
# sentences now, not one generic phrase true of both, so each case below asserts its own phrase
# AND the absence of the sibling case's, the same discipline § 8/10 use above. (This block used
# to check both codes for the identical substring "no carrier with code '<C>' has filed", which
# neither actual sentence contains -- a stale needle from before Task 6's split that happened to
# print FAIL for the right reason rather than a silent false ok, but wrong either way.)
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/carrier/ZZ")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/carrier/ZZ")
BODY=$(curl -s --max-time 15 "${BASE}/carrier/ZZ")
check     "carrier: ZZ is a 404"                        "$CODE" '404'
check_not "carrier: 404 (ZZ) is not long-cached"        "$HDRS" "s-maxage"
check     "carrier: 404 (ZZ) is no-store"               "$HDRS" "no-store"
check     "carrier 404: ZZ is unrecognized, not merely unfiled" "$BODY" "unknown carrier code 'ZZ'"
check_not "carrier 404: ZZ is not reported as recognized"       "$BODY" "recognized by BTS"

# PA -- the measured falsifiable pair's other half, and the COMMON carrier 404 (1,543 of 1,657
# codes land here). All THREE holders named, not just the first: 20384 and 20386 really are Pan
# American World Airways, and 20389 is Florida Coastal Airlines, an unrelated carrier that
# happens to share the code -- naming only the first would be the exact AUS/CE-180 silent-pick
# failure this split exists to refuse, one dimension over (docs/data/invariants.md § Entity
# resolution).
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/carrier/PA")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/carrier/PA")
BODY=$(curl -s --max-time 15 "${BASE}/carrier/PA")
check     "carrier: PA is a 404"                             "$CODE" '404'
check_not "carrier: 404 (PA) is not long-cached"             "$HDRS" "s-maxage"
check     "carrier: 404 (PA) is no-store"                    "$HDRS" "no-store"
check     "carrier 404: PA is recognized, never filed"       "$BODY" "'PA' is recognized by BTS"
check_not "carrier 404: PA is not reported as unknown"       "$BODY" "unknown carrier code"
check     "carrier 404: names the first Pan American holder"  "$BODY" 'Pan American World Airways, airline_id 20384'
check     "carrier 404: names the second Pan American holder" "$BODY" 'Pan American World Airways, airline_id 20386'
check     "carrier 404: names the unrelated same-code holder" "$BODY" 'Florida Coastal Airlines, airline_id 20389'

# The lower-case slug is echoed as TYPED while the reason names the upper-cased code -- the only
# input that tells a real echo apart from a re-read of the reason string. Task 3 found two of its
# own tests reading the reason and calling it the slug; this is that finding, in the served bytes.
BODY=$(curl -s --max-time 15 "${BASE}/carrier/zz")
check_re  "carrier 404: the SENTENCE carries the slug as typed" "$BODY" 'We can.{1,3}t show .{1,12}zz'

# 11b. #106: /carrier/<code>?type=<aircraft slug>, the map filter -- and the cache-header split
#      that only a served build can see. THE FIRST QUERY KEY ON THIS SITE WHOSE VALIDATION NEEDS A
#      DATABASE READ. `?y=` above looks like the precedent and is not: `parseYear` is a regex plus
#      a range and touches no database (lib/year.ts's own header says so), and #87 reads a type
#      off the already-loaded catalog. Whether `B737-8` names anything is a fact about the
#      WAREHOUSE, so the value is RESOLVED -- only when the key is present, so unfiltered requests
#      and every crawler hit pay nothing.
#
#      Each block opens its OWN `HDRS=`, and every `check_not` is paired with a positive on the
#      same headers: a `no-store`-everywhere regression would satisfy the negatives vacuously,
#      which is exactly what the `?y=1999` pair above exists to prevent. Status is asserted as
#      '200', never `check_not '500'` -- a dead server scores 000 and passes the negative form.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/carrier/DL?type=B737-8")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL?type=B737-8")
check     "carrier?type: a resolvable filter renders"                "$CODE" '200'
check     "carrier?type: ...and keeps the project Cache-Control"     "$HDRS" "$HTML_CACHE_EXPECTED"

# MUTANT 1's target: an unresolvable filter must not be a CACHEABLE 200. Under a structural-bound-
# only design this renders DL's ordinary unfiltered page under a one-hour shared cache, once per
# spelling -- a distinct CDN entry for a filter that names nothing.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/carrier/DL?type=NOPE-1")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL?type=NOPE-1")
check     "carrier?type=NOPE-1: an unresolvable filter still renders" "$CODE" '200'
check     "carrier?type=NOPE-1: ...but is no-store"                   "$HDRS" 'no-store'
check_not "carrier?type=NOPE-1: ...and is never long-cached"          "$HDRS" 's-maxage'

# MUTANTS 2 and 5's target. `CE-180` names BTS codes 030 (CESSNA 180) and 031 (CESSNA 180A/B),
# both of which really flew -- so the filter is AMBIGUOUS, not unknown. Picking one is the
# silent-pick failure `AUS` already cost this project once; a `!== "unknown"` predicate would
# long-cache the page for a filter the server refuses to apply.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/carrier/DL?type=CE-180")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL?type=CE-180")
check     "carrier?type=CE-180: an ambiguous filter still renders"  "$CODE" '200'
check     "carrier?type=CE-180: ...but is no-store"                 "$HDRS" 'no-store'
check_not "carrier?type=CE-180: ...and is never long-cached"        "$HDRS" 's-maxage'

# MUTANT 3's target, and the reason the value is read from RAW BYTES rather than through
# URLSearchParams the way `?y=` is. `%42737-8` percent-DECODES to `B737-8`, a real type: under a
# decoded-value bound this resolves and is long-cached, giving a byte-identical page a second CDN
# key. That is the live `/airport/SEA?y=%32019` hole, which is pre-existing, bounded for a
# four-digit year, and deliberately NOT fixed here -- these values are textual, so the family is
# far larger.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/carrier/DL?type=%42737-8")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL?type=%42737-8")
check     "carrier?type=%42737-8: a percent-spelling still renders" "$CODE" '200'
check     "carrier?type=%42737-8: ...but is no-store"               "$HDRS" 'no-store'
check_not "carrier?type=%42737-8: ...and is never long-cached"      "$HDRS" 's-maxage'

# One value, one spelling (lib/pivot/bounds.ts's LITERAL_KEYS rule). The path segment 308s on
# case; a query VALUE has no redirect mechanism available to it, so refusing is the honest answer
# -- and it is what makes the resolver's `redirect` outcome unreachable from the filter path.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/carrier/DL?type=b737-8")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL?type=b737-8")
check     "carrier?type=b737-8: a lower-case spelling still renders" "$CODE" '200'
check     "carrier?type=b737-8: ...but is no-store"                  "$HDRS" 'no-store'
check_not "carrier?type=b737-8: ...and is never long-cached"         "$HDRS" 's-maxage'

# The 308 must carry the filter. This page built `/carrier/DL` from the slug alone until #106, so
# `/carrier/dl?type=B737-8` 308ed to `/carrier/DL` with the filter gone and the destination
# rendered the unfiltered view with no error anywhere -- the identical measured bug `/airport`
# fixed with `airportRedirectTarget`. The Location is anchored with `$` through `re_escape`
# against the MEASURED wire form (relative, not absolute -- measured on this served build, not
# assumed from proxy.test.ts, which pins the pre-relativization value); a substring needle would
# pass for `/carrier/DL` too, which is the bug.
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/dl?type=B737-8")
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/carrier/dl?type=B737-8")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "carrier?type: the case-redirect is a 308"                 "$CODE" '308'
check_re  "carrier?type: the 308 preserves the filter, not just the code" "$LOC" \
  "^[Ll]ocation: $(re_escape '/carrier/DL?type=B737-8')$"
check     "carrier?type: the 308 keeps the project Cache-Control"    "$HDRS" "$HTML_CACHE_EXPECTED"

# 11c. THE WITHHELD RANK (#127). A below-floor row is excluded from ranking, so its rank cell is
# an em dash rather than a number. No unit test can see this reach a browser, and NOTHING ELSE IN
# THIS FILE READS ONE: the four existing rank needles are /watch-only, and /watch structurally
# never produces a dash -- its rows carry `t12_departures_performed`, never `departures_performed`,
# so no preset row ever claims the floor.
#
# The needle is a LITERAL U+2014 -- what React EMITS for the `"\u2014"` string literal in
# DataTable's rank cell, verified by hexdump against this served build (`e2 80 94`), not copied
# from the source. That is the check CLAUDE.md's "bytes React emits" rule exists for, and this
# one earned it twice: written first as the ERE escape `\xe2\x80\x94`, it FAILED, because
# `grep -E` has no such escape and was matching the literal characters `x`, `e`, `2`. Had the
# polarity been `check_not_re`, that same mistake would have printed `ok` forever -- the exact
# self-defect this file has produced three times. Do not "escape" this dash; it is one
# character on purpose.
#
# 2O, dataset-pinned and RE-DERIVED under the monthly floor (#134): 25 Top routes, 20 below floor
# and 5 scored, so both needles below have something to match. Its sparse rows no longer
# interleave -- the below-floor block is rows 6..25 -- which is why the /carrier UNIT fixture for
# the interleaving property moved to M5; these two needles never depended on it. What 2O pins
# here instead is the boundary in the served bytes: row 5 runs 373 departures across all twelve
# months (31.1 a month, scored) and row 6 runs 356 across twelve (29.7, below floor). Seventeen
# departures apart over a year, opposite sides of the floor.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/2O")
check_dataset check_re "carrier/2O: a below-floor row's rank cell is the em dash" \
  "$BODY" '<td[^>]*rank[^>]*>—</td>'
# The positive control. An implementation that dashed EVERY rank cell -- which is exactly what
# `orderRows` does when the partition is off -- satisfies the check above on its own.
check_dataset check_re "carrier/2O: ...while the scored block still numbers from 1" \
  "$BODY" '<td[^>]*rank[^>]*>1</td>'

# The correction landed in the user-facing copy, not only in system.md: `—` means two different
# things in two different columns, and the rank column has no visible header to tell them apart.
check     "carrier: the legend rail says what a rank dash means" \
  "$BODY" 'in the rank column: below the floor, so not ranked'
# ...and it is OPT-IN, so a page with no rank column does not explain one. This is the half that
# distinguishes "the rail was given the line" from "the rail states it unconditionally", and it
# has to be fetched with a FULL QUERY like every other /explore call in this file: a bare
# `/explore` is not canonical, so proxy.ts 307s it and `curl` without `-L` hands back an EMPTY
# body -- on which `check_not` passes having compared nothing. Caught by mutating LegendRail to
# render the row unconditionally and watching this check stay green; it now goes red.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op")
check     "explore: the query renders a table to carry a legend at all" "$BODY" 'class="legend"'
check_not "explore: no rank-column legend on a page with no rank column" \
  "$BODY" 'in the rank column'

# 12. /aircraft/<slug> -- the slug is not a key, and the chart stacks by carrier.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/B737-8")
check     "aircraft: renders the short name" "$BODY" '>B737-8<'
check     "aircraft: renders the full designation" "$BODY" 'BOEING 737-800'
check     "aircraft: DATA AS OF is present"  "$BODY" 'DATA AS OF'
check     "aircraft: renders a carrier code" "$BODY" '>WN<'
check_not "aircraft: renders no bare AIRLINE_ID" "$BODY" '>19393<'
check     "aircraft: the chart SVG is in the served HTML" "$BODY" '<svg role="img"'
check     "aircraft: ramp tokens reach the area fills (lightest)" "$BODY" '<path fill="var(--g0)" d='
check     "aircraft: ramp tokens reach the area fills (darkest)"  "$BODY" '<path fill="var(--g5)" d='
# The stack is CARRIERS here, not aircraft types -- this page IS one type, so a type stack would
# be one band whose shading encodes nothing (system.md § Charts). Built as one template literal
# for the same reason as the carrier caveats above.
check     "aircraft: the chart stacks by carrier"        "$BODY" 'Seats by operating carrier'
check_not "aircraft: ...not by aircraft type"            "$BODY" 'Seats by aircraft type'
# Final whole-branch review, M11 (last of four canonical checks -- see /route's own comment).
check     "aircraft: carries a self-referential canonical link (Task 2)" "$BODY" \
  '<link rel="canonical" href="http://localhost:3000/aircraft/B737-8"'

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/B737-8")
check     "aircraft: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

# The slug transform, end to end. 15 of the 112 fact-present short names carry a `/` or a space,
# so `/aircraft/A320-1/2` is TWO path segments and can never match this route. `A320-1-2` must
# resolve to the name `A320-1/2` and render it.
#
# This was A321-LR until the 20260807 refresh renamed BTS type 699 to 'A321nXLR' -- a name with
# no separator, which cannot exercise this route at all. A320-1/2 (code 694) also carries TWO
# slug separators where A321/LR had one, so the served-build check now covers the 3^2 expansion.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/A320-1-2")
check     "aircraft: a slugged name resolves and renders unslugged" "$BODY" '>A320-1/2<'
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/A320-1-2")
check     "aircraft: sets the project Cache-Control on a slugged name" "$HDRS" "$HTML_CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/aircraft/a320-1-2")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/aircraft/a320-1-2")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "aircraft: lower-case slug redirects"  "$CODE" '308'
# To the SLUG, never to `/aircraft/A320-1/2`, which is unroutable.
check     "aircraft: redirect targets the canonical slug" "$LOC" '/aircraft/A320-1-2'
check_not "aircraft: redirect does not target the unroutable raw name" "$LOC" '/aircraft/A320-1/2'
check     "aircraft: 308 keeps the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/aircraft/NOPE-1")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/aircraft/NOPE-1")
BODY=$(curl -s --max-time 15 "${BASE}/aircraft/NOPE-1")
check     "aircraft: an unknown slug is a 404"      "$CODE" '404'
check_not "aircraft: 404 is not long-cached"        "$HDRS" "s-maxage"
check     "aircraft: 404 is no-store"               "$HDRS" "no-store"
check     "aircraft 404: names the offending slug"  "$BODY" "unknown aircraft type 'NOPE-1'"
# The lower-case slug is echoed as TYPED while the reason names the upper-cased form -- the same
# discriminator /carrier gets, on the page that has the widest divergence available and had no
# check at all. `resolveAircraftSlug` reasons in terms of slugFor(trimmed), so '/aircraft/nope-1'
# must show 'nope-1' in the sentence and 'NOPE-1' in the reason.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/aircraft/nope-1")
BODY=$(curl -s --max-time 15 "${BASE}/aircraft/nope-1")
check     "aircraft: an unknown lower-case slug is a 404 too"      "$CODE" '404'
check_re  "aircraft 404: the SENTENCE carries the slug as typed"   "$BODY" 'We can.{1,3}t show .{1,12}nope-1'
check     "aircraft 404: ...and the REASON names the canonical"    "$BODY" "unknown aircraft type 'NOPE-1'"

# THE ONE THIS SECTION EXISTS FOR. `resolveAircraftSlug` has FOUR outcomes, not three:
# `/aircraft/CE-180` names BTS codes 030 (CESSNA 180) and 031 (CESSNA 180A/B), both of which
# really flew, and no scoping resolves it. It is a 404 -- and it is NOT `kind: "notFound"`, so
# the `!== "notFound"` predicate /route uses (the obvious thing to copy) would have pinned this
# 404 in a shared CDN cache for 30 days. `isCacheable` is an allow-list of kinds because of
# this URL. Verified by mutation on a served build: widening the predicate turns the no-store
# check below red and leaves every other check in this file green.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/aircraft/CE-180")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/aircraft/CE-180")
BODY=$(curl -s --max-time 15 "${BASE}/aircraft/CE-180")
check     "aircraft: the ambiguous slug is a 404"            "$CODE" '404'
check_not "aircraft: the ambiguous 404 is not long-cached"   "$HDRS" "s-maxage"
check     "aircraft: the ambiguous 404 is no-store"          "$HDRS" "no-store"
# Both airframes NAMED, each with its BTS code, sorted by code -- not a bare refusal. The needle
# spans name and id because 'CESSNA 180' alone is a substring of 'CESSNA 180A/B', so a page that
# listed the second one twice would satisfy a naive pair of checks.
check     "aircraft 404: names the first airframe"  "$BODY" 'CESSNA 180 — BTS aircraft type 030'
check     "aircraft 404: names the second airframe" "$BODY" 'CESSNA 180A/B — BTS aircraft type 031'
# Regex over the apostrophe, not a literal: page.tsx writes `won&rsquo;t`, JSX decodes HTML
# entities at COMPILE time, and React escapes only & < > " ' -- so U+2019 goes out as raw UTF-8
# and the literal `won&rsquo;t` is never in the response. That exact mistake printed `ok`
# unconditionally in this file until M4c's final review (see the /explore note above).
check_re  "aircraft 404: refuses to pick one"       "$BODY" 'We won.{1,3}t pick one for you'

# Page weight for the three new pages, recorded not asserted -- same reasoning as /route above.
# /airport/ORD is the worst case in the database, and it is NOT /airport/ATL: measured (month,
# aircraft type) group counts over 2015-01..2026-04 are ORD 4,094 origin / 4,089 dest, union
# 4,118, against ATL's 3,561 / 3,572, union 3,592 -- so the 4,118 this loop used to attribute to
# ATL "per side" was ORD's UNION all along. M4d's final review caught it. ATL stays in the list
# as the second-heaviest, since weighing only the top one tells you nothing about the spread.
# There is no fixed buffer here -- these bodies land in shell variables -- but the `grep -q`
# hazard at the top of this file was invisible until a page crossed 64 KB, so the numbers are
# kept where the next person will see them.
# 12b. #106: /aircraft/<slug>?carrier=<code>, the mirror of 11b's filter on the other page. Same
#      five-part discipline, same pairing rule, and the same reason it can only be seen here.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/aircraft/B737-8?carrier=DL")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/B737-8?carrier=DL")
check     "aircraft?carrier: a resolvable filter renders"            "$CODE" '200'
check     "aircraft?carrier: ...and keeps the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/aircraft/B737-8?carrier=ZZ")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/B737-8?carrier=ZZ")
check     "aircraft?carrier=ZZ: an unresolvable filter still renders" "$CODE" '200'
check     "aircraft?carrier=ZZ: ...but is no-store"                   "$HDRS" 'no-store'
check_not "aircraft?carrier=ZZ: ...and is never long-cached"          "$HDRS" 's-maxage'

# THE CARRIER SIDE OF MUTANTS 2 AND 5, and the finding that shaped this resolver: `/carrier/PA` is
# `notFound`, NOT `ambiguous` -- `CarrierResult` is a three-way union with no ambiguous kind.
# `lookupCarriersByCode(["PA"])` returns nothing because it filters to fact-present airlines, so
# the collision only surfaces through the SECOND query `resolveCarrier` makes to word its 404:
# `PA` is held by airline_id 20384 and 20386 (both "Pan American World Airways") plus 20389
# "Florida Coastal Airlines", an unrelated carrier sharing the code. More than one holder is a
# refusal to choose; ZERO or ONE is merely unknown, which is the boundary the unit tests pin.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/aircraft/B737-8?carrier=PA")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/B737-8?carrier=PA")
check     "aircraft?carrier=PA: an ambiguous filter still renders" "$CODE" '200'
check     "aircraft?carrier=PA: ...but is no-store"                "$HDRS" 'no-store'
check_not "aircraft?carrier=PA: ...and is never long-cached"       "$HDRS" 's-maxage'

# `%44L` percent-decodes to `DL`. Same raw-bytes rule as 11b's `%42737-8`.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/aircraft/B737-8?carrier=%44L")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/B737-8?carrier=%44L")
check     "aircraft?carrier=%44L: a percent-spelling still renders" "$CODE" '200'
check     "aircraft?carrier=%44L: ...but is no-store"               "$HDRS" 'no-store'
check_not "aircraft?carrier=%44L: ...and is never long-cached"      "$HDRS" 's-maxage'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/aircraft/B737-8?carrier=dl")
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/B737-8?carrier=dl")
check     "aircraft?carrier=dl: a lower-case spelling still renders" "$CODE" '200'
check     "aircraft?carrier=dl: ...but is no-store"                  "$HDRS" 'no-store'
check_not "aircraft?carrier=dl: ...and is never long-cached"         "$HDRS" 's-maxage'

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/b737-8?carrier=DL")
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/aircraft/b737-8?carrier=DL")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "aircraft?carrier: the case-redirect is a 308"             "$CODE" '308'
check_re  "aircraft?carrier: the 308 preserves the filter, not just the slug" "$LOC" \
  "^[Ll]ocation: $(re_escape '/aircraft/B737-8?carrier=DL')$"
check     "aircraft?carrier: the 308 keeps the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

# 12c. #108: the /aircraft network map itself -- what 12b's header checks cannot see. Every check
#      above this block reads a Cache-Control; a page can carry the right header and still draw
#      the wrong map, or none. These read the BODY.
#
#      Needles are the bytes React EMITS, not the bytes the source contains. Nothing here carries
#      an apostrophe, an entity or an angle-bracketed pair for that reason: `check_not` on a JSX
#      string containing `&rsquo;` has printed a silent `ok` in this file before, because JSX
#      decodes entities at compile time and React emits raw U+2019.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/B737-8")
check     "aircraft: unfiltered renders the picker"          "$BODY" 'data-testid="map-picker"'
# The map query needs BOTH a carrier and a type, so the unfiltered page issues none at all.
check_not "aircraft: unfiltered draws no arcs"               "$BODY" 'data-testid="segment-map"'
check     "aircraft: unfiltered says what the picker is for" "$BODY" 'Pick a carrier to draw the routes'
# THE FILTER VOCABULARY, in the served bytes. `?carrier=` resolves CODES and refuses ids, so an
# href built from the raw `airline_id` is live, looks deliberate, and is refused at the far end.
check     "aircraft: the picker links a carrier CODE"        "$BODY" 'href="/aircraft/B737-8?carrier=WN"'
check_not "aircraft: ...never the raw AIRLINE_ID"            "$BODY" 'carrier=19393'
# Nothing to clear on the page a reader arrives at first.
check_not "aircraft: unfiltered offers no clear-filter link" "$BODY" '>Clear the filter</a>'

# WN files more B737-8 pairs than the 400-arc cap (1,318 measured over the trailing 12 to
# 2026-05), so this view states the cap. The count is a PATTERN: a BTS refresh moves it.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/B737-8?carrier=WN")
check     "aircraft?carrier=WN: draws the map"               "$BODY" 'data-testid="segment-map"'
check     "aircraft?carrier=WN: the map SVG is in the served HTML" "$BODY" 'aria-label="Route map, '
check_re  "aircraft?carrier=WN: states the cap it hit"       "$BODY" '400 of [0-9,]+ routes drawn\.'
check     "aircraft?carrier=WN: says the filter scopes to the map" "$BODY" 'The filter applies to the map only'
check     "aircraft?carrier=WN: offers the way back"         "$BODY" '<a href="/aircraft/B737-8">Clear the filter</a>'
# The arc encodings reach the rail, which is the only thing on the page that explains them.
check     "aircraft?carrier=WN: the rail explains the arcs"  "$BODY" 'Arc rendering'

# AS files 325 pairs on the same type -- UNDER the cap, and with no quarantined or same-airport
# group either, so this view states NOTHING. A cap note rendered unconditionally reads "325 of
# 325 routes drawn." here and looks entirely plausible, which is why the pair is on one page.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/B737-8?carrier=AS")
check     "aircraft?carrier=AS: draws the map"               "$BODY" 'data-testid="segment-map"'
check_not "aircraft?carrier=AS: states no cap it did not hit" "$BODY" 'routes drawn.'

# THE ONE CHECK NO UNIT TEST CAN MAKE, and the reason this block exists. `%57%4E` percent-decodes
# to `WN`. `proxy.ts` admits `?carrier=` on the RAW bytes and refuses this spelling (12b's
# `%44L` block proves the header side), so the page must refuse it too -- reading the value off
# `searchParams`, which Next hands over already decoded, would draw WN's map under a URL this
# server rejected and no unit test could see it, because no unit test crosses Next's decoding.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/B737-8?carrier=%57%4E")
check_not "aircraft?carrier=%57%4E: a percent-spelling draws NO map" "$BODY" 'data-testid="segment-map"'
check     "aircraft?carrier=%57%4E: ...and names which way it failed" "$BODY" 'without percent-encoding'

# Every holder NAMED, none chosen. The two Pan Am rows are byte-identical by name, so the
# airline_id is what makes the list legible rather than the same string twice.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/B737-8?carrier=PA")
check_not "aircraft?carrier=PA: refuses to pick a holder"    "$BODY" 'data-testid="segment-map"'
check     "aircraft?carrier=PA: names the unrelated holder"  "$BODY" 'Florida Coastal Airlines (airline_id 20389)'
check     "aircraft?carrier=PA: ...and both Pan Am eras"     "$BODY" 'Pan American World Airways (airline_id 20386)'

for U in /airport/SEA /airport/ATL /airport/ORD /carrier/DL /aircraft/B737-8; do
  printf '  note %8s bytes of HTML for %s\n' "$(curl -s --max-time 30 "${BASE}${U}" | wc -c)" "$U"
done

# ---------------------------------------------------------------------------------------------
# 13. M5 "connect the graph" -- cross-linking, the omnibox, and the crawl graph. This is the
#     task the milestone's Critical (M4b's cache-matcher bug) was hiding in a second time: three
#     new routes, each needing the same matcher-entry-plus-header discipline § 8-12's comment
#     block states, plus a route (`/search`) whose correct Cache-Control is the ONE VALUE every
#     other row in this file argues against -- `no-store`, unconditionally, never the long cache.

# The route cell's href, checked separately from the code text it wraps (§ 7 above already
# proves 'DL' renders; this proves the CELL LINKS, which is a different claim a dropped
# entityHref call would leave silently unfalsified). Cross-link chokepoint: /route -> /carrier,
# /carrier -> /aircraft -- one from each direction, not two checks on the same page.
BODY=$(curl -s --max-time 15 "${BASE}/route/JFK-LAX")
check "cross-link: /route/JFK-LAX links a carrier cell to /carrier/DL" "$BODY" 'href="/carrier/DL"'
BODY=$(curl -s --max-time 30 "${BASE}/carrier/DL")
check "cross-link: /carrier/DL links an aircraft cell to /aircraft/B737-8" "$BODY" 'href="/aircraft/B737-8"'

# The milestone's sharpest trap (docs/design/system.md § The data table): /explore's route cell
# displays the two codes in AIRPORT-ID order but must LINK to the code-alphabetical canonical
# /route/ URL, and the two orderings disagree for 215 of 22,509 pairs. IFP/IAH is the fixture
# explore/page.test.tsx and DataTable.test.tsx already use for exactly this reason -- a
# JFK-LAX-shaped fixture cannot catch this class of bug, because JFK-LAX's two orderings agree.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=route&d=route&m=seats&t=2015-01:2016-12&f=route:10590-12266&s=-seats&n=5&g=op")
check "explore: renders the airport-id-ordered display" "$BODY" 'IFP–IAH'
check "explore: route cell LINKS to the code-alphabetical canonical, not the displayed order" \
  "$BODY" 'href="/route/IAH-IFP"'

# The omnibox. Correction on the brief this section implements: a UNIQUE match is a 307, not a
# 308 -- 'q=PDX resolves uniquely' is a fact about THIS MONTH's dataset, and a 308 is cached
# permanently by the requesting browser itself (independent of any CDN), so a code that starts
# colliding in a future rebuild would leave a wrong PERMANENT client-side redirect behind. A 308
# assertion here would be silently wrong forever after the first browser that ever saw it.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/search?q=PDX")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/search?q=PDX")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "search: a uniquely-resolving code is a 307, not a 308" "$CODE" '307'
check     "search: redirects to the resolved entity page"         "$LOC"  '/airport/PDX'

# LNY, NEW and WST are the three measured airport/carrier code collisions (docs/product/
# features.md; airport ∩ aircraft and carrier ∩ aircraft are both 0 today). A silently-chosen
# answer would still read as plausible here -- the carrier IS named after the airport -- which
# is exactly why this is the sharpest of the three and the one worth a served-build check: both
# real candidates rendered, NEITHER picked, and -- the falsifiable half -- NOT a redirect.
BODY=$(curl -s --max-time 15 "${BASE}/search?q=LNY")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/search?q=LNY")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "search: a collision names the airport" "$BODY" 'Lanai Airport'
check     "search: ...and the carrier too"        "$BODY" 'Lanai Air'
# Final whole-branch review, F3: the two checks above are vacuous -- 'Lanai Air' is a
# SUBSTRING of 'Lanai Airport' (dim_airport: 13034/LNY/'Lanai Airport'; dim_carrier:
# 22137/LNY/'Western Aircraft, dba Lanai Air'), so the airport hit alone puts the bytes
# 'Lanai Air' in the response and the carrier check can never go red on its own. These two
# use disjoint needles -- neither a substring of the other -- so each can fail independently.
check     "search: a collision links the airport candidate" "$BODY" 'href="/airport/LNY"'
check     "search: ...and the carrier candidate too"        "$BODY" 'href="/carrier/LNY"'
# Not run through check_not (built on grep -F, which cannot assert an ABSENT header cleanly
# against an empty-string needle): a collision must render both candidates rather than picking
# one, which -- unlike a unique match -- means no Location header at all.
if [ -z "$LOC" ]; then
  printf '  ok   %s\n' "search: a collision is not a redirect (no Location header)"
else
  printf '  FAIL %s\n       expected no Location header, got: %s\n' \
    "search: a collision is not a redirect (no Location header)" "$LOC"
  FAILED=1
fi

# 'Portland' -- the measured example that discriminates ranking from raw substring matching:
# four fact-present airports, not three, and PWM is Maine, not Oregon. All four must render.
BODY=$(curl -s --max-time 15 "${BASE}/search?q=Portland")
for A in HIO PDX PWM TTD; do
  check "search: 'Portland' names ${A}" "$BODY" ">${A}<"
done
printf '  note %6s bytes of HTML for /search?q=Portland\n' "$(printf '%s' "$BODY" | wc -c)"

# /search is disallowed for crawling (unbounded free-text query space) but requests that DO
# land on it must not be indexed either -- both halves of "don't crawl it, and if you got here
# anyway don't index it" have to hold, or a shared link still ends up in a search index.
BODY=$(curl -s --max-time 15 "${BASE}/search?q=PDX")
check "search: carries noindex" "$BODY" 'name="robots" content="noindex"'
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/search?q=zzzzzzzzzz")
check "search: is no-store" "$HDRS" "no-store"
check_not "search: is never the project's long cache" "$HDRS" "s-maxage"
# The positive check above cannot, by itself, tell proxy.ts's bare `no-store` apart from a
# request that never reached proxy.ts at all -- a page missing from the matcher falls back to
# Next's OWN default for a force-dynamic page, `private, no-cache, no-store, max-age=0,
# must-revalidate`, which also CONTAINS the substring "no-store". Verified by mutation
# (removing "/search" from the matcher): the check above stayed green under that mutant, which
# is exactly the vacuous-check failure this project's own working agreement calls out --
# `must-revalidate` is the token that is present in Next's fallback and absent from proxy.ts's
# own value, so this is the one that actually distinguishes "proxy.ts ran" from "it didn't".
check_not "search: is not Next's own force-dynamic fallback (proves proxy.ts ran)" "$HDRS" "must-revalidate"

# The sitemap and robots.txt. Both get CLAUDE.md's project-wide value (they carry none of the
# entity pages' per-request resolution risk -- proxy.ts's own doc comment on the branch).
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/sitemap.xml")
BODY=$(curl -s --max-time 15 "${BASE}/sitemap.xml")
check "sitemap: returns XML"                    "$BODY" '<?xml version="1.0"'
check "sitemap: is well-formed as a urlset"      "$BODY" '<urlset xmlns='
check "sitemap: sets the project Cache-Control"  "$HDRS" "$CACHE_EXPECTED"
# VX (Virgin America) stopped filing in 2018-03 -- the dormant-entity fixture sitemap.ts's own
# header names: an ACTIVE entity's lastmod and the current build month coincide, so a bug that
# reports the BUILD DATE instead of the entity's own last-filed month would still pass a check
# anchored on an active carrier. Scoped to VX's own two-line block (grep -A1, not -q -- reads to
# completion, so it carries none of this file's header's SIGPIPE hazard) rather than the whole
# 2.4 MB document, because an unscoped `check_not '2026-04-01'` would be satisfied by any OTHER
# entity's lastmod and prove nothing about VX's own.
VX_BLOCK=$(printf '%s' "$BODY" | grep -A1 'carrier/VX</loc>')
check     "sitemap: /carrier/VX's lastmod is its own last-filed month" "$VX_BLOCK" '<lastmod>2018-03-01'
# Final whole-branch review, M1: this used to be a hardcoded 'check_not ... 2026-04-01', which
# is the DATA-AS-OF month, not the build date -- a genuine "stamp the build date instead of
# VX's own last-filed month" bug emits today's date (this build ran 2026-07), not 2026-04, so
# the hardcoded needle could never fire against the actual bug it was written to catch.
# $(date -u +%Y-%m) tracks whenever this script actually runs, which is what the bug would
# actually stamp.
check_not "sitemap: ...not the current build month"                    "$VX_BLOCK" "$(date -u +%Y-%m)"

HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/robots.txt")
BODY=$(curl -s --max-time 15 "${BASE}/robots.txt")
check "robots: disallows /search"               "$BODY" 'Disallow: /search'
check "robots: points at the sitemap"           "$BODY" 'Sitemap: '
check "robots: sets the project Cache-Control"  "$HDRS" "$CACHE_EXPECTED"

# Fix wave 3, item 2: ONE DuckDBInstance for the whole server, not one per entry point.
# Turbopack emits lib/db.ts into three separate server chunks (proxy, page SSR, route
# handler), so its memo was three memos and this process opened upgauge.duckdb three times --
# three buffer pools, and three snapshots of the file taken at three different moments, which
# is a live route back to the bug the section above fixes (a pair present in the proxy's
# snapshot but not the page's would get s-maxage=2592000 on a 404). db.ts now memoizes on
# globalThis. NOTHING but a served build can check this: a unit test has one module graph by
# construction, so it cannot tell one instance from three.
#
# Deliberately placed after every entry point above has been hit at least once: it is the
# FIRST call in each graph that opens the file. One fd == one instance was established by
# measurement (the count went 1 -> 2 -> 3 across /, /route and /api/pivot before the fix, and
# stays at 1 after it). Reads /proc, so this needs Linux -- the deploy target and CI both are;
# it fails loudly rather than skipping if that ever stops being true, because a skipped guard
# is a dark guard.
# Host mode walks the LOCAL process tree via pgrep and reads /proc/<pid>/fd directly -- this
# script and `next start` share a PID namespace, so that is straightforward. Container mode
# cannot do the same from the HOST side: `docker inspect --format '{{.State.Pid}}'` reports a
# PID in the DAEMON's own PID namespace, which is a DIFFERENT namespace from wherever this
# script runs under Docker Desktop -- measured: that PID does not exist in this host's /proc at
# all (Docker Desktop's own Linux VM, "Operating System: Docker Desktop" in `docker info`), not
# a permission problem but a namespace one, and not specific to this one machine -- any Docker
# Desktop install (macOS, Windows/WSL2) puts the daemon in its own VM the same way. `docker exec`
# sidesteps it entirely: it always runs a new process INSIDE the target container's own
# namespaces regardless of daemon topology, so scanning /proc from there sees exactly (and only)
# this container's own tree. No `pgrep` needed either -- PID-namespace isolation already limits
# /proc to this container alone, and node:*-slim ships no procps -- so this is plain `sh`, not
# the `descendants` helper host mode needs.
if [ "$SMOKE_MODE" = "container" ]; then
  HANDLES=$(docker exec upgauge-smoke sh -c '
    n=0
    for d in /proc/[0-9]*; do
      n=$(( n + $(ls -l "$d/fd" 2>/dev/null | grep -c "upgauge\.duckdb") ))
    done
    echo "$n"
  ' 2>/dev/null)
  HANDLES="${HANDLES:-0}"
else
  descendants() { printf '%s\n' "$1"; local c; for c in $(pgrep -P "$1" 2>/dev/null); do descendants "$c"; done; }
  HANDLES=0
  for p in $(descendants "$SERVER_PID"); do
    HANDLES=$(( HANDLES + $(ls -l "/proc/${p}/fd" 2>/dev/null | grep -c 'upgauge\.duckdb') ))
  done
fi
check_re "db: proxy, page and API share ONE DuckDBInstance (open handles = 1)" "$HANDLES" '^1$'

# ---------------------------------------------------------------------------------------------
# 14. M6 Task 8: /watch and the four Top-N leaderboard presets. proxy.ts's matcher grew to
#     ELEVEN entries for this (M6 Task 7) -- `/watch` (exact path, same shape as `/search`) and
#     `/watch/:preset` (dynamic segment, the same shape an entity page's slug has, but gated by
#     a static slug registry plus `isDataLayerHealthy()` rather than a per-slug resolve()). This
#     is the section that closes the one gap M5's own whole-branch review left explicit in
#     hosting.md: "unit-verified only, not yet smoke-curled" -- proxy.test.ts calls proxy()
#     directly and never crosses Next's own routing, so a matcher entry silently dropped from
#     `config.matcher` cannot fail any unit test, only a served build. Verified by mutation, not
#     by inspection: removing "/watch/:preset" from the matcher, rebuilding and serving turned
#     `/watch/nope`'s 404 body from 9,941 bytes (naming the preset) to 7,816 (a bare error
#     shell, matching the ~7,740-byte shell M4d measured for the same failure one page family
#     over) AND degraded /watch/gauge's own Cache-Control from HTML_CACHE to Next's own
#     force-dynamic fallback, `private, no-cache, no-store, max-age=0, must-revalidate` -- on a
#     PAGE THAT RENDERS FINE, which is exactly the M4b-shaped bug this file's matcher discipline
#     exists to catch a second time. Reverted before commit; not re-run automatically here for
#     the same reason mutant A never is anywhere else in this file (it requires editing source
#     and rebuilding, which is a one-time verification exercise, not a repeatable gate).

# 14a. /watch, the index: four links, no table, no per-slug resolution -- so only the first two
# of the five things every leaderboard page below asserts apply.
BODY=$(curl -s --max-time 15 "${BASE}/watch")
check "watch: renders the index"        "$BODY" '<h1>Gauge Watch</h1>'
check "watch: DATA AS OF is present"    "$BODY" 'DATA AS OF'
check "watch: links every preset (gauge)"        "$BODY" 'href="/watch/gauge"'
check "watch: links every preset (empty-planes)" "$BODY" 'href="/watch/empty-planes"'
check "watch: links every preset (new-routes)"   "$BODY" 'href="/watch/new-routes"'
check "watch: links every preset (death-watch)"  "$BODY" 'href="/watch/death-watch"'
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/watch")
check "watch: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
# Final whole-branch review (M6), Important #3: the shipped index told visitors the presets were
# "Four saved Explorer queries, editorially framed" -- the exact claim M6 corrected in six other
# places on the grounds that no pivot measure expresses a delta, so they CANNOT be Explorer
# queries. The pair, not either half: a page printing both sentences would satisfy the positive
# alone. Needles are pure ASCII on purpose -- the sentence's own em dash is a `&mdash;` in JSX,
# which the compiler decodes and React emits as raw U+2014, so a needle copied from the source
# would never match (this file's own documented dark-guard failure).
check     "watch: refuses the 'saved Explorer queries' claim" "$BODY" 'Not saved Explorer queries'
check_not "watch: ...and does not still make it"             "$BODY" 'Four saved Explorer queries'

# Final whole-branch review (M6), Important #2: /watch shipped with ZERO inbound internal links.
# Checked against an ENTITY page and the front door, never against /watch itself -- the index's
# own preset links are `href="/watch/gauge"` etc., so a needle tested only there would pass on a
# top bar that had lost the link entirely. `href="/watch"` (closing quote included) matches the
# nav link and nothing else.
NAVBODY=$(curl -s --max-time 15 "${BASE}/route/JFK-LAX")
check "watch: the top bar links to it from an entity page" "$NAVBODY" 'href="/watch"'
#
# The front-door PROSE link needs its own region, and the first version of this check did not
# have one -- re-review of the fix wave caught it as vacuous. `/` renders TopBar, TopBar emits
# `href="/watch"`, so `check ... "$BODY" 'href="/watch"'` against the whole page stayed green
# with the prose <Link> deleted outright: it could not fail for the reason it named, which is
# this file's own recurring dark-guard failure.
#
# `between` bounds the region to <main>, which TopBar sits OUTSIDE (page.tsx renders
# <div class="wrap"><TopBar/><main class="error-page">...). The check_not below is not decoration
# -- it is the falsifiability proof, asserted in-band and permanently: if the bound ever stops
# excluding the top bar (a layout change moving TopBar inside <main>, say), the positive check
# silently goes vacuous again and only this line notices. `class="mark"` is the wordmark's own
# class, emitted by TopBar and by nothing else.
# The wordmark presence check on the FULL body is what stops the check_not from being vacuous
# in its own right: "class=mark is absent from the bounded region" proves the bound works only
# if that string is present in the page at all. Three checks, and each one is load-bearing.
HOMEBODY=$(curl -s --max-time 15 "${BASE}/")
HOMEMAIN=$(between "$HOMEBODY" '<main' '</main>')
check     "watch: the wordmark IS on the front door (the check_not below needs a live needle)" "$HOMEBODY" 'class="mark"'
check_not "watch: ...but the <main> bound excludes the top bar, so the next check is real"     "$HOMEMAIN" 'class="mark"'
check     "watch: the front door links to it in prose, not only via the top bar"               "$HOMEMAIN" 'href="/watch"'

# 14b. /watch/gauge -- Gauge Watch, "the differentiator" (docs/product/features.md), and the
# ONE preset that renders two tables (Upgauging / Downgauging, sorted oppositely by the same
# gauge_delta column -- runPreset() substitutes {{DIRECTION}} into watch_gauge.sql's ORDER BY).
# Every check below follows the same five-things-in-order discipline §§8-12's own header
# comment states for the entity pages: renders, Cache-Control, a real code vs. a bare id, the
# rank column, and (once, after all four presets, since the not-found path is shared) the 404.
BODY=$(curl -s --max-time 15 "${BASE}/watch/gauge")
check "watch/gauge: renders"          "$BODY" '<h1>Gauge Watch</h1>'
check "watch/gauge: DATA AS OF is present" "$BODY" 'DATA AS OF'
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/watch/gauge")
check "watch/gauge: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
# M4a's rule, per page: a resolved carrier renders its code, never the bare AIRLINE_ID. AS
# (19930) leads Upgauging, DL (19790) leads Downgauging -- both checked, since a page that
# resolved neither carrier would still pass a check written against only one.
check     "watch/gauge: renders a carrier code (AS)"   "$BODY" '>AS<'
check     "watch/gauge: renders a carrier code (DL)"   "$BODY" '>DL<'
check_not "watch/gauge: renders no bare AIRLINE_ID (AS)" "$BODY" '>19930<'
check_not "watch/gauge: renders no bare AIRLINE_ID (DL)" "$BODY" '>19790<'

# The rank column, DataTable's own `rank` prop (`<td class="rank" data-testid="rank-cell">`).
# An index-based mutant (`i` instead of `i + 1`) renders a full, plausible table, so absence
# alone proves nothing -- both halves are load-bearing. The negative half is scoped to the RANK
# cell specifically, not `>0</td>` in isolation: measured on the served build, `t12_quarantined_
# rows` legitimately renders bare "0" for an unquarantined row (`<td class="num">0</td>`,
# several per page), so a plain `check_not ... '>0</td>'` red-flags a CORRECT table on its own
# data. `check_not_re` anchored to `rank` is what actually distinguishes "the rank column is
# 1-based" from "some unrelated count column happens to be zero".
check_re     "watch/gauge: rank starts at 1"    "$BODY" '<td[^>]*rank[^>]*>1</td>'
check_not_re "watch/gauge: rank is not 0-based" "$BODY" '<td[^>]*rank[^>]*>0</td>'

# The falsifiable pair itself (measured against the real warehouse, mart_route_health, current
# window). AS LAX-OGG is the single largest upgauge, gauge_delta +72.46, and no carrier flies
# LAX-OGG downgauging, so it serves both halves.
#
# THE DOWNGAUGE HALF CANNOT USE ITS LEADER, and the reason is this repo's own grain rule. The
# largest downgauge is HA HNL-PDX at -64.49, but AS flies the SAME airport pair upgauging at
# +41.74 and sits 7th in the other table -- the mart's grain is a carrier-route PAIR, so
# "HNL-PDX" names two rows in two different tables and a route-only `check_not` against the
# upgauge table fails on a page that is entirely correct. Measured: it did, which is how this
# was found. The needle is therefore B6 DAB-JFK, -53.37, rank 5 -- the largest downgauge whose
# airport pair carries exactly ONE carrier in the mart, so its absence from the upgauge table is
# a real statement about which table rendered. (It was DL BOS-CVG before #148, which the rate
# floor no longer admits to the mart at all.) Presence in $BODY alone would be satisfied by a page that put both routes in
# ONE table, or the wrong one -- these mean something only checked against the CORRECT table and
# refuted against its sibling, which is why they're split with `between()` first.
#
# The needle is a literal en dash (U+2013), not `&ndash;`: JSX decodes HTML entities at compile
# time and React's own serializer only escapes & < > " ', so `&ndash;` written in source never
# reaches the response -- the exact dark-guard class M4c shipped (`can&rsquo;t be read`,
# smoke.sh's own note above). Verified against the actual served bytes before writing this,
# not assumed from the source.
UP_TABLE=$(between "$BODY" '<h2>Upgauging</h2>' '<h2>Downgauging</h2>')
DOWN_TABLE=$(between "$BODY" '<h2>Downgauging</h2>' '<aside class="legend">')
check_dataset check     "watch/gauge: the upgauge table leads with AS LAX-OGG"   "$UP_TABLE"   'LAX–OGG'
check_dataset check_not "watch/gauge: ...which is not in the downgauge table"    "$DOWN_TABLE" 'LAX–OGG'
check_dataset check     "watch/gauge: the downgauge table carries B6 DAB-JFK"  "$DOWN_TABLE" 'DAB–JFK'
check_dataset check_not "watch/gauge: ...which is not in the upgauge table"     "$UP_TABLE"   'DAB–JFK'

# 14c. /watch/empty-planes -- one table, lowest load factor at a real-airliner gauge floor.
BODY=$(curl -s --max-time 15 "${BASE}/watch/empty-planes")
check "watch/empty-planes: renders"       "$BODY" '<h1>Empty Planes</h1>'
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/watch/empty-planes")
check "watch/empty-planes: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
check     "watch/empty-planes: renders a carrier code"     "$BODY" '>AS<'
check_not "watch/empty-planes: renders no bare AIRLINE_ID" "$BODY" '>19930<'
# #148 replaced this preset's own `t12_departures_performed >= 360` with the mart's rate floor,
# which applies to all four presets -- so the note is now stated on every preset and says
# something different. Both directions in the served bytes: the rate claim present AND the flat
# annual total gone. The needle is the note's own words, never the bare digits -- a 25-row table
# of real seat counts contains "360" by coincidence, the same trap the "50" mutant already
# sprang on this preset (task-6-report.md).
check     "watch/empty-planes: discloses the mart's departure floor" "$BODY" '30 performed departures per month flown'
check_not "watch/empty-planes: no longer claims a flat 360 annual total" "$BODY" '360 performed departures'
check_re     "watch/empty-planes: rank starts at 1"    "$BODY" '<td[^>]*rank[^>]*>1</td>'
check_not_re "watch/empty-planes: rank is not 0-based" "$BODY" '<td[^>]*rank[^>]*>0</td>'

# 14d. /watch/new-routes -- Route Birth Tracker. Every row here has p12_months_present = 0, so
# health_score is ALWAYS NULL (100% of rows, not the exception the other three presets treat it
# as) -- formatHealthScore's own docstring measures this; nothing to check here that §14b/c/e
# don't already cover about that rendering.
BODY=$(curl -s --max-time 15 "${BASE}/watch/new-routes")
check "watch/new-routes: renders"       "$BODY" '<h1>Route Birth Tracker</h1>'
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/watch/new-routes")
check "watch/new-routes: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
check     "watch/new-routes: renders a carrier code"     "$BODY" '>AS<'
check_not "watch/new-routes: renders no bare AIRLINE_ID" "$BODY" '>19930<'
# Final whole-branch review (M6), CRITICAL: this page told visitors "First appearance since
# 2015" about rows that had filed for years. `p12_months_present = 0` is a RE-ENTRY -- 174 of
# 297 qualifying rows (58.6%) and 19 of the 25 rendered had filed before the p12 window, worst
# case B6 AUS-FLL at 106 distinct months back to 2015-01. Both halves, in the served bytes: the
# accurate claim present AND the false one gone. All-ASCII needles for the reason above; the
# frame itself is a plain TS string literal (lib/watch.ts), not JSX, so it ships verbatim.
check     "watch/new-routes: states re-entry, not first appearance" "$BODY" 'not necessarily a first appearance'
check_dataset check "watch/new-routes: carries the measured count"        "$BODY" '174 of the 297'
check_not "watch/new-routes: no longer claims 'since 2015'"         "$BODY" 'since 2015'
# The SECOND false claim on this page, found by the re-review of the wave that fixed the first:
# mart_route_health's grain is (op_airline_id, route), so `p12_months_present = 0` says nothing
# about the OTHER carriers on that airport pair -- 245 of 297 (82.5%) and 25 of the 25 rendered
# had one, the #1 row (AS HNL-ITO) while HA/UA/WN filed 1,786,963 seats on it. This page has now
# shipped a false claim twice, so every one of them gets a served-byte guard, both directions.
check     "watch/new-routes: names the carrier, not the route (frame)" "$BODY" 'A route this carrier flew nothing on last year'
check     "watch/new-routes: names the carrier, not the route (note)"  "$BODY" 'this carrier filed nothing at all on this route'
check_dataset check "watch/new-routes: carries the unserved-route measurement" "$BODY" '245 of the 297'
check_not "watch/new-routes: never claims nobody flew it"              "$BODY" 'nobody flew'
check_re     "watch/new-routes: rank starts at 1"    "$BODY" '<td[^>]*rank[^>]*>1</td>'
check_not_re "watch/new-routes: rank is not 0-based" "$BODY" '<td[^>]*rank[^>]*>0</td>'

# 14e. /watch/death-watch -- the ONE preset whose SQL filters `health_score IS NOT NULL` itself
# (watch_death_watch.sql), so formatHealthScore's NULL branch is provably unreachable here.
BODY=$(curl -s --max-time 15 "${BASE}/watch/death-watch")
check "watch/death-watch: renders"       "$BODY" '<h1>Route Death Watch</h1>'
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/watch/death-watch")
check "watch/death-watch: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
check     "watch/death-watch: renders a carrier code"     "$BODY" '>OO<'
check_not "watch/death-watch: renders no bare AIRLINE_ID" "$BODY" '>20304<'
check_re     "watch/death-watch: rank starts at 1"    "$BODY" '<td[^>]*rank[^>]*>1</td>'
check_not_re "watch/death-watch: rank is not 0-based" "$BODY" '<td[^>]*rank[^>]*>0</td>'

# 14f. /watch/nope -- the shared not-found path (watch/[preset]/not-found.tsx), once: unlike
# the four entity pages, `presetBySlug` is a pure lookup against a fixed four-entry registry,
# not a warehouse re-resolution, so there is only one reason, not a per-cause split to pair.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/watch/nope")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/watch/nope")
BODY=$(curl -s --max-time 15 "${BASE}/watch/nope")
check     "watch: unknown preset is a 404"          "$CODE" '404'
check_not "watch: 404 is not long-cached"           "$HDRS" "s-maxage"
check     "watch: 404 is no-store"                  "$HDRS" "no-store"
# The SENTENCE, not just the router-state echo: the RSC flight payload always contains the
# requested pathname ("c":["","watch","nope"]) regardless of what the page renders -- proven by
# mutant A above, where the 7,816-byte error shell still contains the bare string "nope" in its
# router state despite naming nothing. The needle below spans the JSON string-escaping between
# "preset" and the interpolated slug (`preset '","nope","'`, the {slug} JSX expression breaking
# the sentence into three flight-payload string fragments) the same way §8's ZZZZ-LAX check
# spans its own escaping, and requires the actual composed sentence, not the router state alone.
check_re "watch 404: names the offending slug" "$BODY" "We don.{1,3}t recognize the preset .{1,10}nope"

# ---------------------------------------------------------------------------------------------
# 15. M8 Task 3: one canonical KEY SET per cacheable URL.
#
# Not "one canonical spelling", which is what this header claimed first and is wider than the gate
# delivers: key ORDER survives, and this gate inspects no VALUE at all. The value axis is bounded
# by a different mechanism, asserted in its own block further down this section (#52,
# `app/src/lib/pivot/bounds.ts`): `t` must sit inside the dataset's own window with from <= to, `n`
# must be under a stated ceiling, every key but `f` must be spelled literally on the RAW bytes, and
# `d`/`m` may not repeat a token. `f` is the residual -- percent-encoding is its own escape
# mechanism, so it is exempt from the spelling rule and left to the edge instead
# (docs/architecture/hosting.md § "What this does not close" carries it, with the thresholds -- and
# with the rule's expression, which since #83 covers `/explore` as well as `/api/`, so the path
# this exemption is stated on is now actually one the edge limits).
#
# Cloudflare's default cache key includes the full query string, so before this gate `?x=1..N`
# minted an unbounded family of long-cached entries on every cacheable path -- measured on a
# served build at 4aa8087, on all TEN that the proxy gates, `/sitemap.xml?x=1` at 30 days and
# 2.4 MB. `/api/pivot` is an ELEVENTH cacheable path, closed in its own handler with a 400 rather
# than here with a 307 (below); `/search` is the twelfth matcher entry and never cacheable at all.
# Each entry is a guaranteed origin miss, against the exact cost model the CDN exists to protect.
#
# `check` is `grep -F`, a SUBSTRING test, which is a trap for a Location assertion: a needle of
# '/airport/ORD?y=2019' is satisfied by 'location: /airport/ORD?y=2019&junk=1', which is the
# failure being tested for. Every Location check below is `check_re` with a `$`-anchored regex.
#
# These Location regexes are anchored to the MEASURED wire form, not an alternation that would
# also accept the unmeasured one -- whole-branch review round 2 (Finding 2) is why: a bare
# relative Location 500s in this Next version (next/dist/server/web/adapter.js's NextURL
# constructor throws on a relative string with no base), so proxy.ts builds an ABSOLUTE Location
# from request.nextUrl.origin -- but what actually reaches the wire is relative, because
# next/dist/server/lib/router-utils/resolve-routes.js relativizes it against `initUrl` (THIS
# server's own bind config, not the client's Host header) before the response leaves the process
# (proxy.ts's own doc comment on the gate has the full citation). proxy.test.ts, which calls
# proxy() directly and never crosses that relativization, necessarily pins the pre-relativization
# ABSOLUTE value -- this section is what proves the WIRE form, and an optional origin prefix here
# would make the regex pass for either form, silently accepting the regression (an absolute
# Location reaching a real client) this section exists to catch. Anchored to the relative form
# only, per the measurement.
#
# THE DOUBLED-`?` ROWS ARE NOT DECORATION. proxy.ts derives rawQuery with
# `.search.replace(/^\?/, "")` -- non-global, so it strips one `?` of two -- and canonicalize()
# used to THROW on a leading `?`, documented as "a wiring bug, not something a real request can
# trigger". proxy() has no try/catch around that call, so `GET /watch??x=1` was a 500 on every one
# of the twelve matcher paths, `/` and `/sitemap.xml` included, for any client. Measured at
# d109845, and re-measured against a served build by restoring the throw on top of the fix: the
# seven doubled-`?` rows below all 500, while their single-`?` neighbours all stay 307 -- so the
# branch that exists to bound an unbounded cache family had introduced an unbounded family of
# origin-hitting 500s. (Note which checks discriminate: the `is never cached` / `is never
# long-cached` pair stays GREEN on a 500, because Next's error response carries no-store of its
# own. Only the status and Location rows go red.) NO CHECK IN THIS FILE USED A DOUBLED `?`, which
# is exactly why neither `make app-smoke` nor `make image-smoke` saw it.
echo "==> canonical query gate"
for U in "/?utm_source=twitter|/" \
         "/watch?x=1|/watch" \
         "/watch??x=1|/watch" \
         "/watch???|/watch" \
         "/route/JFK-LAX?cachebust=99|/route/JFK-LAX" \
         "/route/JFK-LAX??cachebust=99|/route/JFK-LAX" \
         "/carrier/DL?utm_source=x|/carrier/DL" \
         "/airport/ORD??y=2019|/airport/ORD?y=2019" \
         "/carrier/DL??type=x|/carrier/DL?type=x" \
         "/aircraft/B737-8??carrier=x|/aircraft/B737-8?carrier=x" \
         "/robots.txt?x=1|/robots.txt" \
         "/sitemap.xml?x=1|/sitemap.xml" \
         "/sitemap.xml??x=1|/sitemap.xml"; do
  REQ="${U%%|*}"; WANT="${U##*|}"
  # Escaped, not interpolated raw: `.` in /robots.txt and /sitemap.xml, and `?` in the
  # /airport/ORD row, are ERE metacharacters, and the whole point of the `$` anchor is exactness.
  WANT_RE=$(re_escape "$WANT")
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}${REQ}")
  HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}${REQ}")
  LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
  check     "canonical: ${REQ} is a 307"            "$CODE" '307'
  check_re  "canonical: ${REQ} points at ${WANT}"   "$LOC"  "^[Ll]ocation: ${WANT_RE}$"
  check     "canonical: ${REQ} is never cached"     "$HDRS" 'no-store'
  check_not "canonical: ${REQ} is never long-cached" "$HDRS" 's-maxage'
done

# The redirect target must itself be canonical, or the 307 is a redirect loop rather than a fix.
# Asserted here on the wire and not only in canonicalQuery.test.ts, because the loop only exists
# once a real client follows the header: `-L` with a redirect cap turns "the location strips
# again" into a measurable non-200. `/airport/ORD??y=2019` is the fixture that needs it -- one
# hop, to a URL that still carries a query.
FOLLOW_CODE=$(curl -s -o /dev/null -w '%{http_code}'     -L --max-redirs 3 --max-time 20 "${BASE}/airport/ORD??y=2019")
FOLLOW_HOPS=$(curl -s -o /dev/null -w '%{num_redirects}' -L --max-redirs 3 --max-time 20 "${BASE}/airport/ORD??y=2019")
check    "canonical: following a doubled-? redirect settles at 200"  "$FOLLOW_CODE" '200'
check_re "canonical: ...in exactly one hop, so the target is clean" "$FOLLOW_HOPS" '^1$'

# `new URL(canonical.location, request.nextUrl.origin)` routes the canonical query back through a
# URL serializer -- the re-serialisation this whole codebase exists to route around (proxy.ts's
# rawQuery comment: Next's own form-encoding turned `k:a%2Cb,c` into `k%3Aa%2Cb%2Cc` and broke
# EVERY filtered query on both entry points). It is safe because the URL query percent-encode set
# is only C0 controls, space, `"`, `#`, `<`, `>` -- none of this format's punctuation -- but that
# property was pinned NOWHERE: every other Location assertion in this file uses an escape-free
# URL, so all of them would pass just as well against a serializer that mangled escapes. RESERVED
# (§2, the golden `filter_value_reserved_characters` values) is the fixture that discriminates.
# This is also the only served-build check that `/explore` -- the one row with a non-empty `keys`
# set -- 307s a junk key at all; the loop above covers seven other paths and never this one.
EXPLORE_LOC_RE=$(re_escape "/explore?${RESERVED}")
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${RESERVED}&bogus=1")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/explore?${RESERVED}&bogus=1")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check    "canonical: a junk key on a full /explore permalink is a 307" "$CODE" '307'
check_re "canonical: ...and every percent-escape survives byte-for-byte" "$LOC" \
  "^[Ll]ocation: ${EXPLORE_LOC_RE}$"
check    "canonical: ...uncached"                                     "$HDRS" 'no-store'

# The case that proves stripping KEEPS the legitimate key rather than discarding the query
# wholesale. A `check` substring needle would pass here even if `junk=1` survived.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/airport/ORD?y=2019&junk=1")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/ORD?y=2019&junk=1")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check    "canonical: a junk key beside y=2019 is a 307" "$CODE" '307'
check_re "canonical: ...and y=2019 survives it exactly" "$LOC" \
  "^[Ll]ocation: /airport/ORD\?y=2019$"

# The keyless family. `?&&` has no key to reject, so a key-presence rule serves it as a
# cacheable 200 -- which is why the predicate is byte-equality against the canonical string.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/watch?&&")
check "canonical: a keyless query is still a 307" "$CODE" '307'

# A duplicated key is NOT a redirect: choosing one occurrence would render a different query
# than the URL encodes. ?y=2019&y=2020 was a long-cached 200 at 4aa8087, because parseYear reads
# the first y.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/airport/ORD?y=2019&y=2020")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/ORD?y=2019&y=2020")
check     "canonical: a duplicated y renders rather than redirecting" "$CODE" '200'
check     "canonical: ...and is never cached"                        "$HDRS" 'no-store'
check_not "canonical: ...and is never long-cached"                   "$HDRS" 's-maxage'

# A two-filter permalink is a shape encode() itself emits (one f= per filter), so it must stay
# clean AND long-cached. This is the check that stands between `repeatable` and a broken product;
# no fixture in this file covered a repeated key before M8 Task 3.
TWO='v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&f=origin_state:OR&f=dest_state:WA&n=25&g=op'
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${TWO}")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/explore?${TWO}")
check "canonical: a two-filter permalink is a 200, not a redirect" "$CODE" '200'
check "canonical: ...and keeps the project Cache-Control"          "$HDRS" "$HTML_CACHE_EXPECTED"

# The exemptions, asserted rather than assumed. `exempt` means "the PROXY does not redirect this
# path", never "the rules do not apply to it": /api/pivot answers 400 + no-store itself, because a
# 307 on a JSON endpoint is a worse answer to an XHR than a named error.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?v=1&bogus=1")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?v=1&bogus=1")
check        "canonical: /api/pivot keeps its own 400" "$CODE" '400'
check        "canonical: ...under no-store"            "$HDRS" 'no-store'
# MINOR-ELEVATED 4 (whole-branch review round 2): this was `check_not ... 'location:'`, a
# case-sensitive grep -F, unlike every sibling Location assertion in this file (which all use
# `[Ll]ocation`). It passed only because Next happens to emit lowercase here -- a `Location:`
# (capital L) response would report a silent ok. `check_not_re` with `[Ll]ocation:` is the fix.
#
# KEEP THIS LINE ADJACENT TO THE `HDRS=` ABOVE. The final fix wave inserted three blocks between
# the two, each reassigning $HDRS, and this check ran against the LAST of them (`//evil.com`,
# which of course carries a Location) -- a red for a reason that had nothing to do with
# /api/pivot. A shared mutable haystack two screens from its assertion is the same shape as this
# file's three documented self-defects; every block added below opens with its own `HDRS=`.
check_not_re "canonical: ...and is not redirected"     "$HDRS" '[Ll]ocation:'

# Whole-branch review, Finding 2: the 400 above is about an unknown KEY, and says nothing about
# the keyless axis. urlstate.ts's splitPairs does `if (!chunk) continue`, so `?<valid permalink>&`,
# `&&`, `&&&`... all decoded cleanly and came back 200 under `s-maxage=2592000` -- 30 days, ten
# times any HTML page here, each entry a full pivot render, on the ONE path this gate had declared
# closed. Deliberate behaviour change on a public endpoint: 200 -> 400.
PIVOT_OK='v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op'
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${PIVOT_OK}&&")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?${PIVOT_OK}&&")
check        "canonical: /api/pivot 400s a keyless '&&' it used to cache for 30 days" "$CODE" '400'
check        "canonical: ...under no-store"                                           "$HDRS" 'no-store'
check_not    "canonical: ...never the 30-day header"                                  "$HDRS" 's-maxage'
check_not_re "canonical: ...and still never redirected"                               "$HDRS" '[Ll]ocation:'
# The control, and the only thing that distinguishes "the handler enforces the key set" from "the
# handler broke": the identical query WITHOUT the trailing chunks is still a 200 under the full
# 30-day header. §4 above asserts the header on a one-filter query; this pairs it with the /api
# behaviour change directly, on the same URL minus two bytes.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${PIVOT_OK}")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?${PIVOT_OK}")
check "canonical: the same /api/pivot query without them is a 200" "$CODE" '200'
check "canonical: ...under the project's 30-day header"            "$HDRS" "$CACHE_EXPECTED"
# A repeated `f=` is what encode() itself emits, and /api/pivot's row read `keys: NO_KEYS` while
# nothing evaluated it -- left that way, the gate above 400s every filtered query in the product.
BODY=$(curl -s --max-time 15 "${BASE}/api/pivot?v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&f=origin_state:OR&f=dest_state:WA&n=5&g=op")
check     "canonical: /api/pivot still answers a two-filter permalink" "$BODY" '"rows"'
check_not "canonical: ...without an error"                            "$BODY" '"error"'

# proxy.ts builds `Location` as `new URL(canonical.location, request.nextUrl.origin)`, and
# `new URL("//evil.com", origin)` is `http://evil.com/` -- an open-redirect SHAPE. It is
# unreachable for two independent reasons and neither is left as luck: no QUERY_ROWS predicate can
# claim a `//`-leading pathname (canonicalQuery.test.ts asserts it), and Next answers the request
# with its own 308 to the single-slash path before proxy() runs at all -- which is what this
# check measures. `check_not_re` on the host, so a Location that ever pointed off-box is a red
# here rather than a discovery in production.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}//evil.com?x=1")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}//evil.com?x=1")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check_not_re "canonical: //evil.com never redirects off this host" "$LOC" '[Ll]ocation: *(https?:)?//evil\.com'
check_re     "canonical: ...Next collapses it to a same-host path" "$LOC" '^[Ll]ocation: /evil\.com\?x=1$'
check        "canonical: ...as its own 308, before proxy() runs"   "$CODE" '308'

# CRITICAL 1 (whole-branch review round 2). An RSC request to a GATED path used to be an
# infinite redirect loop: this gate's canonicalize() saw Next's own `_rsc` cache-busting query
# param as an unknown key (not in any row's `keys`) and 307d it away; Next's OWN server then saw
# an RSC request with no `_rsc` (experimental.validateRSCRequestHeaders, default true) and 307d
# BACK to the URL WITH it -- the two alternated forever. Measured before the fix: the request
# below hit `--max-redirs 5` without ever reaching 200 (num_redirects pinned at 5, code stayed
# 307 the whole way). The fix answers an RSC request `no-store`, unconditionally, before
# canonicalize() ever runs, so the only redirect left on a gated path is Next's OWN single,
# legitimate hash-mismatch hop -- exactly the one hop `/search` (exempt from canonicalize
# entirely, never broken by this gate in the first place) has always taken, kept below as the
# control that discriminates "the bypass fixed a real interaction" from "nothing was ever wrong
# here": deleting the bypass must move the FIRST pair and leave this SECOND pair untouched.
echo "==> RSC requests never loop"
RSC_CODE=$(curl -s  -o /dev/null -w '%{http_code}'      -L --max-redirs 5 --max-time 15 -H 'RSC: 1' "${BASE}/watch?x=1")
RSC_HOPS=$(curl -s  -o /dev/null -w '%{num_redirects}'  -L --max-redirs 5 --max-time 15 -H 'RSC: 1' "${BASE}/watch?x=1")
check    "rsc: a gated path with an RSC header settles at 200, not a loop" "$RSC_CODE" '200'
check_re "rsc: ...in exactly Next's own one legitimate hop"                "$RSC_HOPS" '^1$'

SEARCH_RSC_CODE=$(curl -s -o /dev/null -w '%{http_code}'     -L --max-redirs 5 --max-time 15 -H 'RSC: 1' "${BASE}/search?q=DL")
SEARCH_RSC_HOPS=$(curl -s -o /dev/null -w '%{num_redirects}' -L --max-redirs 5 --max-time 15 -H 'RSC: 1' "${BASE}/search?q=DL")
check    "rsc: the control, /search (exempt from this gate), also settles at 200" "$SEARCH_RSC_CODE" '200'
check_re "rsc: ...in the SAME one hop -- unaffected by this fix either way"        "$SEARCH_RSC_HOPS" '^1$'

# Junk VALUES ride legitimate keys, so the key gate above cannot see them: /explore renders
# "This permalink can" plus a right single quote plus "t be read" as a 200, and that 200 was
# long-cached at 4aa8087 -- an unbounded family via ?d=junk1..N. Needle is the header, not the
# copy: the page's own sentence contains an apostrophe React emits as raw U+2019, which is
# exactly the shape of smoke.sh self-defect #2.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/explore?v=1&k=seg&d=junk&m=seats&t=2025-05:2026-04")
check     "canonical: an undecodable /explore permalink is never cached" "$HDRS" 'no-store'
check_not "canonical: ...and never long-cached"                          "$HDRS" 's-maxage'

# #52: the VALUE axis, which neither the key gate nor `decode()` can see. `decode()` validates
# identifiers, never values, so each URL below decoded cleanly and rendered a distinct 200 under
# HTML_CACHE. Cloudflare's default cache key is the whole query string, so every one was a
# guaranteed origin miss on the most expensive page here. `app/src/lib/pivot/bounds.ts` is the
# rule; this is the served-build proof. THREE families, not one:
#
#   value       `t` outside the dataset window (MONTH_RE admits 10,000 x 12 per side and required
#               no ordering), and `n` any integer at all.
#   spelling    `decode()` percent-decodes at urlstate.ts:179 and checks the shape at :214 -- 35
#               lines later -- so every byte of `t`, `k`, `d`, `m`, `s` and `g` may arrive as
#               `%XX` in either hex case. `t=2015-01:2015-12` alone has 110,592 spellings (2^12
#               digits x 3^2 hyphens x 3 for the colon), and `n`/`v` add leading zeros, a sign
#               and `_` separators on top. Bounding a value's RANGE bounds none of this.
#   repetition  `d` and `m` are split on `,` and nothing dedupes, so one token may repeat any
#               number of times -- measured on a served build at `m=seats` x200: a 661,824-byte
#               200 under HTML_CACHE, against 36,632 for the same query spelled once.
#
# `f` is exempt from the spelling rule and is the residual: percent-encoding is that key's own
# escape mechanism, so the exemption is load-bearing rather than an oversight. The two controls
# at the end of this block are what prove it, and what would redden for a blanket "no %" rule.
#
# NEEDLES CARRY NO APOSTROPHE, and that is measured rather than assumed. The messages read
# `time range 't' must ...` in the source, but `<p role="alert">{e.message}</p>` interpolates a
# RUNTIME string, so React escapes it -- the wire bytes are `time range &#x27;t&#x27; must ...`.
# A needle copied from the source would print `ok` for a string that is never present, which is
# this file's self-defect #2 exactly. Verified against this server before these lines were written.
#
# The trailing year is left OUT of the window needle on purpose: the upper bound is wall-clock
# (`lib/year.ts`'s maxValidYear), so `2015-01..2026-12` becomes `..2027-12` next January and a
# needle pinning it would go red with no defect present.
echo "==> value bounds on /explore and /api/pivot (#52)"
VB="v=1&k=seg&d=op_airline_id&m=seats&s=-seats&g=op"
for U in "t=1999-01:1999-12&n=25|must fall inside 2015-01..|a time range outside the data window" \
         "t=2026-04:2025-05&n=25|must start on or before it ends|a reversed range, both months in window" \
         "t=2025-05:2026-04&n=999999|must be at most 1000, got 999999|a limit above the ceiling" \
         "t=2025-05:2026-04&n=00000025|must be spelled as a plain decimal|a redundantly-spelled n" \
         "t=%32025-05:2026-04&n=25|must be spelled literally, without percent-encoding|a percent-encoded digit in t" \
         "t=2025-05%3A2026-04&n=25|must be spelled literally, without percent-encoding|a percent-encoded colon in t" \
         "t=2025-05%3a2026-04&n=25|must be spelled literally, without percent-encoding|lowercase-hex percent-encoding in t"; do
  VQ="${U%%|*}"; REST="${U#*|}"; NEEDLE="${REST%%|*}"; WHAT="${REST##*|}"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${VB}&${VQ}")
  HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${VB}&${VQ}")
  BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${VB}&${VQ}")
  check     "bounds: /explore rejects ${WHAT}"      "$BODY" "$NEEDLE"
  check     "bounds: ...as a 200 error page"        "$CODE" '200'
  check     "bounds: ...never cached"               "$HDRS" 'no-store'
  check_not "bounds: ...never long-cached"          "$HDRS" 's-maxage'
done

# The other two keys whose percent-encoded spelling is invisible to a range check, on their own
# curls because each needs a different VB. `k`, `d` and `s` are covered by the unit tests one per
# key; these two are the ones whose decoded value is a LIST or an enum, where the separator
# itself has a second spelling.
# Written out in full rather than derived from $VB by substitution: this file has produced three
# self-defects, and a needle or a URL assembled by string surgery is how the next one arrives.
for U in "v=1&k=seg&d=op_airline_id%2Cyear_month&m=seats&s=-seats&g=op|a percent-encoded structural comma in d" \
         "v=1&k=seg&d=op_airline_id&m=seats&s=-seats&g=%6Fp|a percent-encoded g"; do
  VB2="${U%%|*}"; WHAT="${U##*|}"
  BODY=$(curl -s                   --max-time 15 "${BASE}/explore?${VB2}&t=2025-05:2026-04&n=25")
  HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/explore?${VB2}&t=2025-05:2026-04&n=25")
  check "bounds: /explore rejects ${WHAT}"  "$BODY" 'must be spelled literally, without percent-encoding'
  check "bounds: ...never cached (${WHAT})" "$HDRS" 'no-store'
done

# The repetition family. Not a spelling variant -- the page really renders the column twice, and
# at 200 repeats that was a 661,824-byte 200 under HTML_CACHE -- and no raw-byte rule can see it,
# because every repeat is spelled the one legal way.
VBR="v=1&k=seg&d=op_airline_id&m=seats,seats&s=-seats&g=op"
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${VBR}&t=2025-05:2026-04&n=25")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${VBR}&t=2025-05:2026-04&n=25")
check "bounds: /explore rejects a repeated measure"   "$BODY" 'must appear once, got'
check "bounds: ...never cached (a repeated measure)"  "$HDRS" 'no-store'

# The control, and it is not optional: every check above is satisfied by an /explore that errors
# on everything and by a proxy that answers no-store to everything. This is the pair that has to
# stay green, and M16 (proxy branch forced to no-store) reddens it.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${VB}&t=2025-05:2026-04&n=25")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${VB}&t=2025-05:2026-04&n=25")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${VB}&t=2025-05:2026-04&n=25")
check     "bounds: the SAME query in bounds still renders"     "$CODE" '200'
check_not "bounds: ...with no error state"                     "$BODY" 'must be at most'
check     "bounds: ...and keeps the project Cache-Control"     "$HDRS" "$HTML_CACHE_EXPECTED"

# The SECOND control, and the one a blanket "no % anywhere" rule would redden: `f` is exempt from
# the spelling rule because percent-encoding is that key's own escape mechanism -- a filter value
# legitimately carries `,`, `:`, `&`, `=` and spaces, which is why `encode()` runs quote() over it
# and why golden case 8 carries `2T (1)`, `O'Hare`, `a!b` and `c*d` in one filter value list.
# Banning `%` there would break permalinks this product has already shipped, so the exemption is
# asserted, not assumed. (The DIMENSION that golden hangs its values on is not named here on
# purpose -- it is a reserved-character fixture, and which column it filters is incidental to what
# it pins.)
#
# The VALUE is `19790` (Delta) with every digit percent-encoded, not one of golden case 8's
# strings, because those strings are not castable to an INTEGER column and this control must
# isolate SPELLING from type. A non-numeric value on an integer-typed dimension is a different
# question entirely, owned by section 15b below. Every digit encoded still exercises exactly what
# this control is for: `%` reaching `f` and being admitted rather than refused.
FQ="v=1&k=seg&d=op_airline_id&m=seats&s=-seats&g=op&t=2025-05:2026-04&f=op_airline_id:%31%39%37%39%30&n=25"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${FQ}")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${FQ}")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${FQ}")
check     "bounds: a percent-encoded FILTER value is still admitted" "$CODE" '200'
check_not "bounds: ...with no spelling error state"                  "$BODY" 'without percent-encoding'
check     "bounds: ...and keeps the project Cache-Control"           "$HDRS" "$HTML_CACHE_EXPECTED"
# ...and the filter was APPLIED, not silently dropped: a 200 alone is also what an ignored `f`
# produces, which would make the three checks above true of the wrong page.
check     "bounds: ...and the filter resolved to its one carrier"    "$BODY" '>DL<'
check_not "bounds: ...with no other carrier in the table"            "$BODY" '>AA<'

# THE HREFS bounds.test.ts's corpus CANNOT REACH. That test scans the source for `/explore?`
# literals and deliberately skips anything containing `{` -- an interpolated href is built from a
# PivotQuery, so its admissibility is a property of the BUILDER, not of a string. True, and it
# leaves six `encode()`-built links (lib/topn.ts, lib/watch.ts and the four entity pages) with no
# test that they decode. Nothing is broken today: all six use limits 25/50/100 and windows from
# dataAsOf()/EARLIEST_MONTH/yearWindow(). But AIRCRAFT_MIX_LIMIT (10,000) and
# AIRPORT_ENDPOINT_LIMIT (5,000) live in two of those same files, and an href built from either
# would ship a dead permalink with no red test anywhere -- section 8's `/explore?` check asserts
# the substring is PRESENT, never that it resolves.
#
# So: follow the link this server actually emitted, whatever it says. Nothing here is
# dataset-pinned -- the window comes from the page's own dataAsOf(), so it moves with the dataset
# rather than against it, and this runs unchanged in container mode.
#
# The Cache-Control assertion is the load-bearing one: proxy.ts grants HTML_CACHE only when
# decodeRequest() SUCCEEDS, so a 200 under the project header IS the proof of admission.
RBODY=$(curl -s --max-time 15 "${BASE}/route/JFK-LAX")
EHREF=$(printf '%s' "$RBODY" | grep -o 'href="/explore?[^"]*"' | head -1 | sed 's/^href="//; s/"$//; s/&amp;/\&/g')
# Anti-vacuity, and not optional: an empty $EHREF would curl $BASE itself, which 200s -- the
# "answered by something else entirely" shape this file exists to refuse.
check_re "bounds: found the Explorer href /route BUILDS with encode()" "$EHREF" '^/explore\?v=1&k='
ECODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}${EHREF}")
EHDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}${EHREF}")
EBODY=$(curl -s                              --max-time 15 "${BASE}${EHREF}")
check     "bounds: ...following it renders"                    "$ECODE" '200'
check     "bounds: ...admitted, i.e. under the project header" "$EHDRS" "$HTML_CACHE_EXPECTED"
check_not "bounds: ...not a window rejection"                  "$EBODY" 'must fall inside'
check_not "bounds: ...not a ceiling rejection"                 "$EBODY" 'must be at most'
check_not "bounds: ...not a spelling rejection"                "$EBODY" 'without percent-encoding'

# /api/pivot reads the identical grammar and its SUCCESSES carry the 30-day PROJECT_CACHE -- ten
# times any HTML page here -- so excluding it would have left the longer-lived unbounded family
# outside the fix. 400, never 307: a JSON endpoint must not redirect an XHR (the same ruling the
# key gate above already follows on this path).
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${VB}&t=1999-01:1999-12&n=5")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/api/pivot?${VB}&t=1999-01:1999-12&n=5")
BODY=$(curl -s                              --max-time 15 "${BASE}/api/pivot?${VB}&t=1999-01:1999-12&n=5")
check        "bounds: /api/pivot 400s an out-of-window t"   "$CODE" '400'
check        "bounds: ...under no-store"                    "$HDRS" 'no-store'
check_not    "bounds: ...never the 30-day header"           "$HDRS" 's-maxage'
check_not_re "bounds: ...and is never redirected"           "$HDRS" '[Ll]ocation:'
check        "bounds: ...naming the range, not a bare 400"  "$BODY" 'must fall inside 2015-01..'

# The same endpoint's own control, at the 30-day header this bound is protecting.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${VB}&t=2025-05:2026-04&n=5")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/api/pivot?${VB}&t=2025-05:2026-04&n=5")
check "bounds: /api/pivot still 200s the same query in bounds" "$CODE" '200'
check "bounds: ...under the project's 30-day header"           "$HDRS" "$CACHE_EXPECTED"

# ---------------------------------------------------------------------------------------------
# 15b. Issue #87: a filter VALUE that cannot be cast to its dimension's COLUMN TYPE.
#
# The `f` residual that § "What this does not close" names is not only a cache-CARDINALITY
# problem. On an INTEGER-typed dimension a junk value decodes cleanly, binds as a parameter, and
# throws inside DuckDB at EXECUTION time -- after proxy.ts has resolved cacheability and already
# committed HTML_CACHE. Measured on a served build at 01ea39e, before the rule existed:
#
#   /explore   f=op_airline_id:2T%20%281%29     500  public, s-maxage=3600, ...
#   /explore   f=distance_group:99999           500  public, s-maxage=3600, ...
#   /explore   f=quarter:999                    500  public, s-maxage=3600, ...
#   /explore   f=route:99999999999-99999999999  500  public, s-maxage=3600, ...
#   /api/pivot (each of the above)              500  no-store, {"error":"internal error"}
#
# A CACHED 500 on the most expensive page here, for one unauthenticated GET -- and the first
# instance of § "The gap" reachable against a HEALTHY database, by URL alone. /api/pivot is NOT
# a cache exposure (its handler owns no-store); there it is an opaque 500 where a named 400 belongs.
#
# THREE THINGS THESE CHECKS EXIST TO PIN, each a bug a plausible fix still ships:
#
#  1. ALL-DIGITS IS NOT THE RULE. distance_group:99999, quarter:999 and op_airline_id:99999999999
#     are every one of them digits and every one of them throws -- SMALLINT, TINYINT and INTEGER
#     overflow respectively. A digits-only check copied from the `route` branch passes a test
#     written with '2T (1)' and still 500s: CLAUDE.md's "asserting an outcome the buggy
#     implementation also produces", pre-loaded. So distance_group:99999 carries the FULL header
#     set, not a status check -- it is the single case that kills a digits-only fix.
#
#  2. THE `route` BRANCH HAS THE SAME HOLE. isIntegerPair is /^\d+$/ with no width bound
#     (lib/pivot/render.ts), so route:99999999999-99999999999 passes validation and throws on the
#     cast. It is a DIFFERENT code path from the single-column IN branch -- different validation,
#     different SQL -- and it is the branch that already HAD a check and was still wrong, so it is
#     pinned in full rather than folded in as "another /explore case".
#
#  3. VARCHAR DIMENSIONS MUST NOT GET A NUMERIC CHECK. The type is READ from the catalog, never
#     inferred from the key name. aircraft_type is VARCHAR carrying zero-padded codes, and
#     f=aircraft_type:079 and f=aircraft_type:79 are DIFFERENT filters against real data --
#     measured here: 079 matches rows, 79 matches none. A canonical-integer rule applied to this
#     key would reject a permalink that works today AND re-open CLAUDE.md's zero-padding gotcha.
#     That pair is the regression guard, and both halves must stay 200.
#
# NEEDLE FORM, and it is this file's self-defect #2 in a new costume: React HTML-ESCAPES the
# apostrophes in the message. The served bytes are `filter value &#x27;2T (1)&#x27; for
# &#x27;op_airline_id&#x27; ...`, NOT render.ts's plain quotes -- so a needle copied from the
# source could never fire. Measured, not assumed, against the error page f=route:JFK-LAX already
# renders today. The key is therefore asserted BARE and INSIDE the isolated <p role="alert">
# region, and the phrase asserted is the stable `must be a plain whole number`, never the full
# wording (the rule's owner may still refine it).
F87="v=1&k=seg&d=op_airline_id&m=seats&s=-seats&g=op&t=2025-05:2026-04&n=25"
F87R="v=1&k=route&d=route&m=seats&t=2015-01:2016-12&s=-seats&n=5&g=op"
MSG87='must be a plain whole number'

# `between` returns its input UNCHANGED when the start marker is absent, so a needle asserted
# against a "region" extracted from a page that has none is answered by the WHOLE PAGE. Not
# hypothetical: Next's __next_error__ 500 page embeds the RSC flight payload, which echoes the
# request URL -- so `d=op_airline_id` appears SIX times in it and the page carries no `</p>` at
# all, and a bare `check "$ALERT" 'op_airline_id'` printed **ok** against the very 500 this
# section exists to fail. Measured at 01ea39e while writing these checks. This wrapper turns that
# silent pass into a guaranteed red, which is the only reason it exists.
alert_region() { # alert_region <body> -> the <p role="alert"> text, or a sentinel matching no needle
  has "$1" 'role="alert"' || { printf '%s' '(no alert region on this page)'; return; }
  between "$1" 'role="alert"' '</p>'
}

# --- A. /explore, the canonical case: non-numeric value on an INTEGER column. Full header set.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:2T%20%281%29")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:2T%20%281%29")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:2T%20%281%29")
# `check ... '200'`, never `check_not ... '500'`: a dead server scores 000 and would PASS the
# negative form -- self-defect #1 wearing a different hat.
check     "87: /explore does not 5xx on a non-numeric INTEGER filter value" "$CODE" '200'
check     "87: ...and is never cached"                                     "$HDRS" 'no-store'
check_not "87: ...so there is no long-cached 500 (the defect itself)"       "$HDRS" 's-maxage'
# Anti-vacuity, printing its own line because `between` returns its input UNCHANGED when the start
# marker is absent -- a silent-pass shape, and a cousin of self-defect #1. Measured at 01ea39e: on
# the 500 page the marker is absent and the "isolated" region came back as all 7,413 body bytes.
check     "87: ...rendering the named permalink error page, not Next's own 500" "$BODY" 'role="alert"'
ALERT=$(alert_region "$BODY")
check_not "87: ...and that region really is isolated (excludes the page's own body copy)" "$ALERT" 'known-valid'
check     "87: ...naming the rule"                     "$ALERT" "$MSG87"
check     "87: ...and naming the offending dimension"  "$ALERT" 'op_airline_id'

# --- B. /api/pivot, the canonical case. 400, never 307: a JSON endpoint must not redirect an XHR.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${F87}&f=op_airline_id:2T%20%281%29")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/api/pivot?${F87}&f=op_airline_id:2T%20%281%29")
BODY=$(curl -s                              --max-time 15 "${BASE}/api/pivot?${F87}&f=op_airline_id:2T%20%281%29")
check        "87: /api/pivot 400s a non-numeric INTEGER filter value" "$CODE" '400'
check        "87: ...under no-store"                                  "$HDRS" 'no-store'
check_not    "87: ...never the 30-day header"                         "$HDRS" 's-maxage'
check_not_re "87: ...and is never redirected"                         "$HDRS" '[Ll]ocation:'
check        "87: ...naming the rule, not an opaque internal error"   "$BODY" "$MSG87"
check        "87: ...and naming the offending dimension"              "$BODY" 'op_airline_id'

# --- C. The all-digit family. THESE are what a digits-only fix cannot survive.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=distance_group:99999")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${F87}&f=distance_group:99999")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=distance_group:99999")
check     "87: /explore does not 5xx on an over-width SMALLINT (distance_group:99999)" "$CODE" '200'
check     "87: ...and is never cached"                                                 "$HDRS" 'no-store'
check_not "87: ...so there is no long-cached 500"                                      "$HDRS" 's-maxage'
check     "87: ...rendering the named permalink error page"                            "$BODY" 'role="alert"'
ALERT=$(alert_region "$BODY")
check     "87: ...naming the rule"                    "$ALERT" "$MSG87"
check     "87: ...and naming the offending dimension" "$ALERT" 'distance_group'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=quarter:999")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=quarter:999")
ALERT=$(alert_region "$BODY")
check "87: /explore does not 5xx on an over-width TINYINT (quarter:999)" "$CODE" '200'
check "87: ...naming the rule"                    "$ALERT" "$MSG87"
check "87: ...and naming the offending dimension" "$ALERT" 'quarter'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:99999999999")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:99999999999")
ALERT=$(alert_region "$BODY")
check "87: /explore does not 5xx on an over-width INTEGER (op_airline_id:99999999999)" "$CODE" '200'
check "87: ...naming the rule"                    "$ALERT" "$MSG87"
check "87: ...and naming the offending dimension" "$ALERT" 'op_airline_id'

# --- D. The `route` pair branch -- a separate code path, and one that already had a check.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87R}&f=route:99999999999-99999999999")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${F87R}&f=route:99999999999-99999999999")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87R}&f=route:99999999999-99999999999")
check     "87: /explore does not 5xx on an over-width composite id pair" "$CODE" '200'
check     "87: ...and is never cached"                                   "$HDRS" 'no-store'
check_not "87: ...so there is no long-cached 500"                        "$HDRS" 's-maxage'
check     "87: ...rendering the named permalink error page"              "$BODY" 'role="alert"'
ALERT=$(alert_region "$BODY")
check     "87: ...naming the rule"                    "$ALERT" "$MSG87"
check     "87: ...and naming the offending dimension" "$ALERT" 'route'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${F87R}&f=route:99999999999-99999999999")
BODY=$(curl -s                              --max-time 15 "${BASE}/api/pivot?${F87R}&f=route:99999999999-99999999999")
check "87: /api/pivot 400s an over-width composite id pair" "$CODE" '400'
check "87: ...naming the rule"                              "$BODY" "$MSG87"
check "87: ...and naming the offending dimension"           "$BODY" 'route'

# The pair branch has TWO distinct refusals and they must stay distinguishable. ARITY is still the
# pre-existing message; a well-formed pair whose PART is not a number is now the value rule's, which
# is strictly more precise -- "JFK is not a whole number" rather than "give me two ids", when two
# ids is exactly what was given. Both are asserted, because a rule that collapsed them into one
# message would pass a check for either one alone.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${F87R}&f=route:JFK-LAX")
BODY=$(curl -s                              --max-time 15 "${BASE}/api/pivot?${F87R}&f=route:JFK-LAX")
check "87: /api/pivot still 400s a non-numeric composite pair" "$CODE" '400'
check "87: ...naming the whole-number rule, the part being the wrong SHAPE not the wrong COUNT" \
                                                              "$BODY" 'must be a plain whole number'
check "87: ...and naming the offending PART, not the whole value" "$BODY" "'JFK'"
check_not "87: ...not the arity message, which is a different fault" "$BODY" 'two ids joined by'

# The arity message itself, still reachable and still its own text -- one id where two belong.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${F87R}&f=route:12478")
BODY=$(curl -s                              --max-time 15 "${BASE}/api/pivot?${F87R}&f=route:12478")
check "87: /api/pivot 400s a composite value with only ONE id" "$CODE" '400'
check "87: ...under the pre-existing arity message"           "$BODY" 'two ids joined by'
check_not "87: ...which is NOT the whole-number rule"         "$BODY" 'must be a plain whole number'

# --- E. THE REGRESSION GUARD: VARCHAR dimensions keep working, zero-padding intact.
# 079 and 79 are different filters against real data. A rule that guessed "integer" from the key
# name, or that canonicalised leading zeros here, breaks the first and conflates it with the second.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=aircraft_type:079")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${F87}&f=aircraft_type:079")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=aircraft_type:079")
check     "87: a zero-padded VARCHAR filter still renders (aircraft_type:079)" "$CODE" '200'
check     "87: ...and keeps the project Cache-Control"                         "$HDRS" "$HTML_CACHE_EXPECTED"
check_not "87: ...and is NOT reached by the whole-number rule"                 "$BODY" "$MSG87"
# Dataset-pinned: WHICH rows 079 matches moves with the warehouse, but that it matches some is
# what makes the check above non-vacuous -- a 200 alone is also what a silently-empty filter gives.
check_dataset check_not "87: ...and the filter still matches rows" "$BODY" 'No rows match'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=aircraft_type:79")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=aircraft_type:79")
check "87: the UNPADDED spelling is a different filter, not an error (aircraft_type:79)" "$CODE" '200'
check_not "87: ...also not reached by the whole-number rule"                             "$BODY" "$MSG87"
check_dataset check "87: ...and it matches nothing, which is how 079 differs from 79"    "$BODY" 'No rows match'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=origin_state:2T%20%281%29")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${F87}&f=origin_state:2T%20%281%29")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=origin_state:2T%20%281%29")
check     "87: junk on a VARCHAR dimension is an ordinary empty result, not an error" "$CODE" '200'
check     "87: ...and keeps the project Cache-Control"                                "$HDRS" "$HTML_CACHE_EXPECTED"
check_not "87: ...and is NOT reached by the whole-number rule"                        "$BODY" "$MSG87"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${F87}&f=aircraft_type:079")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/api/pivot?${F87}&f=aircraft_type:079")
check "87: /api/pivot keeps serving a zero-padded VARCHAR filter" "$CODE" '200'
check "87: ...under the project's 30-day header"                  "$HDRS" "$CACHE_EXPECTED"

# --- F. The canonical-spelling axis (#52), unclosed on `f` until this rule. `0000019790` casts
# fine and renders a byte-identical page under a DISTINCT CDN key -- 30 days of them on /api/pivot,
# not the hour /explore gets. `encode()` emits neither spelling, so no shipped permalink breaks.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:0000019790")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:0000019790")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:0000019790")
check     "87: a non-canonical integer spelling does not 5xx (refusal is a page, not a crash)" "$CODE" '200'
check     "87: ...under no-store"                                       "$HDRS" 'no-store'
check_not "87: ...so it is not one more distinct cacheable key"         "$HDRS" 's-maxage'
check     "87: ...rendering the named permalink error page"             "$BODY" 'role="alert"'
ALERT=$(alert_region "$BODY")
check     "87: ...naming the rule"                                      "$ALERT" "$MSG87"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${F87}&f=op_airline_id:0000019790")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/api/pivot?${F87}&f=op_airline_id:0000019790")
check     "87: /api/pivot refuses the same spelling"                 "$CODE" '400'
check_not "87: ...so it never mints a 30-day key for a repeat page"  "$HDRS" 's-maxage'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:-1")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:-1")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:-1")
ALERT=$(alert_region "$BODY")
check "87: a negative integer does not 5xx either (it casts fine and matches nothing)" "$CODE" '200'
check "87: ...under no-store"                                                     "$HDRS" 'no-store'
check "87: ...naming the rule"                                                    "$ALERT" "$MSG87"

# --- G. THE CONTROLS. Without these, an /explore that errored on every filter and a proxy that
# answered no-store to everything would satisfy every check above.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:19790")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:19790")
BODY=$(curl -s                              --max-time 15 "${BASE}/explore?${F87}&f=op_airline_id:19790")
check     "87: the canonical spelling of the SAME id still renders" "$CODE" '200'
check     "87: ...and keeps the project Cache-Control"              "$HDRS" "$HTML_CACHE_EXPECTED"
check_not "87: ...with no whole-number error state"                 "$BODY" "$MSG87"
check     "87: ...and the filter resolved to its one carrier"       "$BODY" '>DL<'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/pivot?${F87}&f=op_airline_id:19790")
HDRS=$(curl -s -o /dev/null -D -            --max-time 15 "${BASE}/api/pivot?${F87}&f=op_airline_id:19790")
BODY=$(curl -s                              --max-time 15 "${BASE}/api/pivot?${F87}&f=op_airline_id:19790")
check     "87: /api/pivot still serves the canonical spelling" "$CODE" '200'
check     "87: ...under the project's 30-day header"           "$HDRS" "$CACHE_EXPECTED"
check_not "87: ...with no whole-number error"                  "$BODY" "$MSG87"

# ---------------------------------------------------------------------------------------------
# 15c. Issue #8: the four OG cards, asserted as PNG BYTES -- and the og:image URL the site's own
#      pages emit, fetched back exactly as a crawler fetches it.
#
# Under section 15 because half of it is the query gate: Next appends a cache-buster to a
# file-convention OG image URL, so the URL a crawler follows carries a query, and canonicalQuery
# admits it BY SHAPE on the four OG rows. That admission and the emission of the URL live in
# different modules with nothing joining them but a request -- which is why the round trip below
# is the check nothing else in this repo makes. If the admission regresses, proxy.ts 307s the
# site's own og:image off its buster and every card breaks on every share, with the app suite
# green.
#
# The card checks run in container mode too: a card is served HTML's sibling, not a host-only
# concern, and nothing here is dataset-pinned (the slugs are section 8/10/11/12's own, the PNG
# assertions are structural, and CARD_MIN_BYTES is a floor).
echo "==> OG cards (#8)"

# One card per entity type, on the slugs whose PAGES are already asserted above. A card is a
# second renderer over the same resolution and the same queries, so a slug that renders a page
# and not a card is exactly the defect this section exists to find.
check_png "card: /route/JFK-LAX is a 1200x630 PNG"   "/route/JFK-LAX/opengraph-image"
check_png "card: /airport/ORD is a 1200x630 PNG"     "/airport/ORD/opengraph-image"
check_png "card: /carrier/DL is a 1200x630 PNG"      "/carrier/DL/opengraph-image"
check_png "card: /aircraft/B737-8 is a 1200x630 PNG" "/aircraft/B737-8/opengraph-image"

# ONE HEADER ASSERTION PER MATCHER ROW, not one for the four of them. proxy.ts's matcher comment
# states the invariant this restores: every row in that list has a served-build header assertion
# and a served-build no-store assertion here, because nothing else in the repo crosses the
# matcher at all. A single /route assertion would leave three of the sixteen rows deletable with
# every gate green -- which is precisely what the check below is written to catch, since the card
# routes are the first matcher entries that are not pages (#8) and a sweep over "pages" misses
# them.
#
# `max-age=0` names the failure rather than leaving it as "some value other than HTML_CACHE":
# Next's own header for a card no proxy touched is `public, max-age=0, must-revalidate`, measured
# on a served build with exactly that mutation (M4, task-9-report.md).
for C in /route/JFK-LAX /airport/ORD /carrier/DL /aircraft/B737-8; do
  HDRS=$(curl -s -o /dev/null -D - --max-time 60 "${BASE}${C}/opengraph-image")
  check     "card: ${C} sets the HTML Cache-Control"                  "$HDRS" "$HTML_CACHE_EXPECTED"
  check_not "card: ${C} is not under Next's own header (proxy.ts ran)" "$HDRS" 'max-age=0'
done
# Once, not per row: `check_png` above already proves each card IS a PNG, so this is the header
# contract for the type, and a fifth copy of it would assert nothing a fourth did not.
HDRS=$(curl -s -o /dev/null -D - --max-time 60 "${BASE}/route/JFK-LAX/opengraph-image")
check     "card: is served as image/png" "$HDRS" 'content-type: image/png'

# THE ROUND TRIP. Next's own cache-buster is 16 hex digits, one per opengraph-image.tsx FILE:
# every /route/* card shares one, so it is not derivable from the slug and cannot be written as a
# literal here -- it has to be read off the page, which is also the only form that proves the two
# halves agree.
#
# Measured by mutant: dropping `cacheBuster` from canonicalQuery.ts's /route OG row turns exactly
# the three checks below red -- 307, `no-store`, and a 30-byte body that is the Location string --
# while the four bare-path card checks above stay green. That is the whole argument for fetching
# the emitted URL rather than the one this file could have written down.
BODY=$(curl -s --max-time 30 "${BASE}/route/JFK-LAX")
# `grep -oE` and never `-q` (the helpers' own rule). The pattern matches the HTML <meta> only:
# the same tag recurs further down this body inside the RSC flight payload as JSON-escaped
# `og:image\",\"content\":\"...`, which this cannot match, so `sed -n 1s` has one line to take.
OG_IMAGE=$(printf '%s' "$BODY" | grep -oE '"og:image" content="[^"]+"' \
           | sed -n '1s/.*content="\([^"]*\)".*/\1/p')
# The buster's PRESENCE is asserted, not assumed. Without this, a Next version that stopped
# emitting one would silently downgrade the fetch below into a second copy of the bare-path check
# five lines up -- a check that cannot fail for the reason it claims.
check_re "card: the page emits an og:image carrying Next's cache-buster" "$OG_IMAGE" \
  "$(re_escape "/route/JFK-LAX/opengraph-image")\?[0-9a-f]{16}$"
# Path and query only: the emitted URL is absolute against BASE_URL (lib/siteUrl.ts), which is
# the deployed host and never this server's bind address.
OG_PATH="/${OG_IMAGE#*://*/}"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "${BASE}${OG_PATH}")
HDRS=$(curl -s -o /dev/null -D -            --max-time 60 "${BASE}${OG_PATH}")
check     "card: the emitted og:image URL is served, not redirected" "$CODE" '200'
check     "card: ...under the HTML Cache-Control"                    "$HDRS" "$HTML_CACHE_EXPECTED"
check_png "card: ...and the bytes at that exact URL are the card"    "$OG_PATH"

# An unknown slug's card 404s and is never cached -- the dataset is rebuilt monthly, so a card
# 404 pinned in a shared cache outlives the condition that caused it, exactly as the page's does.
# Again one row of the matcher each, and on the same fixtures their PAGES already use in sections
# 8, 10 and 11: `ZZZZ` is no airport code at all, `ZZ` is in dim_carrier not at all, and
# `ZZZZ-LAX` is the route pair built from the first. Verified 404 on a served build before being
# relied on here, all three with `cache-control: no-store` and an empty body.
#
# The needle is the header LINE, not the bare value -- and it is also what proves proxy.ts ran on
# this path. A card 404 that fell out of the matcher carries NO Cache-Control at all (measured,
# M4), so a bare `no-store` needle would still be red for the right reason here, but a
# `must-revalidate` negative of the kind section 16 uses would NOT: there is no header to contain
# it. What a check can see depends on what the framework emits when the code under test is absent,
# and on this path it emits nothing.
for C in /route/ZZZZ-LAX /airport/ZZZZ /carrier/ZZ; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}${C}/opengraph-image")
  HDRS=$(curl -s -o /dev/null -D -            --max-time 30 "${BASE}${C}/opengraph-image")
  check     "card: ${C} is a 404"                "$CODE" '404'
  check     "card: ${C}'s 404 card is no-store"  "$HDRS" 'cache-control: no-store'
  check_not "card: ${C}'s 404 card is never cached" "$HDRS" 's-maxage'
done

# The ALLOW-LIST, on the card path. `/aircraft/CE-180` is `ambiguous`, not `notFound` (BTS codes
# 030 and 031 both slug to it), so an OG route written as `!== "notFound"` would rasterize a card
# for a slug the page 404s -- and proxy.ts would long-cache it. Same fixture, same reason, as the
# page check in section 12.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/aircraft/CE-180/opengraph-image")
HDRS=$(curl -s -o /dev/null -D -            --max-time 30 "${BASE}/aircraft/CE-180/opengraph-image")
check     "card: the ambiguous slug's card is a 404" "$CODE" '404'
check     "card: the ambiguous 404 card is no-store" "$HDRS" 'cache-control: no-store'
check_not "card: the ambiguous 404 card is never cached" "$HDRS" 's-maxage'

# ---------------------------------------------------------------------------------------------
# 15d. #125: the stylesheet the BROWSER gets still bounds the grid track.
#
# globals.test.ts holds the file-wide rule -- every `grid-template-columns` track is a fixed
# length, a percentage, or `minmax(0, ...)`, never a bare `1fr`/`auto` whose minimum is the
# item's own content. But that reads globals.css off disk. This is the other half: that the guard
# survives Tailwind v4 + Lightning CSS and reaches a browser. A minifier that rewrote
# `minmax(0,1fr)` back to `1fr` (they are NOT equivalent, but a naive normaliser would think so)
# would leave every unit test green and ship the bug.
#
# THE NEEDLES ARE THE MINIFIED BYTES, MEASURED FROM THE SERVED FILE, NOT COPIED FROM SOURCE.
# globals.css writes `@media (max-width: 920px)` and `minmax(0, 1fr)`; the build emits
# `@media (max-width:920px)` and `minmax(0,1fr)` -- no space after the colon, none after the
# comma. A needle copied from the source could never fire, which is this file's own documented
# trap.
#
# ORDERING IS LOAD-BEARING, and it was a real self-defect in this section before it shipped. The
# href is content-hashed, so it is extracted from the served page rather than pinned -- and when
# that extraction went stale against a rebuilt `.next`, `curl` returned "Internal Server Error"
# and the `check_not` below printed a confident **ok** for a string that was absent only because
# the fetch had failed. That is defect (1) in this file's header list, re-created. So the fetch
# is PROVEN to have returned the stylesheet before any negative check runs, and the proof is a
# positive needle on a rule that must be in it.
CSS_HREF=$(curl -s --max-time 30 "${BASE}/airport/BET" \
  | grep -o 'href="/_next/static/chunks/[^"]*\.css"' | head -1 | sed 's/href="//;s/"//')
check_re "responsive: the page links a built stylesheet" "$CSS_HREF" '^/_next/static/chunks/.+\.css$'
CSS_BODY=$(curl -s --max-time 30 "${BASE}${CSS_HREF}")
# THE FETCH GUARD, and simultaneously a real contract check. `.table-scroll` is the container the
# design system says owns the overflow instead of the body (docs/design/system.md, Quality floor);
# bounding the track is only half of that contract, and without this the fix would be a track that
# shrinks around a table that then simply clips. It is first because everything below it is only
# meaningful if this body is actually the stylesheet.
# NO NEEDLE HERE PINS DECLARATION ORDER. The obvious spelling of the guard,
# `.table-scroll{max-width:100%;overflow-x:auto}`, asserts that Lightning CSS emits `max-width`
# before `overflow-x` -- the REVERSE of the source order, i.e. a minifier-normalisation detail
# nobody chose. A version bump that renormalises would redden this and the checks behind it with
# no defect present. Same for the media block, whose rules could be emitted `.legend` first. So
# the selector's presence is the guard, and each property is asserted inside its own block by
# regex instead of by adjacency.
check "responsive: the served file is the stylesheet, not an error page" "$CSS_BODY" \
  '.table-scroll{'
check_re "responsive: the table keeps its own scroll container" "$CSS_BODY" \
  '\.table-scroll\{[^}]*overflow-x:auto'
# The collapsed single-column grid keeps its zero minimum. This is the bug. `[^@]*` cannot run
# past the block: this stylesheet is dense with @font-face rules on both sides of it.
check_re "responsive: the <=920px grid track keeps minmax(0,...) in the served CSS" "$CSS_BODY" \
  '@media \(max-width:920px\)\{[^@]*\.body\{grid-template-columns:minmax\(0,1fr\)\}'
# The desktop track, so this section fails loudly if the rail collapse is ever restructured rather
# than silently checking only the branch that was broken.
check "responsive: the wide grid still carries content + 214px rail" "$CSS_BODY" \
  '.body{grid-template-columns:minmax(0,1fr) 214px'
# The negative half, and it is not redundant with the positive one: a build emitting BOTH forms
# (a duplicated rule, a stale chunk concatenated after the fresh one) satisfies the check above
# while the last declaration still wins the cascade. The bug shipped as exactly these bytes.
check_not "responsive: no bare 1fr .body track survives the build" "$CSS_BODY" \
  '.body{grid-template-columns:1fr}'

# 15e. #145: the recovery window and the front door's sample are the LIVE trailing 12.
#
# WHY THIS IS A RELATIONSHIP AND NOT A NEEDLE. Both windows used to be frozen in source
# (`t=2025-05:2026-04`), which is a defect no gate could see: the window stayed INSIDE the
# dataset, so it kept decoding, kept rendering, and kept being cached under the project header --
# it merely stopped being "the trailing 12 months", which is what the prose beside it says it is.
# Measured when this shipped: the served window ended 2026-04 against a warehouse whose newest
# month was 2026-05.
#
# A needle pinned to the window's BYTES would catch that once and then rot on the next ingest --
# the exact failure mode WAREHOUSE_TAG's own note describes, and the reason these are NOT
# check_dataset calls. So both sides are read out of the SAME response: the served `DATA AS OF`
# badge, and the `t=` of the permalink that response emitted. Both move with the dataset, so this
# cannot rot, and it stays correct in container mode against a pinned asset.
#
# This is the only place the derivation is exercised in a PRODUCTION build, which is where
# __dirname, decodeURIComponent and query normalization all hid from a green unit suite.
#
# `date -u -d` does the month arithmetic rather than restating trailing12From: 11 months back
# from asOf, inclusive of asOf, is 12 months (mart_route_health's own `end_m - INTERVAL 11 MONTH`).
#
# The asOf extraction tolerates React's `<!-- -->` separator between adjacent text and expression
# children -- `<span className="asof">DATA AS OF {asOf}</span>` is exactly that shape, and a
# needle written in the bytes the SOURCE contains rather than the bytes React EMITS is this
# file's own self-defect #2.
asof_of() { # asof_of <body> -- the DATA AS OF month this response actually served
  printf '%s' "$1" \
    | grep -oE 'DATA AS OF (<!-- -->)?[0-9]{4}-[0-9]{2}' \
    | head -1 | grep -oE '[0-9]{4}-[0-9]{2}'
}
first_permalink() { # first_permalink <body> -- the first /explore? href, &amp; decoded
  printf '%s' "$1" | grep -o 'href="/explore?[^"]*"' | head -1 \
    | sed 's/^href="//; s/"$//; s/&amp;/\&/g'
}

# The recovery permalink, on a real dead end -- and NOT one of the five 404s, which cannot carry
# this check at all. MEASURED, not assumed: a thrown `notFound()` is served as Next's
# `<html id="__next_error__">` shell, whose body contains no `<h1>`, no `class="asof"` and no
# `href="/explore?..."` -- the whole page exists only inside the RSC flight payload, `&` spelled
# `\u0026`. `/carrier/ZZ` is 12,387 bytes with zero `<h1>`; `/watch/nope` is 9,760 the same way.
# That is pre-existing framework behaviour, not this section's business, but it means a needle
# written against a 404's HTML would be looking for bytes that are not there.
#
# `/search`'s no-match state is the dead end that IS server-rendered: a 200, real HTML, the same
# `DATA AS OF` badge and the same recovery permalink every 404 offers. `q` is deliberately junk --
# `/search` is `no-store` unconditionally, so this mints no cache entry.
BODY=$(curl -s --max-time 15 "${BASE}/search?q=zzzznotarealthing9999")
R_ASOF=$(asof_of "$BODY")
R_HREF=$(first_permalink "$BODY")
# Both extractions are anti-vacuity guards, and neither is optional: an empty $R_ASOF makes the
# computed needle 't=:' -- which `check` would then look for and not find, reporting FAIL for the
# wrong reason -- while an empty $R_HREF would let a `check` against "" pass having compared
# nothing the moment the needle were ever empty too.
check_re "recovery: /search no-match serves a DATA AS OF month"   "$R_ASOF" '^[0-9]{4}-[0-9]{2}$'
check_re "recovery: /search no-match emits an Explorer permalink" "$R_HREF" '^/explore\?v=1&k='
R_T12=$(date -u -d "${R_ASOF}-01 -11 months" +%Y-%m)
check    "recovery: its window is the trailing 12 ending at the DATA AS OF it served" \
  "$R_HREF" "t=${R_T12}:${R_ASOF}&"
# ...and it really is the RECOVERY query, not some other Explorer link that happens to be on the
# page. Without this the check above would pass for any permalink carrying the right window.
#
# TWO NEEDLES, because the title names two properties and ONE needle can only assert one of them:
# `d=op_airline_id&m=seats&t=` fixes the dimension and the single measure, and says nothing at all
# about the limit -- rewriting the served `n=25` to `n=50` left the single-needle form `ok`. A
# label that overstates what it asserts is the defect class of #147; the fix is to assert the
# second property, not to soften the label. The `n` needle carries its neighbours on both sides so
# it cannot match a different key's value.
check    "recovery: ...and it is the recovery query itself (m=seats)" \
  "$R_HREF" "d=op_airline_id&m=seats&t="
check    "recovery: ...and it asks for 25 rows, not some other limit" \
  "$R_HREF" "&s=-seats&n=25&g=op"

# The front door's sample -- a DIFFERENT query (four measures, for the gauge rail its prose
# promises), same rule. This is the one sentence a first-time visitor reads, and it is the one
# that said "over the trailing 12 months" above a window that was not.
BODY=$(curl -s --max-time 15 "${BASE}/")
H_ASOF=$(asof_of "$BODY")
H_HREF=$(first_permalink "$BODY")
check_re "home: the front door serves a DATA AS OF month"   "$H_ASOF"  '^[0-9]{4}-[0-9]{2}$'
check_re "home: the front door emits an Explorer permalink" "$H_HREF"  '^/explore\?v=1&k='
H_T12=$(date -u -d "${H_ASOF}-01 -11 months" +%Y-%m)
check    "home: the sample window is the trailing 12 ending at the DATA AS OF it served" \
  "$H_HREF" "t=${H_T12}:${H_ASOF}&"
# ...and it is still the SHOWCASE, not the escape hatch: the four measures the sentence beside it
# promises. A sweep collapsing it onto the single-measure recovery query leaves a working link
# under prose that has quietly stopped being true.
check    "home: the sample still selects the four measures its prose promises" \
  "$H_HREF" 'm=seats,departures_performed,load_factor,avg_gauge'

# ---------------------------------------------------------------------------------------------
# 16. M5 Task 7 Part A's fail-safe, verified end to end -- not just unit-mocked.
#
# proxy.test.ts pins isDataLayerHealthy() with `vi.mock`/`mockRejectedValueOnce`: a fast, precise
# unit test, but one that never crosses Next's own routing or a real DuckDB open the way this
# file's whole reason for existing requires. Whole-branch review handed this back explicitly:
# the claim motivating Task 7 -- "a served build pointed at a database missing a catalog view now
# returns /explore no-store instead of hosting.md's originally-measured 30-day-cached 500" -- was
# asserted in that task's report and in hosting.md's own "The gap" section, but never re-proven
# against an actual served build the way the ORIGINAL measurement (before the fix) was taken.
#
# Reproduces hosting.md's own method: drop `meta_pivot_dimensions` from a COPY of the database
# (never the original -- upgauge.duckdb is never written to by anything in this repo), point a
# SECOND, short-lived `next start` at that copy via UPGAUGE_DB, and curl /explore on it. The
# primary server is killed first -- an 8GB box with zram-only swap does not run two `next start`
# processes at once (this repo's own working agreement) -- so this section runs LAST and nothing
# after it needs $SERVER_PID alive.
# Container mode: skipped. This section starts its OWN short-lived `next start` against a
# broken database COPY -- it tests page and proxy behaviour against a broken catalog, nothing
# the container contributes, and containerising it would triple image runs for no new coverage.
# The skip is PRINTED (see the tally at the end of this file), never silent -- a smaller check
# count reported as though it were the same count is exactly the "266 ok against the wrong
# build" shape this file exists to refuse, one level up (a truncated total instead of a stale
# one).
if [ "$SMOKE_MODE" != "container" ]; then
echo "==> gap check: /explore against a database missing its pivot catalog (M5 Task 7 Part A)"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=

BROKEN_DB="$(mktemp -u "${TMPDIR:-/tmp}/upgauge-smoke-broken-XXXXXX.duckdb")"
cp "${ROOT}/upgauge.duckdb" "$BROKEN_DB"
# duckdb's own Python binding (already a pipeline dependency -- pyproject.toml), not the node
# driver: this needs a plain READ_WRITE open to DROP a view, and the node driver this app uses
# is opened READ_ONLY always (db.ts's own header: "This product never writes"), so reaching for
# it here would mean teaching this script to open the app's own database read-write, which is
# a much larger footgun than one Python one-liner against a throwaway copy.
if ! mise exec -- uv run python -c "
import duckdb
con = duckdb.connect('${BROKEN_DB}')
con.execute('DROP VIEW meta_pivot_dimensions')
con.close()
" >/tmp/upgauge-smoke-break.log 2>&1; then
  echo "  FAIL could not break the copy's catalog -- see /tmp/upgauge-smoke-break.log"
  FAILED=1
else
  GAP_PORT="${SMOKE_GAP_PORT:-3198}"
  GAP_BASE="http://127.0.0.1:${GAP_PORT}"
  port_free_or_die "$GAP_PORT"
  serve_next "$GAP_PORT" /tmp/upgauge-smoke-gap.log UPGAUGE_DB="$BROKEN_DB"
  GAP_PID=$!
  # "/" reads ONLY dataAsOf() (fct_segment_month directly), never meta_pivot_dimensions, so it
  # stays healthy on the broken copy and is a valid readiness probe -- unlike /explore itself,
  # which is the thing under test and must not be curled until the server is confirmed up.
  UP=0
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null --max-time 2 "${GAP_BASE}/" && { UP=1; break; }
    sleep 1
  done
  if [ "$UP" -ne 1 ]; then
    echo "  FAIL gap server never came up"; cat /tmp/upgauge-smoke-gap.log
    FAILED=1
  else
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${GAP_BASE}/explore?v=1")
    HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${GAP_BASE}/explore?v=1")
    check     "gap: /explore 5xxs against a database missing its pivot catalog" "$CODE" '500'
    check     "gap: /explore's Part A probe declines the cache" "$HDRS" "no-store"
    check_not "gap: /explore is never long-cached here"          "$HDRS" "s-maxage=2592000"
    check_not "gap: /explore is never HTML_CACHE here either"    "$HDRS" "s-maxage=3600"
    # Final whole-branch review, M2: the positive "declines the cache" check above repeats the
    # vacuity /search's own "is no-store" check (~100 lines up) was already fixed for -- Next's
    # OWN fallback header for a force-dynamic route that fell through proxy.ts's matcher
    # entirely (e.g. "/explore" dropped from `config.matcher`) is
    # `private, no-cache, no-store, max-age=0, must-revalidate`, which also contains the
    # substring "no-store". All four checks in this block stay green under a "remove /explore
    # from the matcher" mutant unless something here checks for the ONE token present in
    # Next's fallback and absent from proxy.ts's own `no-store` -- `must-revalidate`, the same
    # discriminator the /search block above already uses.
    check_not "gap: /explore is not Next's own force-dynamic fallback (proves proxy.ts ran)" "$HDRS" "must-revalidate"
  fi
  kill "$GAP_PID" 2>/dev/null; wait "$GAP_PID" 2>/dev/null; GAP_PID=
  kill_port "$GAP_PORT"
fi
rm -f "$BROKEN_DB"; BROKEN_DB=
fi

# ---------------------------------------------------------------------------------------------
# 17. M6 Task 8's own gap check -- /watch/gauge against a database missing `mart_route_health`,
#     NOT `meta_pivot_dimensions`. Same method as the block just above (a second, short-lived
#     `next start` against a broken COPY, never the original), but a different table dropped on
#     purpose: `mart_route_health` is what every preset query actually reads (runPreset()), and
#     it is NOT what `isDataLayerHealthy()` probes -- that function calls `loadAllowlist()`
#     alone (catalog_dimensions.sql / catalog_measures.sql, i.e. `meta_pivot_dimensions` /
#     `meta_pivot_measures`), which `/watch`'s own proxy branch reuses unchanged from /explore's
#     Part A fix (proxy.ts's own comment: "gate on isDataLayerHealthy() regardless of how closed
#     the slug set is").
#
#     MEASURED, against a served build, and the reason this section exists rather than restating
#     task-8-brief.md's own claim: dropping `mart_route_health` alone leaves `loadAllowlist()`
#     healthy, so the proxy commits to HTML_CACHE BEFORE WatchPresetView's runPreset() ever runs
#     -- and the page then throws. The response is a 500 WITH the cacheable HTML_CACHE header,
#     not without one. That is the OPPOSITE of what a first draft of this task assumed (a
#     database "missing mart_route_health" 5xxing "without a cacheable Cache-Control") -- and it
#     is exactly CLAUDE.md's already-documented, NOT-closed "residual 5xx cache gap" (M6 backlog
#     item 3: "a page-specific throw whose proxy resolution already succeeded ... is still
#     cached for up to an hour"), now shown to cover /watch/gauge too, not only /route and the
#     other three entity pages. Confirmed as the narrow cause, not guessed: dropping
#     `meta_pivot_dimensions` INSTEAD (leaving `mart_route_health` intact) correctly 500s
#     `/watch/gauge` under `no-store` -- the same probe that closes the gap for /explore closes
#     it here too, for the ONE failure mode it actually covers.
#
#     This section therefore asserts the REAL, measured behaviour -- a cacheable 500 -- as a
#     known, open gap, the same way this file would assert any other true-but-unwanted fact
#     about a served build. It is not a regression to "fix" in this task (Files: this task
#     touches `app/smoke.sh` and docs only); closing it would mean giving `isDataLayerHealthy()`
#     a `mart_route_health`-specific probe of its own, which is exactly the kind of DB round trip
#     `/route`'s own gap ("The gap", docs/architecture/hosting.md) was left open rather than pay
#     on every request.
# Container mode: skipped, for the same reason as the gap check above -- own broken-database
# COPY, own short-lived `next start`, no container-specific coverage. Printed, not silent.
if [ "$SMOKE_MODE" != "container" ]; then
echo "==> gap check: /watch/gauge against a database missing mart_route_health (M6 Task 8)"

BROKEN_DB2="$(mktemp -u "${TMPDIR:-/tmp}/upgauge-smoke-broken2-XXXXXX.duckdb")"
cp "${ROOT}/upgauge.duckdb" "$BROKEN_DB2"
# mart_route_health is a TABLE (CLAUDE.md's one licensed exception to "never store a derived
# measure" -- it has no time grain, so there is no GROUP BY of it for AVG() to corrupt), not a
# VIEW like meta_pivot_dimensions above -- DROP TABLE, not DROP VIEW.
if ! mise exec -- uv run python -c "
import duckdb
con = duckdb.connect('${BROKEN_DB2}')
con.execute('DROP TABLE mart_route_health')
con.close()
" >/tmp/upgauge-smoke-break2.log 2>&1; then
  echo "  FAIL could not break the copy's mart_route_health -- see /tmp/upgauge-smoke-break2.log"
  FAILED=1
else
  GAP_PORT2="${SMOKE_GAP_PORT2:-3195}"
  GAP_BASE2="http://127.0.0.1:${GAP_PORT2}"
  port_free_or_die "$GAP_PORT2"
  serve_next "$GAP_PORT2" /tmp/upgauge-smoke-gap2.log UPGAUGE_DB="$BROKEN_DB2"
  GAP_PID2=$!
  UP=0
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null --max-time 2 "${GAP_BASE2}/" && { UP=1; break; }
    sleep 1
  done
  if [ "$UP" -ne 1 ]; then
    echo "  FAIL gap server (mart_route_health) never came up"; cat /tmp/upgauge-smoke-gap2.log
    FAILED=1
  else
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${GAP_BASE2}/watch/gauge")
    HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${GAP_BASE2}/watch/gauge")
    check "gap: /watch/gauge 5xxs against a database missing mart_route_health" "$CODE" '500'
    # The residual gap, asserted as what IS true rather than what the brief first guessed:
    # this 500 goes out WITH the cacheable header, because isDataLayerHealthy() never touches
    # mart_route_health. `check`, not `check_not` -- the positive claim is the finding.
    check "gap: ...and it is NOT declined -- HTML_CACHE ships on a 500 (the open gap)" \
      "$HDRS" "$HTML_CACHE_EXPECTED"
  fi
  kill "$GAP_PID2" 2>/dev/null; wait "$GAP_PID2" 2>/dev/null; GAP_PID2=
  kill_port "$GAP_PORT2"
fi
rm -f "$BROKEN_DB2"; BROKEN_DB2=
fi

# ---------------------------------------------------------------------------------------------
# 18. M7 Task 10's own gap check -- /airport/ORD against a database whose dim_airport view is
#     missing its lat/lon COLUMNS, not the whole view and not a whole table. That distinction is
#     the point: dropping the whole view (or the whole dim_airport TABLE, mirroring section 16's
#     "TABLE not VIEW" note) would also break resolveAirportCode/airportCodesExist (both query
#     dim_airport too, for id/code/name -- lookup_airport_by_code.sql, lookup_airport_code_
#     exists.sql), which proxy.ts's own `isCacheable` call already wraps in a try/catch that
#     declines the cache on ANY failure -- so a whole-view break would produce the ALREADY-
#     handled case (a no-store 500), not the residual gap this section exists to demonstrate.
#     Dropping ONLY the coordinate columns (map_airport_coords.sql selects `lat`/`lon`; neither
#     entity-resolution query does) leaves slug resolution -- and therefore proxy.ts's
#     cacheability decision -- completely healthy, so `isCacheable` commits to HTML_CACHE, and
#     ONLY THEN does `fetchAirportNetwork`'s own query throw, inside the page, after the header
#     is already written.
#
#     MEASURED, against a served build (`next start` needs no rebuild for this -- the broken
#     copy is swapped in at runtime via UPGAUGE_DB, exactly like sections 15/16 above): the
#     response is a 500 WITH the cacheable HTML_CACHE header, not without one -- the EXACT same
#     shape section 16 measured for /watch/gauge against a missing mart_route_health, now
#     reached by the map path via a DIFFERENT table/columns and a DIFFERENT page.
#     `isDataLayerHealthy()` only ever probes `loadAllowlist()` (meta_pivot_dimensions /
#     meta_pivot_measures); it has never had anything to do with dim_airport's coordinates, so
#     this was not a regression Task 8 introduced -- it is CLAUDE.md's already-documented
#     "residual 5xx cache gap" (backlog item 3), now confirmed to reach a THIRD page family (the
#     four entity pages generally, /watch/gauge specifically, and now the map on /airport/<code>
#     specifically) via a THIRD distinct cause. Not fixed here (Files: this task touches
#     app/smoke.sh and docs only) -- see docs/architecture/hosting.md § "The gap".
#
#     `/route/JFK-LAX` is curled alongside as a sanity check that this break is scoped to the
#     coordinate columns and not the whole dim_airport view: that page also resolves airport
#     codes through dim_airport (via resolve.ts) but never reads lat/lon, so it must stay a
#     healthy 200 under this exact break -- if it didn't, the break would be wider than claimed
#     and this section would be measuring the wrong thing.
# Container mode: skipped, for the same reason as the two gap checks above -- own broken-
# database COPY, own short-lived `next start`, no container-specific coverage. Printed, not
# silent.
if [ "$SMOKE_MODE" != "container" ]; then
echo "==> gap check: /airport/ORD against a database missing dim_airport's lat/lon columns (M7 Task 10)"

BROKEN_DB3="$(mktemp -u "${TMPDIR:-/tmp}/upgauge-smoke-broken3-XXXXXX.duckdb")"
cp "${ROOT}/upgauge.duckdb" "$BROKEN_DB3"
if ! mise exec -- uv run python -c "
import duckdb
con = duckdb.connect('${BROKEN_DB3}')
con.execute(\"CREATE OR REPLACE VIEW dim_airport AS SELECT * EXCLUDE (lat, lon) FROM read_parquet('data/parquet/dims/dim_airport.parquet')\")
con.close()
" >/tmp/upgauge-smoke-break3.log 2>&1; then
  echo "  FAIL could not break the copy's dim_airport coordinates -- see /tmp/upgauge-smoke-break3.log"
  FAILED=1
else
  GAP_PORT3="${SMOKE_GAP_PORT3:-3196}"
  GAP_BASE3="http://127.0.0.1:${GAP_PORT3}"
  port_free_or_die "$GAP_PORT3"
  serve_next "$GAP_PORT3" /tmp/upgauge-smoke-gap3.log UPGAUGE_DB="$BROKEN_DB3"
  GAP_PID3=$!
  UP=0
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null --max-time 2 "${GAP_BASE3}/" && { UP=1; break; }
    sleep 1
  done
  if [ "$UP" -ne 1 ]; then
    echo "  FAIL gap server (dim_airport coords) never came up"; cat /tmp/upgauge-smoke-gap3.log
    FAILED=1
  else
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${GAP_BASE3}/airport/ORD")
    HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${GAP_BASE3}/airport/ORD")
    check "gap: /airport/ORD 5xxs against a database missing dim_airport's lat/lon" "$CODE" '500'
    # The residual gap, asserted as what IS true rather than a hoped-for fix: `check`, not
    # `check_not` -- the positive claim (a cacheable 500) is the finding.
    check "gap: ...and it is NOT declined -- HTML_CACHE ships on a 500 (the open gap)" \
      "$HDRS" "$HTML_CACHE_EXPECTED"
    # The scope check: this break must NOT reach a page that resolves airport codes but never
    # reads their coordinates, or the section would be claiming a wider break than it made.
    CODE_ROUTE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${GAP_BASE3}/route/JFK-LAX")
    check "gap: /route/JFK-LAX is unaffected (the break is scoped to coordinates)" "$CODE_ROUTE" '200'
  fi
  kill "$GAP_PID3" 2>/dev/null; wait "$GAP_PID3" 2>/dev/null; GAP_PID3=
  kill_port "$GAP_PORT3"
fi
rm -f "$BROKEN_DB3"; BROKEN_DB3=
fi

# This DELIBERATELY narrows criterion 1 in the M5/M6/M7 tasks above, which each ask for the
# full suite -- container coverage is the served-build checks only. Silent truncation reads as
# "covered everything" when it did not, so the narrowing is printed rather than left for someone
# to notice by diffing an ok-count against host mode.
if [ "$SMOKE_MODE" = "container" ]; then
  echo "==> host-only sections NOT run in container mode (3):"
  echo "    - /explore against a database missing meta_pivot_dimensions (M5 Task 7 Part A)"
  echo "    - /watch/gauge against a database missing mart_route_health (M6 Task 8)"
  echo "    - /airport map against dim_airport missing lat/lon (M7 Task 10)"
  echo "    container coverage is the served-build checks only -- NOT the full suite."
fi

if [ "$DATASET_SKIPPED" -gt 0 ]; then
  echo "  dataset-pinned checks skipped: ${DATASET_SKIPPED} (SMOKE_DATASET_PINNED=0)"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "smoke: all checks passed"; else echo "smoke: FAILURES above"; fi
exit "$FAILED"
