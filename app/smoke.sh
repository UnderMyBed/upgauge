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

check() { # check <name> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n       expected to find: %s\n       got: %.300s\n' "$1" "$3" "$2"
    FAILED=1
  fi
}

check_not() {
  if printf '%s' "$2" | grep -qF -- "$3"; then
    printf '  FAIL %s\n       expected NOT to find: %s\n' "$1" "$3"
    FAILED=1
  else
    printf '  ok   %s\n' "$1"
  fi
}

check_re() {   # check_re <name> <haystack> <extended-regex>
  if printf '%s' "$2" | grep -qE -- "$3"; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n       expected to match: %s\n       got: %.300s\n' "$1" "$3" "$2"
    FAILED=1
  fi
}

check_not_re() {
  if printf '%s' "$2" | grep -qE -- "$3"; then
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
LOC=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/route/LAX-JFK" | grep -i '^location:' | tr -d '\r')
check     "route: reversed pair redirects"     "$CODE" '308'
check     "route: redirect targets canonical"  "$LOC"  '/route/JFK-LAX'

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/route/ZZZZ-LAX")
check     "route: unknown code is a 404"       "$CODE" '404'

echo
if [ "$FAILED" -eq 0 ]; then echo "smoke: all checks passed"; else echo "smoke: FAILURES above"; fi
exit "$FAILED"
