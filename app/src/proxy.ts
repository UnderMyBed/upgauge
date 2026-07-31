import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { RAW_PATH_HEADER, routeSlugFromPath } from "@/lib/rawPath";
import { resolveRoutePair } from "@/lib/routePair";
import { airportSlugFromPath } from "@/lib/airport";
import { resolveAirportCode } from "@/app/airport/[code]/resolveAirport";
import { carrierSlugFromPath, resolveCarrier } from "@/lib/carrier";
import { aircraftSlugFromPath, resolveAircraftSlug } from "@/lib/aircraftSlug";
import { loadAllowlist } from "@/lib/db";

// `proxy`, not `middleware`: Next 16 deprecated and renamed the convention
// (node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md, "middleware to
// proxy"). This also settles CLAUDE.md's portability rule in our favour -- the docs are
// explicit that "the `edge` runtime is NOT supported in `proxy`. The `proxy` runtime is
// `nodejs`, and it cannot be configured", so this cannot drag in a provider-specific edge
// runtime, and the platform-support table lists a plain Node.js server as supported.
//
// Why this exists at all: `/explore` needs the RAW, still-encoded query string, and a page
// only ever receives `searchParams` already percent-decoded. See lib/rawQuery.ts for the
// full reasoning. `NextResponse.next({ request: { headers } })` is the documented way to
// make a header visible to the app upstream -- NOT `NextResponse.next({ headers })`, which
// would expose it to clients instead.
export async function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  // `new URL(request.url).search`, NOT `request.nextUrl.search`: nextUrl re-serializes its
  // searchParams, which form-encodes the query and destroys the escapes this header exists to
  // preserve. Verified against a running production server at each step.
  //
  // `request.url` is only raw here because next.config.ts sets `skipProxyUrlNormalize`.
  // WITHOUT that flag Next normalizes the query the same way -- `k:a%2Cb,c` becomes
  // `k%3Aa%2Cb%2Cc`, collapsing a data comma into a separator -- and every filtered query on
  // BOTH entry points failed with `malformed filter 'origin_state%3AOR'`, reserved characters
  // or not. The flag and this file are one mechanism; neither works alone.
  //
  // No unit test can catch a regression here: these tests never construct a NextRequest and
  // never cross Next's URL normalization. Only a built-and-served smoke check can.
  headers.set(RAW_QUERY_HEADER, new URL(request.url).search.replace(/^\?/, ""));
  const pathname = new URL(request.url).pathname;
  // Second header, same mechanism, different reason -- see lib/rawPath.ts. `not-found.js`
  // accepts no props and gets no route params, so this is the only way a segment-level 404
  // can stay a Server Component and still name the slug that was requested.
  headers.set(RAW_PATH_HEADER, pathname);
  const response = NextResponse.next({ request: { headers } });

  // CLAUDE.md's caching IS the cost control, not the hosting tier (docs/architecture/
  // hosting.md). /api/pivot sets its own on the JSON response, including `no-store` on
  // errors, so it must not be overridden here -- and it stays at the project's full
  // `s-maxage=2592000` (see route.ts), untouched by the fallback below. /explore and
  // /route/<pair> both export `dynamic = "force-dynamic"` (each page's own header comment
  // explains why: their content depends on live warehouse state), so Next emits its own
  // no-store for the HTML and every shared permalink -- the growth mechanic, and the
  // cold-start path the always-on box is sized around -- hit DuckDB with the CDN doing
  // nothing. Setting it on the proxy response is what makes it stick regardless of the route
  // segment config.
  //
  // M5 Task 7, Part B: this HTML branch's header is `HTML_CACHE` (defined below), NOT
  // CLAUDE.md's `s-maxage=2592000` -- see that constant's own doc comment and
  // docs/architecture/hosting.md § "The gap" for the measured reason (a 500 from a page, which
  // a proxy-side probe can never fully rule out, was publicly cacheable for a month; a route
  // handler that could catch its own page's throw and own its own Response turned out to
  // require giving up Next's page-rendering pipeline entirely -- not this file's decision to
  // make alone, so the accepted fallback is a shorter `s-maxage` on HTML instead).
  //
  // CRITICAL fix (final whole-branch review): the matcher below used to list only "/explore"
  // and "/api/pivot", so `/route/<pair>` -- M4b's headline SEO-canonical permalink page --
  // shipped `private, no-cache, no-store, max-age=0, must-revalidate`, reproducing the exact
  // bug this file exists to fix. A prefix test (`routeSlugFromPath`), not an exact match: the
  // matcher below only forwards the literal `/route/:pair` shape (one dynamic segment), so
  // this can't accidentally net `/api/pivot` or some future unrelated top-level route.
  //
  // Fix wave 2, NEW-1: the CRITICAL fix above set the long cache on EVERY `/route/` response,
  // with no status discrimination, so a 404 was pinned in a shared CDN cache for what was then
  // 30 days (M5 Task 7, Part B shortened HTML_CACHE's own `s-maxage` to one hour -- see that
  // constant's doc comment -- but the argument here is about MAGNITUDE, not existence: any
  // fixed `s-maxage` on a 404 outlives the condition that caused it, only by a smaller margin
  // now). The dataset refreshes monthly, so `/route/XYZ-JFK` 404ing today because XYZ has no
  // `fct_segment_month` rows yet would keep 404ing for up to another cache period after the
  // ingest that makes it real -- `stale-while-revalidate` only applies AFTER `s-maxage`
  // expires, so the page cannot self-correct inside that window. The project already holds
  // this principle: /api/pivot sets `no-store` on its own error responses.
  //
  // A Next proxy CANNOT read the downstream response status -- `NextResponse.next()` is a
  // passthrough sentinel created before the page runs -- so "exempt 404s" has no direct
  // implementation, and a Server Component page cannot set response headers either. The
  // reframing that DOES have one: cache-worthiness here is not "did it return 200", it is
  // "is this a well-formed, known pair", and that IS knowable before the page runs. A
  // well-formed known pair returns 200 (including the empty-state 200) or a 308 -- both
  // stable, both worth caching. A malformed slug, an unknown code, a self-route or a
  // recognized-but-non-domestic code returns 404 and is not.
  //
  // M4d generalized that from one route to four: see ENTITY_ROUTES below.
  //
  // M5 Task 7, Part A: `/explore` has no slug to resolve, so unlike every ENTITY_ROUTES row it
  // ran NO database query at all -- this branch used to set the long cache unconditionally.
  // That is the exact gap docs/architecture/hosting.md § "The gap" measured: a served build
  // pointed at a database missing a catalog view 500s on /explore, and the response still
  // carried the project's then-30-day header because nothing on this path had asked the
  // database anything before committing to it. isDataLayerHealthy() is /explore's equivalent
  // of an entity row's resolve() -- the proxy's own probe, run and caught BEFORE the header is
  // chosen, never after.
  if (pathname === "/explore") {
    response.headers.set("Cache-Control", (await isDataLayerHealthy()) ? HTML_CACHE : NO_STORE);
    return response;
  }
  for (const entity of ENTITY_ROUTES) {
    const slug = entity.slugFromPath(pathname);
    if (slug === null) continue;
    response.headers.set("Cache-Control", (await isCacheable(entity, slug)) ? HTML_CACHE : NO_STORE);
    break;
  }
  return response;
}

