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
  docker run -d --rm --name upgauge-smoke --read-only \
    -p "127.0.0.1:${1}:3000" "$SMOKE_IMAGE" >/dev/null
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
# above; /explore and every ENTITY_ROUTES page (/route, /airport, /carrier, /aircraft) -- both
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
curl -sf -o /dev/null --max-time 2 "${BASE}/api/health" || {
  echo "  FAIL server never came up"
  [ "$SMOKE_MODE" = "container" ] && docker logs upgauge-smoke 2>&1 | tail -30 \
                                  || cat /tmp/upgauge-smoke.log
  exit 1
}
assert_identity "$BASE"

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

# 5. The caching header is the cost control, so it is a test, not a hope.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=5&g=op")
check "explore: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op")
check "api: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?v=1&bogus=1")
check "api: does not cache an error" "$HDRS" "no-store"

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
check_not "chart: a route with no crossover gets NO annotation (JFK-LAX)" "$BODY" 'overtakes'
# The negative half of the gap pair below. JFK-LAX filed in all 136 months of the window
# (measured), so it must claim no gaps AND draw each band in exactly one piece.
check_not "chart: a route with no gaps claims none (JFK-LAX)" "$BODY" 'no filings'
check_re  "chart: an ungapped band is ONE path (JFK-LAX)" "$(count "$BODY" '<path fill="var(--g5)" d=')" '^1$'
BODY=$(curl -s --max-time 30 "${BASE}/route/ATL-MCO")
check "chart: a route with one gets the derived annotation (ATL-MCO)" "$BODY" 'B757-2 overtakes A321nXLR · 2018'

# M4c final review, F1, IN THE SERVED BYTES. HNL-LAS (7.07 M seats over the window) filed
# nothing at all for 2020-04..2020-09 -- six months INSIDE the --panel-2 band this chart
# labels "COVID -- in window on purpose." The shipped M4c built its x domain from the months
# PRESENT in the pivot result, so those six were not on the axis and Plot drew one straight
# edge from 37,441 seats down to 6,804 across them; a reader read roughly 30k, 22k, 15k seats
# for months that filed nothing. 14,198 of 22,950 route pairs (62%) have such a gap.
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
# 2026-04" above a chart that stops in 2022 -- the aria-label was already right, so only the
# text a sighted reader sees was wrong. 12,062 of 22,950 pairs last filed before the current
# trailing-12 window, so this branch is the majority case, not an edge.
#
# Checked HERE and not only in page.test.tsx because the fix's first form was `chart: {a} → {b}`
# -- adjacent JSX expressions, which React's SSR separates with `<!-- -->` in the served HTML.
# `textContent` skips comment nodes, so all 281 unit tests passed while this tier went red. That
# is the whole reason this file exists, and it is why the assertion below is over raw bytes.
BODY=$(curl -s --max-time 30 "${BASE}/route/ATL-CAK")
check     "chart: a subject that stopped filing names ITS range (ATL-CAK)" "$BODY" 'chart: 2015-01 → 2022-06'
check_not "chart: ...and does not claim the full window there"            "$BODY" 'chart: the full window'

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
# `origin OR dest` at SEA over 2025-05..2026-04 is 53,373,806 seats; an origin-only page renders
# every stat, row and band in the right shape and reads 26,710,000. Carrier and aircraft-type
# COUNTS are identical either way (13 and 25), so they are not discriminators -- see
# pipeline.md § M4d. Dropping the inclusion-exclusion overlap term instead reads 53,386,452.
check     "airport: counts BOTH endpoints, not just departures" "$BODY" '53,373,806'
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
# section warns can only be seen by a served build. asOf is 2026-04 as measured (M4d's own
# convention of hardcoding the current measured asOf elsewhere in this file, e.g. the carrier
# chart-window check below) -- 2015-2025 are complete calendar years and 2026 is partial.
BODY=$(curl -s --max-time 30 "${BASE}/airport/SEA?y=2019")
check     "airport?y: states the map's own calendar-year window"     "$BODY" 'map: calendar year 2019'
check     "airport?y: the track offers every year, 2019 marked current" "$BODY" '>2019<'
check_not "airport?y: a complete prior year is not called partial"   "$BODY" 'calendar year 2019 — partial'

BODY=$(curl -s --max-time 30 "${BASE}/airport/SEA")
check     "airport: the default view states the current year is partial" "$BODY" \
  '2026 is a partial year — filed through April 2026 only.'
