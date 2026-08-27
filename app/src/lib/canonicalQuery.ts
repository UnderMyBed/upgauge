import { ALLOWED_KEYS } from "@/lib/pivot/urlstate";
import { ogSlugFromPath } from "@/lib/entitySlug";
import { routeSlugFromPath, ROUTE_PREFIX } from "@/lib/rawPath";
import { airportSlugFromPath, AIRPORT_PREFIX } from "@/lib/airport";
import { carrierSlugFromPath, CARRIER_PREFIX } from "@/lib/carrier";
import { aircraftSlugFromPath, AIRCRAFT_PREFIX } from "@/lib/aircraftSlug";
import { presetSlugFromPath } from "@/lib/watch";

/** One canonical KEY SET per cacheable URL.
 *
 * Not "one canonical spelling", which is what this file and `docs/architecture/hosting.md` both
 * claimed first and is wider than anything here can deliver. What is decided below is byte-
 * equality over the KEYS a path reads: an unknown key, a keyless chunk, a trailing `&` and a
 * leading `?` are each non-canonical, but key ORDER survives (see rule 4), and VALUES are never
 * inspected here at all. A key table is the wrong shape for a value: whether `f=origin_state:XX`
 * names a real state is a property of the WAREHOUSE, not of the URL grammar, so answering it from
 * this module would mean a catalog read on the path that runs before every request.
 *
 * VALUES ARE BOUNDED, just not here (#52). `lib/pivot/bounds.ts` is the server's admission policy
 * -- `t` inside the dataset's own window with `from <= to`; `n` under a stated ceiling; every key
 * but `f` spelled ONE way, checked on the raw bytes before `pyUnquote` (`decode()` percent-decodes
 * at `urlstate.ts:179` and only checks the shape at `:214`, so without that rule each admissible
 * value keeps arbitrarily many encodings); and no repeated token in `d` or `m`. Applied by
 * `proxy.ts`, `/api/pivot` and `ExploreView` through `decodeRequest`, not by any rule below. Do
 * not read "VALUES are never inspected" as "values are unbounded"; it means this file does not do
 * it. What remains genuinely open is `f`, on both of its axes -- its value set is the warehouse's,
 * and percent-encoding is its own escape mechanism, so it is exempt from the spelling rule too:
 * `docs/architecture/hosting.md` § "What this does not close" has that residual and the
 * rate-limit thresholds it is left to -- which cover `/explore` as well as `/api/` only since
 * #83, and the three entity prefixes only since #113; before #83, this sentence deferred to an
 * edge rule that did not match this page.
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
 * `lib/entitySlug.ts` already catches `decodeURIComponent`'s throw on a malformed escape (`%zz`)
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
/** `type` filters `/carrier/:code`'s network map to ONE aircraft type, and `carrier` filters
 * `/aircraft/:name`'s to ONE carrier (#106). Neither is repeatable: two types is a different
 * map, not a spelling of one, so a duplicate has no canonical form -- rule 3 rejects it.
 *
 * These two are the first keys here whose VALUE cannot be admitted structurally: whether
 * `B737-8` names anything is a fact about the warehouse, which is exactly why this file does
 * not answer it (see this module's header). `lib/map/mapFilter.ts` owns the value rule --
 * a raw-byte spelling bound plus an actual entity resolution -- and `proxy.ts` reads its
 * verdict before committing to a `Cache-Control`, the same division `AIRPORT_KEYS` has with
 * `lib/year.ts` and `ALLOWED_KEYS` has with `lib/pivot/bounds.ts`. Declaring the key here and
 * bounding the value there is one mechanism; neither half is sufficient alone. */
const CARRIER_KEYS: ReadonlySet<string> = new Set(["type"]);
const AIRCRAFT_KEYS: ReadonlySet<string> = new Set(["carrier"]);
/** `/search`'s only key -- `app/search/page.tsx` reads `searchParams.q` and nothing else.
 * Declared truthfully even though nothing consumes this row's verdict today: `exempt` means "the
 * proxy does not redirect this path", never "the rules do not exist for it". */
const SEARCH_KEYS: ReadonlySet<string> = new Set(["q"]);