/** `/explore`'s fail-safe probe (M5 Task 7, Part A). Reuses `loadAllowlist()` rather than
 * inventing a cheaper standalone query, for two reasons: (1) it is exactly what `ExploreView`
 * (`app/src/app/explore/page.tsx`) calls FIRST, before its own try/catch -- which wraps only
 * `decode()` and `runPivot()` -- so a broken `meta_pivot_dimensions` / `meta_pivot_measures`
 * catalog view throws there today, unguarded, precisely the scenario this closes; and (2) the
 * ENTITY_ROUTES precedent already accepts paying for a second, proxy-side copy of a query the
 * page will also run (see isCacheable's own doc comment: "This is a SECOND resolution for the
 * request").
 *
 * What this does NOT cover, and cannot from here: a throw AFTER this probe succeeds -- e.g.
 * `dataAsOf()` failing when `loadAllowlist()` didn't, or `runPivot()` failing on a query this
 * exact allowlist read could not have anticipated (a template bug, a value that passes
 * `decode()`'s structural check but not the executable SQL, an OOM). Those are page-specific
 * throws whose proxy resolution succeeded, and closing them is Part B's job, not this
 * function's -- see docs/architecture/hosting.md § "The gap" for which exit Part B took.
 *
 * Errors are swallowed to `false`, matching `isCacheable`'s own reasoning below: a transient
 * failure here would 500 a request the page might well still serve, and declining the cache is
 * the conservative outcome regardless of cause. */
