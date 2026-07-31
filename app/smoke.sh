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
# How many times a fixed string occurs in a body. Same no-`-q` discipline: `grep -o` reads to
# EOF and `wc` drains it, so printf always completes. Used where PRESENCE is not the claim --
# a band drawn in two pieces and a band drawn in one both contain the needle.
count()   { printf '%s' "$1" | grep -oF -- "$2" | wc -l | tr -d ' '; }

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
check "explore: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"
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
# The negative half of the gap pair below. JFK-LAX filed in all 136 months of the window
# (measured), so it must claim no gaps AND draw each band in exactly one piece.
check_not "chart: a route with no gaps claims none (JFK-LAX)" "$BODY" 'no filings'
check_re  "chart: an ungapped band is ONE path (JFK-LAX)" "$(count "$BODY" '<path fill="var(--g5)" d=')" '^1$'
BODY=$(curl -s --max-time 30 "${BASE}/route/ATL-MCO")
check "chart: a route with one gets the derived annotation (ATL-MCO)" "$BODY" 'B757-2 overtakes A321/LR · 2018'

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
# `>14747<`, not a bare `14747`: SEA's airport_id legitimately appears in this page's two
# Explorer permalinks (`f=origin_airport_id:14747`), which is why the task-2 handoff's "must not
# contain 14747" cannot be taken literally. The claim is that no CELL renders the raw id.
check_not "airport: renders no bare AIRPORT_ID" "$BODY" '>14747<'
check     "airport: the chart SVG is in the served HTML" "$BODY" '<svg role="img"'
check     "airport: ramp tokens reach the area fills (lightest)" "$BODY" '<path fill="var(--g0)" d='
check     "airport: ramp tokens reach the area fills (darkest)"  "$BODY" '<path fill="var(--g5)" d='
# The positive half of /aircraft's "not by aircraft type" below. An absence check whose needle
# is served by no page in the app is an absence check that can never fire; this is the page that
# proves the string exists and reaches the served bytes.
check     "airport: the chart stacks by aircraft type" "$BODY" 'Seats by aircraft type'

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/airport/SEA")
check     "airport: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/airport/sea")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/sea")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "airport: lower-case code redirects"  "$CODE" '308'
check     "airport: redirect targets canonical" "$LOC"  '/airport/SEA'
# The 308 target here is `toUpperCase()` and nothing else -- resolveAirportCode redirects on case
# BEFORE it looks anything up -- so it cannot be invalidated by an ingest and stays long-cached,
# same as /route's. (`/airport/zzzz` therefore gets a cached 308 to `/airport/ZZZZ`, which then
# 404s no-store. That is the correct split: the redirect is a fact about the string.)
check     "airport: 308 keeps the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"

for A in ZZZZ LHR; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/airport/${A}")
  HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/airport/${A}")
  check     "airport: ${A} is a 404"                 "$CODE" '404'
  check_not "airport: 404 (${A}) is not long-cached" "$HDRS" "s-maxage=2592000"
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
check     "carrier: the chart SVG is in the served HTML" "$BODY" '<svg role="img"'
check     "carrier: ramp tokens reach the area fills (lightest)" "$BODY" '<path fill="var(--g0)" d='
check     "carrier: ramp tokens reach the area fills (darkest)"  "$BODY" '<path fill="var(--g5)" d='
check     "carrier: the page states the chart's own window" "$BODY" 'chart: the full window · 2015-01 → 2026-04'

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/carrier/DL")
check     "carrier: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"

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
check     "carrier: 308 keeps the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"

# ZZ is in dim_carrier not at all; PA (Pan American) is in it three times and has filed zero
# T-100 Segment rows. Both 404 by the same path, which is why the reason talks about FILINGS
# rather than recognition -- 1,543 of dim_carrier's 1,657 DISTINCT codes land in PA's bucket
# (1,657 - 114 fact-present; 1,776 is the table's ROW count, one per airline_id), so a
# "unknown carrier code 'PA'" wording would be false about the majority 404 (pipeline.md § M4d).
for C in ZZ PA; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/carrier/${C}")
  HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/carrier/${C}")
  BODY=$(curl -s --max-time 15 "${BASE}/carrier/${C}")
  check     "carrier: ${C} is a 404"                 "$CODE" '404'
  check_not "carrier: 404 (${C}) is not long-cached" "$HDRS" "s-maxage=2592000"
  check     "carrier: 404 (${C}) is no-store"        "$HDRS" "no-store"
  check     "carrier 404: names the offending code (${C})" "$BODY" "no carrier with code '${C}' has filed"
done
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

HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/B737-8")
check     "aircraft: sets the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"

# The slug transform, end to end. 16 of the 112 fact-present short names carry a `/` or a space,
# so `/aircraft/A321/LR` is TWO path segments and can never match this route -- the design spec's
# own worked example was unroutable. `A321-LR` must resolve to the name `A321/LR` and render it.
BODY=$(curl -s --max-time 30 "${BASE}/aircraft/A321-LR")
check     "aircraft: a slugged name resolves and renders unslugged" "$BODY" '>A321/LR<'
HDRS=$(curl -s -o /dev/null -D - --max-time 30 "${BASE}/aircraft/A321-LR")
check     "aircraft: sets the project Cache-Control on a slugged name" "$HDRS" "$CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/aircraft/a321-lr")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/aircraft/a321-lr")
LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
check     "aircraft: lower-case slug redirects"  "$CODE" '308'
# To the SLUG, never to `/aircraft/A321/LR`, which is unroutable.
check     "aircraft: redirect targets the canonical slug" "$LOC" '/aircraft/A321-LR'
check_not "aircraft: redirect does not target the unroutable raw name" "$LOC" '/aircraft/A321/LR'
check     "aircraft: 308 keeps the project Cache-Control" "$HDRS" "$CACHE_EXPECTED"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/aircraft/NOPE-1")
HDRS=$(curl -s -o /dev/null -D - --max-time 15 "${BASE}/aircraft/NOPE-1")
BODY=$(curl -s --max-time 15 "${BASE}/aircraft/NOPE-1")
check     "aircraft: an unknown slug is a 404"      "$CODE" '404'
check_not "aircraft: 404 is not long-cached"        "$HDRS" "s-maxage=2592000"
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
check_not "aircraft: the ambiguous 404 is not long-cached"   "$HDRS" "s-maxage=2592000"
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