/** Next's own cache-buster on a file-convention OG image URL, admitted BY SHAPE.
 *
 * Measured on the served production build rather than assumed, because getting this wrong 307s
 * the site's own `og:image` on all four entity pages at once. Next emits
 *
 *     <meta property="og:image" content="http://.../route/JFK-LAX/opengraph-image?083d4242d9090de4"/>
 *
 * -- a query chunk with **no key and no `=`**, which is exactly the axis rule 4 exists to catch
 * (`splitPairs` skips an empty chunk; a keyless one has no key to look up). Sixteen lowercase hex
 * digits, one per `opengraph-image.tsx` FILE and not per slug: `/route/JFK-LAX`, `/route/ORD-LAX`
 * and `/route/HNL-ITO` all carried `083d4242d9090de4`, while `/airport`, `/carrier` and
 * `/aircraft` carried three other values. It is `[contenthash]` over the route file's compiled
 * content (`next/dist/build/webpack/loaders/next-metadata-image-loader.js:60,64` --
 * `interpolateName(this, "[contenthash]")`, whose loader-utils default digest is xxhash64 in
 * lowercase hex, 16 characters), so its VALUE changes on any edit to that file and cannot be
 * pinned as a literal here or in a test.
 *
 * Why admitted rather than stripped: this is a shape THIS APP EMITS, the same argument
 * `EXPLORE_REPEATABLE` makes for a repeated `f=`. A rule that does not admit it turns every
 * social-card fetch into a 307 to the bare URL -- uncached, since a `strip` is `no-store` -- so
 * every card costs two origin hits and depends on each crawler following redirects.
 *
 * What it does NOT close, stated rather than implied: 16^16 strings match this shape, and each
 * is a distinct CDN cache key on a cacheable path. That is the same residual class as `f`'s
 * value axis (see this file's header) and it is left to the same place -- the edge rate limit,
 * `docs/architecture/hosting.md` § "What this does not close", whose expression matches these
 * four paths by `ends_with(http.request.uri.path, "/opengraph-image")` since #83. Since #113
 * that clause is load-bearing for `/route/:pair/opengraph-image` alone -- the other three card
 * paths are also matched by their entity prefix -- so it is not redundant and deleting it
 * uncovers the route card. Cloudflare's
 * `uri.path` excludes the query string, so the 16-hex chunk this row admits does not affect the
 * match. It is still a strict NARROWING:
 * without a row at all every OG path admits every query key there is, and with `keys: NO_KEYS`
 * plus this shape a query is canonical only if it is empty or one 16-hex-digit chunk. `f`'s
 * exemption is the precedent for accepting a bounded-but-large residual on a shape the app
 * itself generates; it is not a licence to widen this pattern to a row whose value set the app
 * does not emit.
 *
 * Non-global regex, so `.test()` carries no `lastIndex` state between calls. */
const OG_CACHE_BUSTER = /^[0-9a-f]{16}$/;