async function isDataLayerHealthy(): Promise<boolean> {
  try {
    await loadAllowlist();
    return true;
  } catch {
    return false;
  }
}

/** One row per entity page: how to find its slug in the pathname, and how to resolve it.
 *
 * M4d added three pages to a mechanism that had shipped broken once already by being invisible
 * to whoever added a route -- M4b's `/route/<pair>` served
 * `private, no-cache, no-store, max-age=0, must-revalidate` for a whole branch because the
 * matcher listed only `/explore` and `/api/pivot`. Since then the omission costs more than a
 * mis-cache: all four `not-found.tsx` files read RAW_PATH_HEADER and throw
 * `MissingRawPathError` without it, so **a page missing from the matcher turns every 404 on it
 * into a 500.**
 *
 * A table rather than four `else if` branches, because the failure mode being defended against
 * is a fifth page whose author reads this file and copies three lines out of four. Adding an
 * entity is one row here plus one `matcher` entry, and both are in view at once.
 *
 * The `slugFromPath` readers used to be four independent copies of the same decode guard, one
 * per entity module (`lib/rawPath.ts`, `app/airport/[code]/resolveAirport.ts`, `lib/carrier.ts`,
 * `lib/aircraftSlug.ts`) -- deliberately, at the time: the three M4d pages were built
 * concurrently, and one shared file is three agents editing one file. M5 Task 6 is the collapse
 * this comment used to point at: all four now delegate to `lib/entitySlug.ts`'s
 * `entitySlugFromPath(pathname, prefix)`, and each module still exports its own one-line
 * wrapper under its original name, so this table -- true to what this comment predicted -- is
 * the only call site that changed (the airport import moved from the route directory to
 * `lib/airport.ts`, alongside `AIRPORT_PREFIX`; see that file and `lib/entityLink.ts`). */
const ENTITY_ROUTES: ReadonlyArray<{
  slugFromPath: (pathname: string) => string | null;
  resolve: (slug: string) => Promise<{ kind: string }>;
}> = [
  { slugFromPath: routeSlugFromPath, resolve: resolveRoutePair },
  { slugFromPath: airportSlugFromPath, resolve: resolveAirportCode },
  { slugFromPath: carrierSlugFromPath, resolve: resolveCarrier },
  { slugFromPath: aircraftSlugFromPath, resolve: resolveAircraftSlug },
];

