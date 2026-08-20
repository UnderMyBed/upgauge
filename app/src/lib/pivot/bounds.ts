import { EARLIEST_YEAR, maxValidYear, parseYear } from "@/lib/year";
import type { PivotQuery } from "@/lib/pivot/types";
import type { Allowlist } from "@/lib/pivot/allowlist";
import { decode, splitPairs, UrlStateError } from "@/lib/pivot/urlstate";

/** `/explore`'s and `/api/pivot`'s ADMISSION policy: which permalink values this server is
 * willing to answer, as opposed to which ones the permalink codec can parse. Issue #52.
 *
 * The two are deliberately different things, and this module exists so they stay different.
 * `lib/canonicalQuery.ts` closed the KEY axis -- every gated path declares its legitimate query
 * keys, and a non-canonical key set is a 307 under `no-store` rather than a cached 200 -- and
 * M8 Task 4 additionally required `/explore`'s permalink to `decode()`, which closed an
 * unbounded family of cacheable ERROR pages (`?d=junk1..N`). Neither closes the VALUE axis:
 * `decode()` validates identifiers against the catalog via `renderPivot`, never values, so
 * legitimate keys carrying arbitrary values decode cleanly and render a distinct, cacheable 200
 * under `HTML_CACHE` -- each one a full DuckDB render on the most expensive page on the site,
 * and each one a distinct CDN cache key, since Cloudflare's default key includes the whole query
 * string. Measured against the real codec before this module existed: `t=9999-12:0000-01`,
 * `n=999999999`, `n=00000000025`, `n=%32%35`, `n=%2B25` and `v=0001` all decoded without
 * complaint.
 *
 * WHY THIS IS NOT A CHECK INSIDE `decode()`, which is the obvious place and the wrong one.
 * `docs/product/features.md` states the codec's contract as "Reference implementation:
 * `pipeline/urlstate.py` (`encode`/`decode`); the TypeScript port must match it exactly", and
 * `pipeline/urlstate.py:64-68` records the reversed time range as a **"Known accepted gap ...
 * Not guarded here on purpose"**. Bounding values inside `decode()` would silently make the port
 * stricter than the spec it is pinned to and falsify a shipped product doc -- the hand-mirrored
 * -contract drift this project has paid for elsewhere. It would also make a frozen public codec
 * depend on `new Date()`. So the codec stays an exact port and the SERVER declines to answer a
 * narrower set, which is exactly the relationship `lib/year.ts` already has with `/airport`'s
 * `y`: no codec owns `parseYear` either. `bounds.test.ts` pins that boundary from the other side
 * -- bare `decode()` must still accept everything below.
 *
 * Pure: no database, no Next imports, no I/O, and (like `canonicalQuery.ts`, and for the same
 * measured reason) it never throws on any input. `proxy.ts` runs this before every `/explore`
 * request and has no try/catch around its gate; `canonicalize()` once threw on a leading `?`
 * that "only a wiring bug could produce" and 500ed all twelve matcher paths. `decodeRequest`
 * below is the one function here that throws, and it throws only `UrlStateError` -- the
 * exception all three entry points already catch. */

/** The largest `n` this server will answer.
 *
 * The value axis needs a ceiling that is a policy, not a discovered fact -- unlike `t`, whose
 * bound is the dataset's own window, there is nothing in the warehouse that says how many rows
 * a permalink may ask for. So it is stated here with what it costs, rather than asserted to be
 * "sane".
 *
 * An order of magnitude above the largest `n` this product ever puts in a permalink. The
 * app-emitted set is {25, 50, 100}: `TOPN_LIMIT` 25 (`/carrier`), the four pages' Explorer links
 * at 50, and 100 from `CARRIER_TYPE_LIMIT`, `watch.ts`'s `rawRowsPermalink` and `decode()`'s own
 * documented default. `AIRCRAFT_MIX_LIMIT` (10,000) and `AIRPORT_ENDPOINT_LIMIT` (5,000) are
 * larger but do NOT set this ceiling -- they are internal pivot limits feeding a chart and a
 * table, and neither ever reaches a URL.
 *
 * It is a page-weight bound as much as a cache-key one: the Explorer has no pagination, so every
 * one of `n` rows is serialised into the served HTML -- twice, body plus RSC payload
 * (docs/architecture/hosting.md § "The SVG is emitted twice per response"). MEASURED on a served
 * build, one query (`k=route&d=route&m=seats,load_factor,avg_gauge` over the full 2015-01..2026-04
 * window) at three limits:
 *
 *     n=25     73,300 bytes   145 ms
 *     n=100   240,014 bytes   141 ms
 *     n=1000  2,225,172 bytes 220 ms      <- this ceiling, ~2,225 bytes per rendered row
 *
 * So the ceiling costs 2.2 MB, comparable to `/sitemap.xml` (2.4 MB) and only reachable
 * deliberately -- the app's own largest permalink, n=100, is 240 KB. What it REFUSES is the part
 * that matters: before this bound `n` took any integer, so `n=100000` was a ~220 MB response
 * this box would have built, served and let a CDN store under a distinct key, once per spelling.
 * Re-measure rather than restate these if the ceiling moves. */