check     "airport: the current year's own tick carries the asterisk"     "$BODY" '>2026*<'

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
check     "airport?y=1999: names the offending value and the covered range" "$BODY" \
  "unknown year '1999' — this dataset covers 2015–2026"
check_not "airport?y=1999: does not silently fall back to the default view" "$BODY" '53,373,806'

BODY=$(curl -s --max-time 15 "${BASE}/airport/SEA?y=nonsense")
check     "airport?y=nonsense: malformed input is the same named error, not a 500" "$BODY" \
  "unknown year 'nonsense'"

# 10c. M7 Tasks 4-8: the airport network map, in the served HTML. ORD, not SEA -- it is the
# database's own worst case (measured 267 destinations after the same-airport row is excluded,
# vs. SEA's much smaller network), so this is the section that would first show a truncation or
# a rendering blow-up if one existed. Same five-part discipline the M4d comment above states for
# every entity page (renders, Cache-Control, real-vs-bare id, chart/map svg, 404/308 caching),
# applied to the map specifically since nothing above this line has curled it at all: the map
# reached 718+ app tests green (docs/architecture/pipeline.md § M7 Task 8) and a clean `next
# build` while being reachable from no served route this file ever checked -- exactly M4c's
# "the component reached 262 green unit tests while mounted on no route at all" shape, now on
# the map.
#
# The `<svg ... role="img"` needle is anchored on `viewBox="0 0 960 500"` (this map's own fixed
# WIDTH/HEIGHT, networkMap.ts), not the bare `<svg role="img"` M4c's chart check uses -- that
# bare form also matches AircraftMixChart's own SVG (mounted on this same page, M7 Task 3 kept
# it) and, per the M4d comment two sections up, the per-row sparkline in DataTable. Anchoring on
# this map's own fixed pixel size is what makes the check a claim about the MAP rather than
# about any other SVG this page happens to also render.
BODY=$(curl -s --max-time 30 "${BASE}/airport/ORD")
check     "airport map: the network SVG is in the served HTML" "$BODY" \
  '<svg viewBox="0 0 960 500" width="960" height="500" role="img"'
# EXACTLY 267, not "at least" and not 268. ORD carries a same-airport row (53 rows / 73,082
# seats over the trailing 12 -- networkMap.ts's own NetworkMapInput doc) that renderNetworkMap
# deliberately excludes from the drawn set (a same-airport great circle has zero length and
# would draw an invisible mark atop the origin disc) while keeping its seats in the STATED
# total -- so 268 arcs worth of destinations produce 267 polylines, and a mutant that drew the
# same-airport row anyway would produce 268 here without moving any other check in this file.
# `count`, not `has`: presence alone cannot distinguish "the exclusion runs" from "it doesn't."
#
# NOT doubled the way M4c's chart-path checks are (a normal JSX SVG ships once in the HTML body
# and again, `<`-escaped to `<`, in the RSC flight payload) -- measured directly against
# this same served build: `<polyline` occurs exactly 267 times in the WHOLE response, because
# this SVG is a single pre-serialized string injected via `dangerouslySetInnerHTML`
# (NetworkMap.tsx), and Next's RSC payload re-encodes that string's own `<` as `<` before
# embedding it, so the literal 4-byte substring `<polyline` never appears a second time. A
# doubled-count assumption carried over from the chart checks would have made this section
# assert 534 and fail against the real build.
check_re  "airport map: exactly 267 polylines (same-airport arc excluded)" \
  "$(count "$BODY" '<polyline')" '^267$'
# An inset label -- ORD's own network reaches ak/hi/car (measured against this served build;
# see the `pac` absence below), each drawn as a labelled `<rect>`+`<text>` frame (INSETS,
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
# renders a map with no landmass, which is visually IDENTICAL to the legitimately-empty `pac`
# panel (docs/design/system.md § The map) -- so this is the map's own analogue of the
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
check     "carrier: the page states the chart's own window" "$BODY" 'chart: the full window · 2015-01 → 2026-04'
# Final whole-branch review, M11 (third of four canonical checks -- see /route's own comment).
check     "carrier: carries a self-referential canonical link (Task 2)" "$BODY" \
  '<link rel="canonical" href="http://localhost:3000/carrier/DL"'

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL")
check     "carrier: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"

