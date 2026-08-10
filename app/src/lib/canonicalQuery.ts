import { ALLOWED_KEYS } from "@/lib/pivot/urlstate";
import { routeSlugFromPath } from "@/lib/rawPath";
import { airportSlugFromPath } from "@/lib/airport";
import { carrierSlugFromPath } from "@/lib/carrier";
import { aircraftSlugFromPath } from "@/lib/aircraftSlug";
import { presetSlugFromPath } from "@/lib/watch";

/** One canonical KEY SET per cacheable URL.
 *
 * Not "one canonical spelling", which is what this file and `docs/architecture/hosting.md` both
 * claimed first and is wider than anything here can deliver. What is decided below is byte-
 * equality over the KEYS a path reads: an unknown key, a keyless chunk, a trailing `&` and a
 * leading `?` are each non-canonical, but key ORDER survives (see rule 4), and VALUES are never
 * inspected -- `/explore?t=<any YYYY-MM>:<any YYYY-MM>` alone is ~10^8 distinct spellings that
 * every rule here calls clean. `docs/architecture/hosting.md` § "What this does not close" states
 * that axis and why a key table cannot express it.
 *
 * Measured on a served build at 4aa8087, before this file existed: every cacheable path accepted
 * arbitrary unknown query keys and still returned the long cache header -- `/watch?x=1`,
 * `/carrier/DL?utm_source=x`, `/route/JFK-LAX?cachebust=99` and `/explore?...&bogus=1` all 200
 * with `s-maxage=3600`; `/sitemap.xml?x=1` and `/robots.txt?x=1` with `s-maxage=2592000`, the
 * first of them a 2.4 MB document costing ~45 ms of DuckDB. Cloudflare's default cache key
 * includes the full query string, so `?x=1..N` mints an unbounded family of distinct entries,
 * each one a guaranteed origin miss -- against the exact cost model the CDN exists to protect
 * (docs/architecture/hosting.md § "The actual cost control is caching, not the tier"). That
 * document's § "The gap" already recorded this for `/sitemap.xml` alone, and said nothing
 * guarded the family; it was in fact all ten of the paths the proxy gates. `/api/pivot` is an
 * ELEVENTH cacheable path -- its own successes take the same 30-day `PROJECT_CACHE` -- and it was
 * not exempt from the disease either, only from the unknown-key symptom: its handler answered an
 * unknown key with 400, but `splitPairs` skips an empty chunk, so `?<valid permalink>&`, `&&`,
 * `&&&` and a LEADING `&` all returned 200 under `public, s-maxage=2592000,
 * stale-while-revalidate=86400` (measured by disabling the gate on top of the fix) -- 30 days, ten
 * times longer than any HTML page here. That is what `queryVerdict` (below) exists to let the
 * handler close.
 *
 * A table rather than a chain of `if`s, for the same reason `proxy.ts`'s `ENTITY_ROUTES` is one:
 * the failure being defended against is a future route whose author copies three lines out of
 * four. `QUERY_ROWS` is the THIRD list that must agree with `config.matcher` (canonicalQuery.test
 * .ts asserts it), alongside `ENTITY_ROUTES`.
 *
 * Pure: no database, no Next imports, no I/O, and it never throws on any input. That last part is
 * load-bearing and was got wrong once: this module used to throw on a `rawQuery` carrying a
 * leading `?`, on the argument that only a wiring bug could produce one. It could not have been
 * more reachable -- `proxy.ts`'s `new URL(request.url).search.replace(/^\?/, "")` strips ONE `?`,
 * so `GET /watch??x=1` (`search === "??x=1"`) handed this function `"?x=1"` and 500ed every one of
 * the twelve matcher paths, `/` and `/sitemap.xml` included, for any client. Measured against a
 * served build at d109845, and re-measured by restoring the throw on top of the fix: `/watch?x=1`
 * 307, `/watch??x=1` **500**. A leading `?` is not a wiring
 * bug, it is one more non-canonical spelling, and rule 0 below treats it as one.
 * `entitySlugFromPath` already catches `decodeURIComponent`'s throw on a malformed escape (`%zz`)
 * and falls back to the raw text, so every `matches` predicate below is total for the same
 * reason: on the proxy path an uncaught throw is a 500 on a request that was only ever going to
 * be a redirect. */
const NO_KEYS: ReadonlySet<string> = new Set();
const NONE_REPEATABLE: ReadonlySet<string> = new Set();
/** `encode()` emits one `f=` per filter (urlstate.ts:113-114) and `decode()` `continue`s past its
 * own duplicate check for `f`, so repeated `f` is a shape this app generates itself. Any
 * duplicate rule that does not exempt it breaks every multi-filter permalink. */
const EXPLORE_REPEATABLE: ReadonlySet<string> = new Set(["f"]);
/** `y` selects one calendar year's network map (app/airport/[code]/page.tsx, M7 Task 9). */
const AIRPORT_KEYS: ReadonlySet<string> = new Set(["y"]);
/** `/search`'s only key -- `app/search/page.tsx` reads `searchParams.q` and nothing else.
 * Declared truthfully even though nothing consumes this row's verdict today: `exempt` means "the
 * proxy does not redirect this path", never "the rules do not exist for it". */