/** The cacheable outcomes, stated as an ALLOW-list of kinds rather than as `!== "notFound"`.
 *
 * That is not a stylistic preference. `resolveAircraftSlug` has **four** outcomes, not three:
 * `/aircraft/CE-180` resolves to `ambiguous` (BTS codes 030 CESSNA 180 and 031 CESSNA 180A/B
 * share one short name), which the page renders as a 404. A `!== "notFound"` test -- the shape
 * `/route` used, and the obvious thing to copy -- would have pinned that 404 in a shared CDN
 * cache for as long as `HTML_CACHE`'s `s-maxage` runs (30 days when this comment was written;
 * M5 Task 7 Part B shortened it to one hour, see that constant). An allow-list gets a new
 * outcome wrong in the safe direction regardless of the exact number: an unrecognized kind
 * declines the cache, which costs a cache miss instead of a period of a wrong answer.
 *
 * `redirect` IS cacheable, for all four. A 308 target is derived from the slug alone -- an
 * uppercasing, a re-ordering of two airport codes, `dim_carrier`'s own spelling of the code --
 * so it is exactly as stable as the 200 it points at and cannot be invalidated by an ingest.
 * Note `/airport/zzzz` therefore gets a long-cached 308 to `/airport/ZZZZ`, which then 404s
 * `no-store`: `resolveAirportCode` redirects on case before it looks anything up. That is
 * correct rather than merely tolerable -- `toUpperCase()` does not consult the dataset, so the
 * redirect can never become the wrong answer, and the 404 that follows is the one that has to
 * stay uncached.
 *
 * Errors are swallowed to `false`, deliberately: a transient DuckDB failure inside a PROXY
 * would 500 a request that the page itself might well have served, and `false` is the
 * conservative outcome anyway (decline to cache something we could not vouch for). Nothing is
 * hidden by this -- `page.tsx` immediately runs the same resolution unguarded, so a real
 * database failure still surfaces as a loud error from the page.
 *
 * The proxy runs on the Node.js runtime -- Next 16's docs are explicit that "Proxy defaults
 * to using the Node.js runtime" and that the `runtime` config option is not available here
 * (.../03-file-conventions/proxy.md:221-223) -- so `lib/db.ts`'s in-process DuckDB is
 * reachable from this file. That was NOT assumed: it was established by building and serving
 * (`make app-smoke`), because this branch has five bugs whose shape was "green tests, broken
 * production" and every one of them was found only by curling a real server.
 *
 * This is a SECOND resolution for the request -- each `page.tsx` runs its own, because the
 * proxy has no channel to hand a resolved object to a Server Component. The alternative
 * (serialising the resolution into a header) would make the page's correctness depend on the
 * proxy having agreed with it, which is a worse trade than one small query.
 *
 * WHAT IT COSTS, measured, because the first version of this comment guessed and guessed
 * WRONG in the expensive direction -- it called this "one extra read of dimension-sized
 * tables ... on a request that is about to run a much larger pivot", and M4d was told to copy
 * this pattern for /airport, /carrier and /aircraft. It is not a dimension read:
 * `lookup_airport_by_code.sql` filters `dim_airport` by presence in `fct_segment_month`
 * (3.36 M rows), and at 6a6b11c that filter was a correlated EXISTS with an OR across two
 * columns -- 43-51 ms, roughly 6x the ~7 ms pivot it precedes, twice per 200 and three times
 * per 404. Fix wave 3 rewrote it as a hash semi-join: 8 ms at the server's default thread
 * count (17 ms capped to two threads), same rows (proven exhaustively
 * against the real database, not sampled -- pipeline's
 * test_reverse_lookup_selects_exactly_the_fact_present_current_airports). Still the largest
 * single query on the route path; deliberately kept, because the cheap alternatives are all
 * wrong (see docs/architecture/hosting.md).
 *
 * WHAT FOUR ENTITIES COST TOGETHER: nothing extra, because at most ONE runs. Every
 * `slugFromPath` is a prefix test and the loop above breaks on the first match, so a request
 * pays exactly one resolution -- the same one `/route` has always paid. M4d's two new lookups
 * are cheaper than the airport one (3.6 ms carrier, 4.6 ms aircraft: both probe a single fact
 * column rather than a union of two), and `/airport`'s page then runs SIX pivots at 54.2 ms,
 * so the proxy's share of that page is smaller than its share of `/route`, not larger.
 *
 * NOTE the memo `lib/db.ts` uses is on `globalThis`, not a module-level `let`, and this file is
 * why: Turbopack emits `lib/db.ts` into a separate chunk per entry graph, so the proxy's copy of
 * that module is NOT the page's copy. With a module-level memo the process held three
 * DuckDBInstances (measured), and the proxy's could hold a different snapshot of the
 * database file than the page's -- which is a route straight back to the bug this branch
 * fixed, since the proxy's answer would then be about a file the page is no longer reading. */