# The other branch of the window line, and the negative half of the pair. VX (Virgin America)
# stopped filing in 2018-03; the chart is fetched over the full window and can only draw to
# there, so naming the REQUESTED window would put "the full window · … → 2026-04" over a chart
# that ends in 2018 -- M4c's bug, one page over. Both caveats render here too, with no table.
BODY=$(curl -s --max-time 30 "${BASE}/carrier/VX")
check     "carrier: a carrier that stopped filing names ITS range" "$BODY" 'chart: 2015-01 → 2018-03'
check_not "carrier: ...and does not claim the full window there"   "$BODY" 'chart: the full window'
check     "carrier: the caveats render without a table"            "$BODY" 'Operated, not marketed.'

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
# /route/ URL, and the two orderings disagree for 154 of 22,420 pairs. IFP/IAH is the fixture
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
#     `/watch/:preset` (dynamic segment, same shape as the four ENTITY_ROUTES rows, but gated by
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
# window): AS LAX-OGG is the single largest upgauge, gauge_delta +75.8; DL BOS-CVG the largest
# downgauge, -64.3. Presence in $BODY alone would be satisfied by a page that put both routes in
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
check     "watch/gauge: the upgauge table leads with AS LAX-OGG"   "$UP_TABLE"   'LAX–OGG'
check_not "watch/gauge: ...which is not in the downgauge table"    "$DOWN_TABLE" 'LAX–OGG'
check     "watch/gauge: the downgauge table leads with DL BOS-CVG" "$DOWN_TABLE" 'BOS–CVG'
check_not "watch/gauge: ...which is not in the upgauge table"      "$UP_TABLE"   'BOS–CVG'

# 14c. /watch/empty-planes -- one table, lowest load factor at a real-airliner gauge floor.
BODY=$(curl -s --max-time 15 "${BASE}/watch/empty-planes")
check "watch/empty-planes: renders"       "$BODY" '<h1>Empty Planes</h1>'
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/watch/empty-planes")
check "watch/empty-planes: sets the project Cache-Control" "$HDRS" "$HTML_CACHE_EXPECTED"
check     "watch/empty-planes: renders a carrier code"     "$BODY" '>AS<'
check_not "watch/empty-planes: renders no bare AIRLINE_ID" "$BODY" '>19930<'
# Final whole-branch review (M6), Minor #5: this page enumerated ONE of its two floors. The
# needle is the note's own words, never the bare digits -- a 25-row table of real seat counts
# contains "360" by coincidence (t12_seats of 360,442), the same trap the "50" mutant already
# sprang on this preset (task-6-report.md).
check "watch/empty-planes: discloses the departures floor too" "$BODY" '360 performed departures'
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
# 2015" about rows that had filed for years. `p12_months_present = 0` is a RE-ENTRY -- 334 of
# 688 qualifying rows (48.5%) and 17 of the 25 rendered had filed before the p12 window, worst
# case MQ AZO-ORD at 93 distinct months back to 2015-01. Both halves, in the served bytes: the
# accurate claim present AND the false one gone. All-ASCII needles for the reason above; the
# frame itself is a plain TS string literal (lib/watch.ts), not JSX, so it ships verbatim.
check     "watch/new-routes: states re-entry, not first appearance" "$BODY" 'not necessarily a first appearance'
check     "watch/new-routes: carries the measured count"            "$BODY" '334 of the 688'
check_not "watch/new-routes: no longer claims 'since 2015'"         "$BODY" 'since 2015'
# The SECOND false claim on this page, found by the re-review of the wave that fixed the first:
# mart_route_health's grain is (op_airline_id, route), so `p12_months_present = 0` says nothing
# about the OTHER carriers on that airport pair -- 521 of 688 (75.7%) and 25 of the 25 rendered
# had one, the #1 row (AS HNL-ITO) while HA/UA/WN filed 1,787,347 seats on it. This page has now
# shipped a false claim twice, so every one of them gets a served-byte guard, both directions.
check     "watch/new-routes: names the carrier, not the route (frame)" "$BODY" 'A route this carrier flew nothing on last year'
check     "watch/new-routes: names the carrier, not the route (note)"  "$BODY" 'this carrier filed nothing at all on this route'
check     "watch/new-routes: carries the unserved-route measurement"   "$BODY" '521 of the 688'
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
# 15. M5 Task 7 Part A's fail-safe, verified end to end -- not just unit-mocked.
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
# 16. M6 Task 8's own gap check -- /watch/gauge against a database missing `mart_route_health`,
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
# 17. M7 Task 10's own gap check -- /airport/ORD against a database whose dim_airport view is
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

echo
if [ "$FAILED" -eq 0 ]; then echo "smoke: all checks passed"; else echo "smoke: FAILURES above"; fi
exit "$FAILED"
