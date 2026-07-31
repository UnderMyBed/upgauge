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
BASE="http://127.0.0.1:${PORT}"
CACHE_EXPECTED="public, s-maxage=2592000, stale-while-revalidate=86400"
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

cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; pkill -f "next start app -p ${PORT}" 2>/dev/null; }
trap cleanup EXIT

cd "$ROOT"
echo "==> build"
cap 4G mise exec -- npm --prefix app run build >/dev/null 2>&1 || { echo "  FAIL build"; exit 1; }

echo "==> serve on :${PORT}"
cap 2G mise exec -- npx next start app -p "$PORT" >/tmp/upgauge-smoke.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do curl -sf -o /dev/null --max-time 2 "${BASE}/" && break; sleep 1; done
curl -sf -o /dev/null --max-time 2 "${BASE}/" || { echo "  FAIL server never came up"; cat /tmp/upgauge-smoke.log; exit 1; }

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
check_not "explore: reserved-character permalink is not rejected" "$BODY" 'can&rsquo;t be read'

# 3. An invalid permalink still names the offending key rather than falling back to a default.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=nope&m=seats&t=2025-05:2026-04&n=5&g=op")
check "explore: invalid permalink names the key" "$BODY" 'unknown dimension'

# 4. A query that did not select departures_performed must not mark every row below floor.
BODY=$(curl -s --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op")
check_not "explore: no false below-floor marking without a departure count" "$BODY" 'data-below-floor="true"'
check "explore: DATA AS OF is present" "$BODY" 'DATA AS OF'

# 5. The caching header is the cost control, so it is a test, not a hope.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=5&g=op")
check "explore: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op")
check "api: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/api/pivot?v=1&bogus=1")
check "api: does not cache an error" "$HDRS" "no-store"

# 6. The front door is ours, not the scaffold's.
BODY=$(curl -s --max-time 15 "${BASE}/")
check_not "home: no create-next-app boilerplate" "$BODY" 'vercel.com/new'

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

# Critical fix, final whole-branch review: this section copied the body checks above but not
# a header check, which is exactly why /route shipped `no-store` -- every OTHER check here
# passes whether or not the Cache-Control header is set. See proxy.ts and CLAUDE.md's "every
# response gets Cache-Control" rule.
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/route/JFK-LAX")
check     "route: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"

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
check     "route: 308 keeps the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"

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
  check_not "route: 404 (${P}) is not long-cached" "$HDRS" "s-maxage=2592000"
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
# JFK-LAX's A321/LR leads every year 2015-2026 (no crossover, 46% of routes are like this),
# and ATL-MCO's leader goes A321/LR -> B757-2 in 2018. If a data refresh moves ATL-MCO's
# crossover this check fails loudly and is re-measured; that is the point of pinning the
# derived string rather than the word.
check_not "chart: a route with no crossover gets NO annotation (JFK-LAX)" "$BODY" 'overtakes'
BODY=$(curl -s --max-time 30 "${BASE}/route/ATL-MCO")
check "chart: a route with one gets the derived annotation (ATL-MCO)" "$BODY" 'B757-2 overtakes A321/LR · 2018'

# Page weight, recorded rather than asserted: the chart is ~136 months x 6 bands of path data
# on a force-dynamic page, and M4d mounts this same component on three more pages. A threshold
# here would be a number invented in a shell script; the measurement is the useful part.
printf '  note %s bytes of HTML for /route/JFK-LAX (32,087 before the chart, M4c task 6)\n' \
  "$(curl -s --max-time 30 "${BASE}/route/JFK-LAX" | wc -c)"

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
descendants() { printf '%s\n' "$1"; local c; for c in $(pgrep -P "$1" 2>/dev/null); do descendants "$c"; done; }
HANDLES=0
for p in $(descendants "$SERVER_PID"); do
  HANDLES=$(( HANDLES + $(ls -l "/proc/${p}/fd" 2>/dev/null | grep -c 'upgauge\.duckdb') ))
done
check_re "db: proxy, page and API share ONE DuckDBInstance (open handles = 1)" "$HANDLES" '^1$'

echo
if [ "$FAILED" -eq 0 ]; then echo "smoke: all checks passed"; else echo "smoke: FAILURES above"; fi
exit "$FAILED"