export type QueryRow = {
  /** The literal `proxy.ts` matcher entry this row answers for. The agreement test keys on it. */
  matcher: string;
  matches: (pathname: string) => boolean;
  /** Query keys this path legitimately reads. Everything else is stripped. */
  keys: ReadonlySet<string>;
  /** The subset of `keys` that may appear more than once. */
  repeatable: ReadonlySet<string>;
  /** Set only where the FRAMEWORK appends a keyless chunk this app cannot suppress -- today the
   * four OG rows and nothing else (`OG_CACHE_BUSTER` above has the measurement and the residual
   * it leaves open). A keyless chunk matching this pattern is kept; at most ONE may appear, and
   * a second is `reject`ed rather than stripped, because two spellings of one slot have no
   * canonical form for the same reason a duplicated key does not. */
  cacheBuster?: RegExp;
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
  // THE FOUR OG ROWS SIT ABOVE THE FOUR ENTITY ROWS, AND THE ORDER IS LOAD-BEARING.
  // `canonicalize`/`queryVerdict` take the FIRST row whose predicate fires, and every entity
  // reader is a bare prefix test that does not stop at one segment: `routeSlugFromPath
  // ("/route/JFK-LAX/opengraph-image")` is `"JFK-LAX/opengraph-image"`, not null (lib/
  // entitySlug.ts's header states that non-opinion deliberately). So `/route/:pair` would claim
  // every route card, answer it with `keys: NO_KEYS`, and 307 the cache-buster off the URL this
  // site puts in its own `og:image` tag. The "row %s is the first to claim %s" case in
  // canonicalQuery.test.ts is what makes a reorder red instead of silent.
  //
  // An OG card takes no query of its own -- no `y` even on airport, which is why `/airport`'s
  // card can share this shape with the other three (see proxy.ts's OG branch) -- so `NO_KEYS`
  // plus the framework's own cache-buster is the whole key set.
  {
    matcher: "/route/:pair/opengraph-image",
    matches: (p) => ogSlugFromPath(p, ROUTE_PREFIX) !== null,
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
    cacheBuster: OG_CACHE_BUSTER,
  },
  {
    matcher: "/airport/:code/opengraph-image",
    matches: (p) => ogSlugFromPath(p, AIRPORT_PREFIX) !== null,
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
    cacheBuster: OG_CACHE_BUSTER,
  },
  {
    matcher: "/carrier/:code/opengraph-image",
    matches: (p) => ogSlugFromPath(p, CARRIER_PREFIX) !== null,
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
    cacheBuster: OG_CACHE_BUSTER,
  },
  {
    matcher: "/aircraft/:name/opengraph-image",
    matches: (p) => ogSlugFromPath(p, AIRCRAFT_PREFIX) !== null,
    keys: NO_KEYS,
    repeatable: NONE_REPEATABLE,
    cacheBuster: OG_CACHE_BUSTER,
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
    keys: CARRIER_KEYS,
    repeatable: NONE_REPEATABLE,
  },
  {
    matcher: "/aircraft/:name",
    matches: (p) => aircraftSlugFromPath(p) !== null,
    keys: AIRCRAFT_KEYS,
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
 * 2a. On a row carrying a `cacheBuster` (the four OG rows, and only those), a KEYLESS chunk
 *    matching that pattern is kept rather than looked up in `keys` -- Next appends one to every
 *    file-convention `og:image` URL and it has no key to declare. At most one; a second is
 *    `reject`, never `strip`, for rule 3's reason. See `OG_CACHE_BUSTER`.
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
 * inside a filter value intact.
 *
 * The walk itself lives in `applyRules` below, taking an already-resolved `row` rather than
 * re-finding it. `queryVerdict` and `canonicalize` each match `QUERY_ROWS` exactly once per call
 * -- sixteen `matches` predicates, nine of them `startsWith` + `decodeURIComponent`, are not free,
 * and this path is the one every gated request runs. Before this split, `canonicalize` found its
 * own row AND called `queryVerdict`, which found it again: two walks of `QUERY_ROWS` per gated
 * request for one answer. */
function applyRules(row: QueryRow | undefined, pathname: string, rawQuery: string): Canonical {
  if (row === undefined) return { kind: "clean" };

  const kept: string[] = [];
  const seen = new Set<string>();
  let sawCacheBuster = false;
  for (const chunk of rawQuery.replace(/^\?+/, "").split("&")) {
    if (chunk === "") continue;
    const i = chunk.indexOf("=");
    const key = i === -1 ? chunk : chunk.slice(0, i);
    // Rule 2a. Ahead of the `keys` lookup because a cache-buster HAS no key -- `key` here is the
    // whole chunk, and no row declares a hex digest as a key.
    if (i === -1 && row.cacheBuster !== undefined && row.cacheBuster.test(chunk)) {
      if (sawCacheBuster) {
        return {
          kind: "reject",
          reason:
            `two cache-busters on ${pathname}: they are two spellings of one slot, so ` +
            "keeping either one would answer for a URL the request did not ask for",
        };
      }
      sawCacheBuster = true;
      kept.push(chunk);
      continue;
    }
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

export function queryVerdict(pathname: string, rawQuery: string): Canonical {
  return applyRules(
    QUERY_ROWS.find((r) => r.matches(pathname)),
    pathname,
    rawQuery,
  );
}

/** `proxy.ts`'s view of the same rules: identical, except that an `exempt` row is always `clean`.
 *
 * `exempt` is about the ACTION, not the rules (see `QueryRow.exempt`). `/search` must never
 * redirect -- it is `no-store` unconditionally, so there is no cache entry for a canonical
 * spelling to protect -- and `/api/pivot` must answer its own 400 rather than 307 an XHR. Both
 * still have real `keys`, and `applyRules` still applies them; this function only declines to act
 * on an exempt row's verdict. It does NOT call `queryVerdict` -- that would re-find the row this
 * function already found. */
export function canonicalize(pathname: string, rawQuery: string): Canonical {
  const row = QUERY_ROWS.find((r) => r.matches(pathname));
  if (row === undefined || row.exempt !== undefined) return { kind: "clean" };
  return applyRules(row, pathname, rawQuery);
}