const SEARCH_KEYS: ReadonlySet<string> = new Set(["q"]);

export type QueryRow = {
  /** The literal `proxy.ts` matcher entry this row answers for. The agreement test keys on it. */
  matcher: string;
  matches: (pathname: string) => boolean;
  /** Query keys this path legitimately reads. Everything else is stripped. */
  keys: ReadonlySet<string>;
  /** The subset of `keys` that may appear more than once. */
  repeatable: ReadonlySet<string>;
  /** Set when the PROXY must not redirect this path. The rules still apply to it -- `queryVerdict`
   * evaluates every row, exempt or not -- but `canonicalize`, which is the proxy's entry point and
   * only that, answers `clean` here, and whoever owns the path answers for itself. Set this and
   * the path's `keys` MUST still be true, or the row's owner acts on a lie. */
  exempt?: string;
};

export const QUERY_ROWS: ReadonlyArray<QueryRow> = [
  { matcher: "/", matches: (p) => p === "/", keys: NO_KEYS, repeatable: NONE_REPEATABLE },
  {
    matcher: "/explore",
    matches: (p) => p === "/explore",
    keys: ALLOWED_KEYS,
    repeatable: EXPLORE_REPEATABLE,
  },
  {
    matcher: "/airport/:code",
    matches: (p) => airportSlugFromPath(p) !== null,
    keys: AIRPORT_KEYS,
    repeatable: NONE_REPEATABLE,
  },
  {
    matcher: "/route/:pair",
    matches: (p) => routeSlugFromPath(p) !== null,
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
  },
  {
    matcher: "/carrier/:code",
    matches: (p) => carrierSlugFromPath(p) !== null,
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
  },
  {
    matcher: "/aircraft/:name",
    matches: (p) => aircraftSlugFromPath(p) !== null,
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
  },
  { matcher: "/watch", matches: (p) => p === "/watch", keys: NO_KEYS, repeatable: NONE_REPEATABLE },
  {
    matcher: "/watch/:preset",
    matches: (p) => presetSlugFromPath(p) !== null,
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
  },
  {
    matcher: "/sitemap.xml",
    matches: (p) => p === "/sitemap.xml",
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
  },
  {
    matcher: "/robots.txt",
    matches: (p) => p === "/robots.txt",
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
  },
  {
    // The SAME keys as /explore, and for the same reason: both entry points hand the identical
    // raw string to urlstate.ts's decode(). This row read NO_KEYS while it was exempt from the
    // rules as well as from the redirect, which was harmless only because nothing ever evaluated
    // it -- and would silently 400 every valid API query the moment something did.
    matcher: "/api/pivot",
    matches: (p) => p === "/api/pivot",
    keys: ALLOWED_KEYS,
    repeatable: EXPLORE_REPEATABLE,
    exempt:
      "the route handler owns its own Response, and a JSON endpoint must answer 400 rather than " +
      "307 (a redirect is a worse answer to an XHR than a named error). It calls queryVerdict() " +
      "itself -- app/api/pivot/route.ts -- so the rules below still bind it; only the proxy's " +
      "redirect does not.",
  },
  {
    matcher: "/search",
    matches: (p) => p === "/search",
    keys: SEARCH_KEYS,
    repeatable: NONE_REPEATABLE,
    exempt:
      "no-store unconditionally (proxy.ts's /search branch), so no shared-cache entry is " +
      "reachable to pollute, and /search must never redirect at all. Its unbounded ORIGIN load " +
      "is edge rate limiting's problem (#19), not this gate's. Nothing reads this row's verdict " +
      "today; its keys are declared truthfully regardless.",
  },
];

export type Canonical =
  | { kind: "clean" }
  | { kind: "reject"; reason: string }
  | { kind: "strip"; location: string };

