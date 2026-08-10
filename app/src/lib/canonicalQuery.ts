import { ALLOWED_KEYS } from "@/lib/pivot/urlstate";
import { routeSlugFromPath } from "@/lib/rawPath";
import { airportSlugFromPath } from "@/lib/airport";
import { carrierSlugFromPath } from "@/lib/carrier";
import { aircraftSlugFromPath } from "@/lib/aircraftSlug";
import { presetSlugFromPath } from "@/lib/watch";

/** One canonical spelling per cacheable URL.
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
 * guarded the family; it was in fact all ten cacheable paths.
 *
 * A table rather than a chain of `if`s, for the same reason `proxy.ts`'s `ENTITY_ROUTES` is one:
 * the failure being defended against is a future route whose author copies three lines out of
 * four. `QUERY_ROWS` is the THIRD list that must agree with `config.matcher` (canonicalQuery.test
 * .ts asserts it), alongside `ENTITY_ROUTES`.
 *
 * Pure: no database, no Next imports, no I/O. It cannot throw on any REQUEST -- `entitySlugFromPath`
 * already catches `decodeURIComponent`'s throw on a malformed escape (`%zz`) and falls back to
 * the raw text, so every `matches` predicate below is total, which matters because this runs on
 * the proxy path, where an uncaught throw is a 500 on a request that was only ever going to be a
 * redirect. The one throw `canonicalize` has is not request-shaped: a leading `?` on `rawQuery`
 * means a caller passed `new URL(...).search` UNSTRIPPED, rather than `proxy.ts:40`'s already-
 * stripped value (see that function's own doc comment) -- a wiring mistake, not something a real
 * request can trigger through correct wiring, so it exists purely to fail loudly at the first
 * request if a future call site gets that backwards. */
const NO_KEYS: ReadonlySet<string> = new Set();
const NONE_REPEATABLE: ReadonlySet<string> = new Set();
/** `encode()` emits one `f=` per filter (urlstate.ts:113-114) and `decode()` `continue`s past its
 * own duplicate check for `f`, so repeated `f` is a shape this app generates itself. Any
 * duplicate rule that does not exempt it breaks every multi-filter permalink. */
const EXPLORE_REPEATABLE: ReadonlySet<string> = new Set(["f"]);
/** `y` selects one calendar year's network map (app/airport/[code]/page.tsx, M7 Task 9). */
const AIRPORT_KEYS: ReadonlySet<string> = new Set(["y"]);

export type QueryRow = {
  /** The literal `proxy.ts` matcher entry this row answers for. The agreement test keys on it. */
  matcher: string;
  matches: (pathname: string) => boolean;
  /** Query keys this path legitimately reads. Everything else is stripped. */
  keys: ReadonlySet<string>;
  /** The subset of `keys` that may appear more than once. */
  repeatable: ReadonlySet<string>;
  /** Set instead of relying on `keys`/`repeatable` when the path owns its own answer. */
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
    matcher: "/api/pivot",
    matches: (p) => p === "/api/pivot",
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
    exempt:
      "the route handler owns its own Response: 400 + no-store on an unknown key, 500 + no-store " +
      "on anything else (app/api/pivot/route.ts). A 307 on a JSON endpoint would be a worse " +
      "answer than the 400 it already gives.",
  },
  {
    matcher: "/search",
    matches: (p) => p === "/search",
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
    exempt:
      "no-store unconditionally (proxy.ts's /search branch), so no shared-cache entry is " +
      "reachable to pollute. Its unbounded ORIGIN load is edge rate limiting's problem (#19), " +
      "not this gate's.",
  },
];

export type Canonical =
  | { kind: "clean" }
  | { kind: "reject"; reason: string }
  | { kind: "strip"; location: string };

/** Is `rawQuery` the canonical spelling of a query for `pathname`?
 *
 * `clean` -- yes, or this path is not ours to police. `reject` -- no, and there is no canonical
 * form to send the caller to. `strip` -- no, and `location` is where they should go instead.
 *
 * `rawQuery` excludes the leading `?`, exactly as `proxy.ts:40` produces it
 * (`new URL(request.url).search.replace(/^\?/, "")`) -- a caller that passes the `?`-prefixed
 * `.search` value directly gets a thrown `Error`, not a silently wrong answer: the first chunk's
 * key would parse as `"?y"` rather than `"y"`, which is absent from every row's `keys`, so a
 * legitimate key would be dropped and reported as `strip` instead of `clean` -- on `/explore`
 * that strips `v=1` off the front of every permalink and redirects to a query `decode()` then
 * rejects, silently.
 *
 * Rules, in order:
 *
 * 1. No matching row, or an `exempt` row: `clean`. An unmatched pathname defaults to doing
 *    NOTHING rather than stripping, so a route added to `config.matcher` without a row here
 *    loses this protection but never loses its query. The agreement test makes that unreachable.
 * 2. Split on `&`, then on the FIRST `=`, TEXTUALLY -- never `URLSearchParams`. Same reason
 *    `decode()` carries its own `splitPairs`: decoding before the structural delimiters have done
 *    their job corrupts a percent-encoded `,` or `&` inside a filter value, which is the bug
 *    `skipProxyUrlNormalize` and `proxy.ts` exist to prevent.
 * 3. A key in `keys` but not in `repeatable`, appearing twice: `reject`, immediately. Checked
 *    during the walk so it outranks stripping regardless of where in the query it sits -- a
 *    `strip` would silently resolve the duplicate by dropping one occurrence.
 * 4. Rejoin the surviving chunks with `&`, in their original order and original bytes. If the
 *    result differs from `rawQuery` by a single byte: `strip`. **Byte-equality, not "were any
 *    unknown keys present"** -- `?&`, `?&&`, `?&&&...` carry no key to reject, yet each is a
 *    distinct CDN cache key on a cacheable path, and the same test catches a trailing `&` for
 *    free. Key ORDER survives, so a reordered-but-valid permalink stays `clean`: that is a
 *    bounded family the app emits itself, not an attacker-chosen one. */
export function canonicalize(pathname: string, rawQuery: string): Canonical {
  if (rawQuery.startsWith("?")) {
    throw new Error(
      "canonicalize(): rawQuery must not include the leading '?' -- proxy.ts:40 already " +
        "strips it (`new URL(request.url).search.replace(/^\\?/, \"\")`) before calling this " +
        "function. A '?'-prefixed rawQuery is a wiring bug, not a request to handle: the first " +
        "chunk's key would parse as '?<key>', which is absent from every row's `keys`, so a " +
        "legitimate key would be silently dropped and reported as `strip` instead of `clean`.",
    );
  }
  const row = QUERY_ROWS.find((r) => r.matches(pathname));
  if (row === undefined || row.exempt !== undefined) return { kind: "clean" };

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const chunk of rawQuery.split("&")) {
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