export const MAX_LIMIT = 1000;

/** A closed outcome, in the idiom `ParsedYear` and `Canonical` already use here: a new outcome
 * added later is handled explicitly by every caller rather than falling into a negation. */
export type BoundsVerdict = { kind: "ok" } | { kind: "rejected"; message: string };

const OK: BoundsVerdict = { kind: "ok" };

/** The canonical spelling of a non-negative integer, on the RAW bytes -- before `pyUnquote`, and
 * that ordering is the whole point. `%32%35` unquotes to `25`, so a check run after decoding
 * cannot see the difference between it and `n=25`. Leading zeros, a `+`/`-` sign, `_` digit
 * separators and surrounding whitespace are all accepted by `PY_INT_RE` (matching Python's
 * `int()`, which is the codec's job) and all denote a value this format has exactly one other,
 * shorter spelling for.
 *
 * `0` is admissible HERE on purpose: `n=0` is a non-positive limit, which `renderPivot`
 * (`render.ts:80-81`) already rejects by name, and re-diagnosing it as a spelling problem would
 * replace the accurate message with a worse one. */
const CANONICAL_NUMERAL = /^(0|[1-9][0-9]*)$/;

/** The two keys whose values are integers, and therefore the two with more than one spelling
 * per value. Every other key carries allowlisted identifier text (`k`, `d`, `m`, `s`, `g`), the
 * month shape (`t`, pinned to four digits by `MONTH_RE`, so it has no spelling freedom), or the
 * one piece of free text in the format (`f`). */
const NUMERAL_KEYS: ReadonlySet<string> = new Set(["v", "n"]);

/** Is this `YYYY-MM` inside the window this dataset can possibly cover?
 *
 * Delegates the range entirely to `lib/year.ts`'s `parseYear`, rather than restating it: `y` on
 * `/airport/:code` and `t` on `/explore` are two spellings of the same question, and one owner
 * for the data window is what stops them disagreeing. That also inherits `parseYear`'s
 * self-updating upper bound -- wall-clock, never a literal year, because BTS files after the
 * fact so `data_as_of` can never lead the real calendar, and the bound advances every January
 * with no code change.
 *
 * The bound is therefore YEAR-END, not the current wall-clock MONTH, and that is deliberate:
 * `/airport/ORD?y=2026` maps through `yearWindow(2026)` to `2026-01 -> 2026-12`, months past
 * `asOf`. A month-tight bound would refuse on `/explore` the very window `/airport` hands the
 * user, to save four months out of 144. Months past `asOf` simply return no rows, which is the
 * ordinary "no filing yet" shape every query here already handles. */
function monthInWindow(month: string): boolean {
  return parseYear(month.slice(0, 4)).kind === "year";
}

function windowLabel(): string {
  return `${EARLIEST_YEAR}-01..${maxValidYear()}-12`;
}

/** The dataset window and the row ceiling, over an already-decoded query. Total: any
 * `PivotQuery`, including one carrying a malformed month, yields a verdict rather than a throw.
 *
 * Messages name the offending value AND the valid range, per `docs/design/system.md`'s
 * invalid-permalink contract ("a full-page error naming the offending key and the allowed
 * values") and mirroring `/airport`'s `InvalidYearView`. They are plain ASCII on purpose: the
 * served-build checks in `app/smoke.sh` are written in the bytes React EMITS, and a needle
 * containing an entity or a curly apostrophe is that file's self-defect #2. */