/** Does `rawQuery` spell `pathname`'s query with the canonical key set? The RULES, applied to
 * every row -- exempt or not -- with no opinion about what the caller should do about the answer.
 *
 * `clean` -- yes, or this path is not ours to police. `reject` -- no, and there is no canonical
 * form to send the caller to. `strip` -- no, and `location` is the canonical URL.
 *
 * Two callers, two actions, one set of rules: `canonicalize` (below) is the PROXY's, which 307s a
 * `strip` and `no-store`s a `reject`; `app/api/pivot/route.ts` calls THIS function directly and
 * answers 400 + `no-store` to either, because a redirect is a worse answer to an XHR than a named
 * error. Neither restates a rule. That split exists because `exempt` used to short-circuit the
 * rules themselves, which left `/api/pivot?<valid permalink>&&&...` a 200 under a 30-day header --
 * the one path this file declared closed carrying the longest-lived unbounded family of the lot.
 *
 * `rawQuery` is `proxy.ts`'s `new URL(request.url).search.replace(/^\?/, "")`, or the identical
 * string off `RAW_QUERY_HEADER`. That regex is non-global, so on `GET /watch??x=1` it strips one
 * `?` of two and this function receives `"?x=1"` -- see rule 0.
 *
 * Rules, in order:
 *
 * 0. Drop any leading `?`s before anything else. A `?` at position 0 of `rawQuery` can only come
 *    from a doubled `?` in the request line (a percent-escaped one arrives as `%3F`), so it is
 *    never part of a key; it is one more non-canonical spelling of the query that follows it, and
 *    rule 4 turns it into a redirect. The whole run goes, not one: `/watch???x=1` is the same
 *    typo twice and must land on the same canonical URL, or it is a redirect chain.
 * 1. No matching row: `clean`. An unmatched pathname defaults to doing NOTHING rather than
 *    stripping, so a route added to `config.matcher` without a row here loses this protection but
 *    never loses its query. The agreement test makes that unreachable.
 * 2. Split on `&`, then on the FIRST `=`, TEXTUALLY -- never `URLSearchParams`. Same reason
 *    `decode()` carries its own `splitPairs`: decoding before the structural delimiters have done
 *    their job corrupts a percent-encoded `,` or `&` inside a filter value, which is the bug
 *    `skipProxyUrlNormalize` and `proxy.ts` exist to prevent.
 * 3. A key in `keys` but not in `repeatable`, appearing twice: `reject`, immediately. Checked
 *    during the walk so it outranks stripping regardless of where in the query it sits -- a
 *    `strip` would silently resolve the duplicate by dropping one occurrence.
 * 4. Rejoin the surviving chunks with `&`, in their original order and original bytes. If the
 *    result differs from `rawQuery` -- the ORIGINAL, `?`s and all -- by a single byte: `strip`.
 *    **Byte-equality, not "were any unknown keys present"** -- `?&`, `?&&`, `?&&&...` carry no key
 *    to reject, yet each is a distinct CDN cache key on a cacheable path, and the same test
 *    catches a trailing `&` and rule 0's leading `?` for free.
 *
 * A `strip`'s `location` is itself `clean` by construction, and that is load-bearing rather than
 * incidental: the proxy 307s to it, so a location this function would strip again is a redirect
 * loop, not a cosmetic defect. Every chunk in `canonical` survived the walk, so re-walking it
 * keeps all of them; rule 0 already ran, so it carries no leading `?`; and no chunk is empty, so
 * the `&`-join reproduces itself. `canonicalQuery.test.ts` asserts it over every `strip` fixture
 * in the file rather than trusting that paragraph.
 *
 * Key ORDER survives: a reordered-but-valid permalink is `clean`. `encode()` emits exactly one
 * order, so every other one is chosen by whoever typed the URL, not emitted by this app -- the
 * justification this comment used to give ("a bounded family the app emits itself") was simply
 * false. It is accepted on a different ground: at most nine keys means at most 9! = 362,880
 * orderings, finite and bounded, where `?x=1..N` is not bounded at all. Reordering to a fixed
 * canonical order is possible and is not done, because the redirect would rewrite permalinks
 * users hold, and because the byte-for-byte rejoin above is what keeps a percent-encoded `,`
 * inside a filter value intact. */
export function queryVerdict(pathname: string, rawQuery: string): Canonical {
  const row = QUERY_ROWS.find((r) => r.matches(pathname));
  if (row === undefined) return { kind: "clean" };

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const chunk of rawQuery.replace(/^\?+/, "").split("&")) {
    if (chunk === "") continue;
    const i = chunk.indexOf("=");
    const key = i === -1 ? chunk : chunk.slice(0, i);
    if (!row.keys.has(key)) continue;
    if (seen.has(key) && !row.repeatable.has(key)) {
      return {
        kind: "reject",
        reason:
          `duplicate key '${key}' on ${pathname}: no canonical form exists, because choosing ` +
          "one occurrence would render a different query than the URL encodes",
      };
    }
    seen.add(key);
    kept.push(chunk);
  }

  const canonical = kept.join("&");
  if (canonical === rawQuery) return { kind: "clean" };
  return { kind: "strip", location: canonical === "" ? pathname : `${pathname}?${canonical}` };
}

/** `proxy.ts`'s view of `queryVerdict`: identical, except that an `exempt` row is always `clean`.
 *
 * `exempt` is about the ACTION, not the rules (see `QueryRow.exempt`). `/search` must never
 * redirect -- it is `no-store` unconditionally, so there is no cache entry for a canonical
 * spelling to protect -- and `/api/pivot` must answer its own 400 rather than 307 an XHR. Both
 * still have real `keys`, and `queryVerdict` still applies them; this wrapper is only the proxy
 * declining to act. */
export function canonicalize(pathname: string, rawQuery: string): Canonical {
  const row = QUERY_ROWS.find((r) => r.matches(pathname));
  if (row === undefined || row.exempt !== undefined) return { kind: "clean" };
  return queryVerdict(pathname, rawQuery);
}