async function isCacheable(
  entity: { resolve: (slug: string) => Promise<{ kind: string }> },
  slug: string,
): Promise<boolean> {
  try {
    const { kind } = await entity.resolve(slug);
    return kind === "ok" || kind === "redirect";
  } catch {
    return false;
  }
}

/** The HTML page routes' Cache-Control -- `/explore` and every `ENTITY_ROUTES` page -- and
 * ONLY those. Do not reuse this for `/api/pivot` (it already sets its own, and stays at the
 * project's full `s-maxage=2592000`, see route.ts) or for a future `/sitemap.xml`/`robots.txt`
 * matcher entry (CLAUDE.md's fallback is explicit: "leaving `/api/pivot`, the sitemap and
 * `robots.txt` at the 30-day value" -- neither reads live warehouse state per request the way
 * an entity page's pivot does, so neither carries the risk this shortened value exists to
 * bound).
 *
 * M5 Task 7, Part B. This is the fallback, not the fix Part B set out to spike: a route handler
 * that owns its own `Response` can catch a page-specific throw AFTER the proxy's resolution (or
 * probe) already succeeded and set its own `Cache-Control` per outcome, closing the gap
 * completely. That is unreachable here for a structural reason, not a difficulty one --
 * measured directly rather than assumed: `next build` on this exact page (a temporary
 * `route.ts` added alongside the untouched `page.tsx`, then reverted) fails outright --
 * `Conflicting route and page at /route/[pair]: route at /route/[pair]/route and page at
 * /route/[pair]/page` -- because Next 16 does not allow a `route.js` and a `page.js` at the
 * same segment (node_modules/next/dist/docs/.../15-route-handlers.md: "there **cannot** be a
 * `route.js` file at the same route segment level as `page.js`"). The only alternative --
 * delete `page.tsx` and hand-render its tree from `route.ts` -- gives up exactly what the task
 * brief ruled out up front: Route Handlers sit entirely outside Next's page-rendering
 * pipeline, so they have no access to layouts, `next/navigation`'s `notFound()`/
 * `permanentRedirect()`, streaming, or the RSC flight payload M4c's chart depends on
 * (`docs/architecture/hosting.md` § "The SVG is emitted twice per response"). Full account,
 * including why the fallback's shorter `s-maxage` still closes most of the exposure (a bad
 * response self-corrects in an hour instead of a month) without pretending the gap is gone:
 * `docs/architecture/hosting.md` § "The gap". */
const HTML_CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";
/** Matches what `/api/pivot`'s route handler already sets on its own error responses. A 404
 * here is a statement about the current dataset, and the dataset changes monthly. */
const NO_STORE = "no-store";

// Without a matcher, proxy runs on every request including _next/static and public assets.
// Every entry point needs the header (or, for /api/pivot, the raw-query passthrough only
// -- see above): /api/pivot's own `new URL(request.url).search` is normalized too -- measured,
// every filtered API query returned `malformed filter 'origin_state%3AOR'` before this. They
// now read the identical raw string from one source.
//
// Each `/<entity>/:slug` entry covers every `/<entity>/<anything>` request with exactly ONE
// dynamic segment, matching the segment its `app/<entity>/[x]/page.tsx` owns -- a prefix test in
// spirit, but narrow enough that it cannot accidentally net `/api/pivot` or a future unrelated
// top-level route.
//
// THIS LIST AND `ENTITY_ROUTES` MUST AGREE. A row here without a row there ships an entity page
// that is long-cached on its 404s; a row there without a row here ships a page with no
// Cache-Control at all AND turns each of its 404s into a 500 (`not-found.tsx` throws
// `MissingRawPathError` when the pathname header is absent). Neither asymmetry is visible in a
// build, a unit test, or a rendered page -- only `app/smoke.sh` sees them, which is why every
// row here has a served-build header assertion and a served-build `no-store` assertion there.
export const config = {
  matcher: [
    "/explore",
    "/api/pivot",
    "/route/:pair",
    "/airport/:code",
    "/carrier/:code",
    "/aircraft/:name",
  ],
};