export function checkBounds(q: PivotQuery): BoundsVerdict {
  if (!monthInWindow(q.timeFrom) || !monthInWindow(q.timeTo)) {
    return {
      kind: "rejected",
      message:
        `time range 't' must fall inside ${windowLabel()}, got ` +
        `'${q.timeFrom}:${q.timeTo}' -- this dataset covers no other months`,
    };
  }
  // Zero-padded YYYY-MM, so lexical order IS chronological. `encode()` never emits a reversed
  // range; `pipeline/urlstate.py` leaves it alone as a meaning question (a backwards range is a
  // plausible-if-surprising reading that returns zero rows), and this is the OTHER question --
  // a reversed spelling of every in-window range doubles the cache-key family for answers that
  // are empty by construction.
  if (q.timeFrom > q.timeTo) {
    return {
      kind: "rejected",
      message:
        `time range 't' must start on or before it ends, got '${q.timeFrom}:${q.timeTo}'`,
    };
  }
  // Deliberately silent about a non-positive limit: `renderPivot` owns that rule and states it
  // better ("limit must be a positive integer"). A second validator for one boundary is how two
  // rules drift into disagreeing.
  if (q.limit > MAX_LIMIT) {
    return {
      kind: "rejected",
      message: `limit ('n') must be at most ${MAX_LIMIT}, got ${q.limit}`,
    };
  }
  return OK;
}

/** One value, one spelling, for the two integer keys -- run on the raw query string.
 *
 * Bounding `n`'s VALUE does not bound `n`: `n=25`, `n=025`, `n=0025`, ... all decode to 25, so
 * the family is unbounded no matter what the ceiling is. Same hole on `v`, which must equal 1
 * and accepts `v=1`, `v=01`, `v=+1`, `v=%31`, ... This is the same defect as the value axis, one
 * spelling over, and it is invisible to `canonicalQuery.ts` (which decides the KEY set and never
 * inspects a value) and to `checkBounds` (which sees a number, not the bytes that produced it).
 *
 * Splits with the codec's own `splitPairs` rather than a second walk of the query string, for
 * the reason that function's own comment gives: decoding before every structural delimiter has
 * done its job corrupts a percent-encoded `,` inside a filter value. */
export function checkNumeralSpelling(qs: string): BoundsVerdict {
  for (const [key, raw] of splitPairs(qs)) {
    if (!NUMERAL_KEYS.has(key)) continue;
    if (!CANONICAL_NUMERAL.test(raw)) {
      const label = key === "v" ? "url version ('v')" : "limit ('n')";
      return {
        kind: "rejected",
        message: `${label} must be spelled as a plain decimal, got '${raw}'`,
      };
    }
  }
  return OK;
}

/** What a SERVER entry point calls instead of `decode()`: the codec, then this module's rules.
 *
 * One wiring point rather than the same three lines at three call sites -- the failure this
 * project keeps naming is a fourth entry point whose author copies three lines out of four
 * (`proxy.ts`'s `ENTITY_ROUTES` and `canonicalQuery.ts`'s `QUERY_ROWS` are both tables for that
 * reason). Its three callers today are `proxy.ts`'s `isExploreCacheable`, `app/api/pivot/
 * route.ts`, and `ExploreView`; `decode()` itself stays for the goldens and the codec tests.
 *
 * Throws `UrlStateError` and nothing else, so every downstream behaviour already exists:
 * `isExploreCacheable`'s `catch` returns `false` and the proxy answers `no-store`;
 * `/api/pivot`'s `instanceof UrlStateError` branch answers 400 + `no-store` (never a 307 -- a
 * JSON endpoint must not redirect an XHR); and `ExploreView`'s catch renders the named
 * "This permalink can't be read" page with the message wired through to the reader.
 *
 * ORDER MATTERS, in one respect. `decode()` runs FIRST, so an unknown key, a duplicate key, a
 * malformed `t` shape, an off-allowlist identifier and a non-positive limit all keep the exact
 * message they have today -- this module only ever narrows what is left. */
export function decodeRequest(qs: string, allowlist: Allowlist): PivotQuery {
  const query = decode(qs, allowlist);
  for (const verdict of [checkBounds(query), checkNumeralSpelling(qs)]) {
    if (verdict.kind === "rejected") throw new UrlStateError(verdict.message);
  }
  return query;
}
