import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { canonicalize } from "@/lib/canonicalQuery";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { RAW_PATH_HEADER, routeSlugFromPath } from "@/lib/rawPath";
import { resolveRoutePair } from "@/lib/routePair";
import { airportSlugFromPath } from "@/lib/airport";
import { resolveAirportCode } from "@/app/airport/[code]/resolveAirport";
import { carrierSlugFromPath, resolveCarrier } from "@/lib/carrier";
import { aircraftSlugFromPath, resolveAircraftSlug } from "@/lib/aircraftSlug";
import { presetSlugFromPath, presetBySlug } from "@/lib/watch";
import { parseYear } from "@/lib/year";
import { decode } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist } from "@/lib/db";

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
  const rawQuery = new URL(request.url).search.replace(/^\?/, "");
  headers.set(RAW_QUERY_HEADER, rawQuery);
  const pathname = new URL(request.url).pathname;
  // Second header, same mechanism, different reason -- see lib/rawPath.ts. `not-found.js`
  // accepts no props and gets no route params, so this is the only way a segment-level 404
  // can stay a Server Component and still name the slug that was requested.
  headers.set(RAW_PATH_HEADER, pathname);
  const response = NextResponse.next({ request: { headers } });

  // CRITICAL FIX (whole-branch review round 2, Finding 1 -- this is the milestone controller's
  // ruling, not a design choice made here). An RSC request must never be redirected by ANYTHING
  // in this file, and must never be cached. Next's own client appends a `_rsc=<hash>`
  // cache-busting query param to every RSC fetch (`set-cache-busting-search-param.js`) and sets
  // the `RSC: 1` request header (`fetch-server-response.js`); `skipProxyUrlNormalize` (above)
  // is what lets that raw query reach `canonicalize()` unstripped, and `_rsc` is not in ANY
  // row's `keys` -- so the gate below used to 307 it away. Next's OWN server then sees an RSC
  // request whose `_rsc` is missing or wrong (`experimental.validateRSCRequestHeaders`, default
  // `true`, `base-server.js`) and 307s BACK to the same URL WITH the correct hash. The two
  // redirects alternate forever -- Next's own source names this exact hazard ("It only affects
  // redirects that occur in a middleware or a third-party proxy",
  // `fetch-server-response.js`). Measured on a served build: `/`, `/explore`,
  // `/route/JFK-LAX`, `/carrier/DL`, `/airport/ORD`, `/watch`, `/watch/gauge`,
  // `/aircraft/737-800` all hit the redirect cap and never settle. This is reachable from a real
  // browser, not only curl: the client bundle ships the cache-buster on every RSC fetch, and
  // `TopBar.tsx` puts a dozen `next/link`s on every page with prefetch on by default in
  // production, so every prefetch and every client-side navigation hits this.
  //
  // Fix: an RSC request never reaches `canonicalize()` at all -- it is answered `no-store`,
  // unconditionally, before any branch (including the gate below) runs. That closes the loop
  // (this file never redirects an RSC request, so there is nothing left to alternate with
  // Next's own redirect) without reopening the hole the obvious fix would: adding `_rsc` to
  // every row's `keys` would make a PLAIN `GET /watch?_rsc=1..N` -- no `RSC` header, so Next's
  // own hash check never runs at all -- clean and long-cached, the exact unbounded-cache-key
  // family this gate exists to close, reopened by an attacker who simply never sends the
  // header. Gating on the HEADER rather than the query key closes both variants: a genuine RSC
  // request never redirects and is never cached, and a request that merely SETS `RSC` to probe
  // for a bypass gets `no-store` regardless of what `_rsc` says, so there is no cache entry for
  // either shape to fill. It also closes a hazard that predates this branch: a shared CDN that
  // ignores `Vary` (Cloudflare ignores everything but `Accept-Encoding` by default) could
  // otherwise serve a stored RSC payload to a plain document request.
  //
  // The cost, accepted deliberately: client-side navigations and prefetches are never served
  // from a CDN and always reach the origin -- an uncached hit is a 40-100 ms DuckDB query on an
  // always-on box, and correctness ahead of a CDN is this milestone's entire purpose.
  if (request.headers.get("RSC") !== null) {
    response.headers.set("Cache-Control", NO_STORE);
    return response;
  }

  // M8 Task 3 (epic #3). The canonical-query gate, ahead of every branch below because its
  // answer depends on none of them, and because a `strip` must not pay for a database probe it
  // is about to redirect away from. `lib/canonicalQuery.ts` carries the measurements and the
  // per-path key table; what belongs here is the response shape.
  //
  // `new NextResponse`, NOT `NextResponse.redirect()`: the latter parses its argument into a URL,
  // which is exactly the re-serialisation this file exists to route around (see `rawQuery`
  // above -- `nextUrl` re-encodes, and that broke every filtered query on both entry points).
  //
  // The `Location` VALUE below is built ABSOLUTE (`request.nextUrl.origin` + the canonical path),
  // not the bare relative string `canonical.location` the first version of this gate returned --
  // measured against a served build, a bare relative Location 500s every single redirect here,
  // unconditionally: `next/dist/server/web/adapter.js` (the code that runs AFTER this function
  // returns, on every request, not just middleware-authored redirects) reads `Location` off
  // WHATEVER response comes back and does `new NextURL(redirect, { forceLocale: false, ... })`
  // with NO base argument -- and `NextURL`'s constructor resolves that to `new URL(redirect,
  // undefined)`, which throws `TypeError [ERR_INVALID_URL]` for any relative string. This is not
  // a `NextResponse.redirect()`-specific behavior (that factory forces an absolute URL itself,
  // via `validateURL()`) -- it is what the ADAPTER does to every response with a Location header,
  // built by any means. The comment above (this file exists to route around `NextResponse.redirect
  // ()`'s re-serialisation) is still the reason a raw `new NextResponse` is used instead of that
  // factory; it does not mean the Location value itself can stay relative.
  //
  // The CDN-facing property survives anyway, but NOT via that same `adapter.js` code -- whole-
  // branch review round 2 (Finding 3) found that half of the citation wrong. The
  // `redirectURL.host === requestURL.host` / `getRelativeURL` branch quoted above is itself
  // gated on `!process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE`, and `skipProxyUrlNormalize`
  // (next.config.ts) sets that env var TRUE -- so that whole branch is dead-code eliminated
  // from THIS build: confirmed absent from `app/.next/server/chunks/`, and `getRelativeURL`
  // appears nowhere under `.next/server/`. Only the CONSTRUCTOR call two paragraphs up (the one
  // that throws) survives elimination; the relativization above never runs in this file's
  // compiled output at all.
  //
  // What actually relativizes it: `next/dist/server/lib/router-utils/resolve-routes.js` --
  // Next's own router/server process, which calls the compiled proxy bundle above rather than
  // being part of it -- reads the raw `location` header this function returns and, for any
  // allowed redirect status (307 included), calls `getRelativeURL(value, initUrl)`
  // UNCONDITIONALLY (~line 492 there; no env-var gate on this call site). `initUrl` (~lines
  // 117-118 of the same file) is built from THIS SERVER'S OWN `opts.hostname`/`opts.port` bind
  // config, or the bare already-relative `req.url` -- it only reads the incoming request's
  // `Host` header at all when `experimental.trustHostHeader` is set, which this repo's
  // `next.config.ts` does not set. `request.nextUrl.origin`, which this function uses to build
  // `Location` above, is resolved from that SAME request Next's server already parsed -- so the
  // two origins `getRelativeURL` compares cannot disagree, and the relativization always fires
  // regardless of what a CLIENT claims its `Host` is. Measured directly, not merely inferred:
  // spoofing the incoming request's `Host` header, and separately its `X-Forwarded-Host`, to a
  // domain this server was never configured with still produced a bare relative
  // `location: /watch` -- never absolute, never the spoofed host (this task's fix report has
  // the exact curl output). `proxy.test.ts` cannot see any of this -- it calls `proxy()`
  // directly and never crosses `resolve-routes.js` -- so its `Location` assertions necessarily
  // pin the pre-relativization (absolute) value; only `app/smoke.sh`'s canonical-query section,
  // against a served build, asserts the actual wire bytes.
  //
  // 307, never 308: CLAUDE.md's rule for `/search` generalises to every redirect this project
  // mints. A 308 is cached by the requesting browser permanently, so if this gate's key table
  // ever gains a key, every browser that saw the old 308 keeps stripping it forever.
  //
  // `no-store` on the redirect itself, so the junk URL fills no cache entry either -- the whole
  // point is that an unbounded family of spellings cannot become an unbounded family of CDN
  // entries. The canonical URL it points at is cached normally by the branches below.
  //
  // MUTANT 15 (M8 Task 3, run and reverted): moved this block below the `ENTITY_ROUTES` loop and
  // measured against a served build. `/route/JFK-LAX?cachebust=99` and `/carrier/DL?utm_source=x`
  // -- the two paths this plan named -- kept passing: the `strip` branch always builds a fresh
  // `NextResponse`, never reuses `response`, so no branch's header can land on it regardless of
  // position, and ENTITY_ROUTES has no early return of its own for the gate to fall behind. What
  // actually went red: every path with its OWN early `return response` ABOVE the new position
  // (`/`, `/watch`, `/sitemap.xml`, `/robots.txt`) never reached the moved gate at all, so
  // `/watch?x=1` served its ordinary 200 under its ordinary HTML_CACHE, unredirected -- the same
  // property this comment exists to protect, by a different mechanism. Full detail in this
  // task's report.
  const canonical = canonicalize(pathname, rawQuery);
  if (canonical.kind === "strip") {
    return new NextResponse(null, {
      status: 307,
      headers: {
        Location: new URL(canonical.location, request.nextUrl.origin).toString(),
        "Cache-Control": NO_STORE,
      },
    });
  }
  if (canonical.kind === "reject") {
    response.headers.set("Cache-Control", NO_STORE);
    return response;
  }

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
  // M8 Task 1 (#13). `/` was the one page route absent from the matcher below, so it served
  // Next's own force-dynamic fallback -- measured on a served build at 4aa8087:
  // `private, no-cache, no-store, max-age=0, must-revalidate`, which forbids caching everywhere
  // including the CDN, on the front door, which queries DuckDB to render DATA AS OF. CLAUDE.md
  // already stated the rule this violated: a new page route must be added to this matcher or it
  // ships uncached and without the raw-query and pathname headers.
  if (pathname === "/") {
    response.headers.set("Cache-Control", (await isFreshnessReadable()) ? HTML_CACHE : NO_STORE);
    return response;
  }
  // M5 Task 7, Part A: `/explore` has no slug to resolve, so unlike every ENTITY_ROUTES row it
  // ran NO database query at all -- this branch used to set the long cache unconditionally.
  // That is the exact gap docs/architecture/hosting.md § "The gap" measured: a served build
  // pointed at a database missing a catalog view 500s on /explore, and the response still
  // carried the project's then-30-day header because nothing on this path had asked the
  // database anything before committing to it. isExploreCacheable() (below) is /explore's
  // equivalent of an entity row's resolve() -- the proxy's own probe, run and caught BEFORE the
  // header is chosen, never after. M8 Task 4 widened that probe from a bare data-layer health
  // check to include the permalink's own validity; see that function's own doc comment.
  if (pathname === "/explore") {
    response.headers.set(
      "Cache-Control",
      (await isExploreCacheable(rawQuery)) ? HTML_CACHE : NO_STORE,
    );
    return response;
  }
  // M5 Task 8. `/search` runs no proxy-side resolution at all -- unlike every branch above and
  // below, cacheability here is not a question this file answers by asking the database
  // anything, because there is nothing to ask that would make the answer safe to cache. `q` is
  // an unbounded, attacker-chosen string: caching a well-formed-vs-not distinction the way
  // ENTITY_ROUTES does would still leave every distinct `q` a shared-cache entry, so a crawler
  // (or an attacker) walking the query space mints an unbounded family of 30-day CDN entries on
  // a box whose entire cost model is that caching bounds origin load. `no-store`, unconditionally,
  // is the only value that closes that off. It still needs the matcher entry below -- absent
  // one, this request gets neither the raw-query header `search.ts` doesn't need nor the
  // pathname header its (nonexistent) not-found path would need, but MORE importantly it also
  // gets NO Cache-Control at all, which for this route happens to be harmless (Next's own
  // `no-store` for `dynamic = "force-dynamic"` would apply) but is the same invisible-omission
  // shape every other row in this file warns about, so the entry is not optional on principle.
  if (pathname === "/search") {
    response.headers.set("Cache-Control", NO_STORE);
    return response;
  }
  // The sitemap and robots.txt carry none of the entity pages' per-request resolution risk --
  // both are built from the same catalog queries regardless of who's asking, so CLAUDE.md's
  // project-wide 30-day value applies when the data layer is healthy, the same as /api/pivot's
  // own success responses. Neither app/sitemap.ts nor app/robots.ts sets its own Cache-Control
  // (unlike /api/pivot's route.ts), so this file has to, or they'd ship with none at all --
  // Next does not infer a shared-cache header for a MetadataRoute export.
  //
  // Final whole-branch review, F4: this branch used to set PROJECT_CACHE unconditionally, with
  // no isDataLayerHealthy() probe -- unlike the /explore branch directly above, which the same
  // review's earlier pass (M5 Task 7 Part A) already gated. The justification in the comment
  // above ("both are built from the same catalog queries regardless of who's asking") is a
  // statement about request-invariance, not about failure: app/sitemap.ts runs four DuckDB
  // queries via lib/sitemap.ts, and both parseLastmod and dedupeAircraftBySlug throw by design.
  // None of that was wrapped, so a broken data layer 500s /sitemap.xml -- the one URL the
  // entire crawl graph is submitted through -- under a 30-day shared-cache header, a WORSE
  // exposure than /explore's now-one-hour HTML_CACHE window. Same probe, same reasoning:
  // isDataLayerHealthy() is cheap (loadAllowlist() is memoized on globalThis, lib/db.ts), and
  // "declines to cache" costs a cache miss, not a wrong answer pinned for a month.
  if (pathname === "/sitemap.xml" || pathname === "/robots.txt") {
    response.headers.set(
      "Cache-Control",
      (await isDataLayerHealthy()) ? PROJECT_CACHE : NO_STORE,
    );
    return response;
  }
  // M6 Task 7. `/watch`'s presets are a STATIC, closed set (`PRESETS` in lib/watch.ts, four
  // entries, never grows from a request) -- unlike an ENTITY_ROUTES row there is no id to
  // resolve against the warehouse, so the allow-list alone can answer "is this a well-formed,
  // known page" with no database read at all. That is necessary but NOT SUFFICIENT: every
  // preset page runs a mart_route_health query (WatchPresetView's runPreset()), and this file
  // still commits to a Cache-Control header BEFORE the page runs. A slug allow-list with no
  // probe would happily stamp HTML_CACHE on a page about to 500 -- this is the exact bug M5's
  // final whole-branch review found on /sitemap.xml (F4, above): that branch set PROJECT_CACHE
  // unconditionally, justified by "it takes no user input", even though app/sitemap.ts runs
  // four DuckDB queries that throw by design. Same reasoning here, same fix: gate on
  // isDataLayerHealthy() regardless of how closed the slug set is. Declining to cache costs a
  // cache miss; skipping the probe costs a 500 pinned in a shared CDN cache for up to an hour.
  //
  // Unknown preset -> NO_STORE unconditionally, same as every ENTITY_ROUTES 404: the dataset
  // is rebuilt monthly, so a 404 pinned in a shared cache outlives the condition that caused
  // it. `/watch` itself (the index, no slug) is always "known" -- there is no id to fail to
  // resolve for the bare path -- so its ONLY gate is the health probe.
  if (pathname === "/watch" || presetSlugFromPath(pathname) !== null) {
    const known = pathname === "/watch" || presetBySlug(presetSlugFromPath(pathname)!) !== null;
    response.headers.set(
      "Cache-Control",
      known && (await isDataLayerHealthy()) ? HTML_CACHE : NO_STORE,
    );
    return response;
  }
  // M7 Task 9. `/airport/:code` gained an optional `y=<year>` query param
  // (app/airport/[code]/page.tsx) selecting one calendar year's network map instead of the
  // page's default trailing-12 view. That is a SECOND cacheability input on top of the
  // airport-slug resolution every other ENTITY_ROUTES row already has -- so airport is pulled
  // out of that generic loop into its own branch here, the same reason `/watch` isn't a fifth
  // ENTITY_ROUTES row either (its own branch above): the shape of what makes it cacheable
  // differs from the other three entities', not merely the resolver it calls.
  //
  // `y`'s legitimate value set is CLOSED -- the calendar years this dataset covers -- which is
  // exactly what makes validating it the right answer instead of `/search`'s blanket
  // `no-store` (that branch's own doc comment, above): `q` is unbounded free text with no set
  // of correct answers to check a candidate against, so nothing short of "never cache" closes
  // the cache-fill vector; `y` has a real closed set, so `parseYear` (lib/year.ts) can reject
  // anything outside it structurally, with no database read, and a well-formed year stays
  // exactly as cacheable as the airport page always was.
  //
  // `y` is read from the RAW query string captured above (`rawQuery`), never from
  // `request.nextUrl.searchParams` -- CLAUDE.md's rule for this file applies to every query
  // key it reads, not only /explore's permalink: `request.nextUrl` re-serializes its parsed
  // searchParams, which is exactly the Next-side normalization this file exists to route
  // around (see the top-of-file comment on `rawQuery` itself). A bare year has no reserved
  // characters to lose to that normalization, but the fix that keeps `/explore` alive is "read
  // the one preserved raw string once", not "re-derive it per key when it happens to matter".
  //
  // Cacheability is an AND of two allow-lists, never a `!== "notFound"`/`!== "invalid"`
  // negation (CLAUDE.md's ENTITY_ROUTES rule, restated for the second input): the airport slug
  // must resolve to `"ok"` or `"redirect"` (`isCacheable`, unchanged), AND `parseYear` must NOT
  // return `"invalid"` -- `"default"` (no `y`) and `"year"` (a real one) are the two cacheable
  // outcomes, exactly mirroring `isCacheable`'s own "new outcome? decline by default" safety
  // property for a future third `ParsedYear` kind.
  const airportSlug = airportSlugFromPath(pathname);
  if (airportSlug !== null) {
    const y = new URLSearchParams(rawQuery).get("y");
    const entityOk = await isCacheable({ resolve: resolveAirportCode }, airportSlug);
    const yearOk = parseYear(y).kind !== "invalid";
    response.headers.set("Cache-Control", entityOk && yearOk ? HTML_CACHE : NO_STORE);
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

/** A cheap, generic health probe: succeeds iff `loadAllowlist()` succeeds, nothing more.
 *
 * Callers, as of M8 Task 4: `/sitemap.xml` and `/robots.txt` (unconditionally, whenever the
 * pathname matches), and `/watch` plus every `/watch/:preset` (gated additionally on the slug
 * being a known preset -- see that branch's own comment, above). `/explore` used this function
 * through M5-M7; M8 Task 4 gave it `isExploreCacheable()` (below) instead, which wraps this same
 * `loadAllowlist()` call but additionally requires the permalink to `decode()` -- a check with no
 * meaning for a slug-only route like `/watch` or a slug-less one like `/sitemap.xml`.
 *
 * The sitemap/robots pair shares a branch, not a risk profile. Neither calls `loadAllowlist()`
 * itself (no reference to it in `app/sitemap.ts` or `app/robots.ts`) -- but `app/sitemap.ts`
 * calls `lib/sitemap.ts`'s `sitemapEntries()`, which runs its own DuckDB queries and can throw
 * (the F4 comment on that branch, above, names the two functions that do by design), while
 * `app/robots.ts` runs no query of any kind: its own header comment says so directly ("This one
 * reads no database at all (BASE_URL is an env var)"), and its output is a static object built
 * only from an env var. So `/robots.txt` is gated on a probe it cannot fail: this branch answers
 * both pathnames with one `if` and one `Cache-Control` expression, and `/robots.txt` inherits the
 * probe as a side effect of that sharing, not because anyone reasoned about its own risk and
 * decided it needed one. Flagged here as a pointless gate, not fixed, since changing it is
 * outside this task.
 *
 * What this does NOT cover, and cannot from here: a throw AFTER this probe succeeds, from a
 * query this bare check never touches. Measured for `/sitemap.xml`, the one caller this
 * applies to: `app/sitemap.ts` runs four DuckDB queries via `lib/sitemap.ts`, and `parseLastmod` /
 * `dedupeAircraftBySlug` both throw by design (the F4 finding, above) -- none of that is
 * `loadAllowlist()`, so a break in any of them still 500s `/sitemap.xml` under `PROJECT_CACHE`.
 * `app/smoke.sh`'s M6 Task 8 gap check measured the identical shape for `/watch/gauge`: dropping
 * `mart_route_health` (what `WatchPresetView`'s `runPreset()` actually reads) leaves
 * `loadAllowlist()` healthy, so the proxy commits to `HTML_CACHE` before the page ever runs its
 * own query, and the 500 that follows still ships the cacheable header. Open gap, and NOT the
 * same one `/explore` carries (that one is `isExploreCacheable`'s to describe, below) -- see
 * docs/architecture/hosting.md § "The gap" for the general account.
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

/** `/explore`'s predicate: the data-layer probe AND the permalink's own validity, in one call.
 *
 * M8 Task 4. The canonical-query gate above rejects unknown query KEYS, but junk VALUES ride
 * legitimate ones: `ExploreView` catches `UrlStateError`/`PivotError` and renders "This permalink
 * can't be read" as a **200** (`app/src/app/explore/page.tsx`), which the proxy long-cached --
 * measured at 4aa8087, `?d=junk1..N` was an unbounded family of cacheable error pages that no
 * key-level rule can see. `decode()` is exactly what `ExploreView` calls next, on the same raw
 * string, and it ends by running `renderPivot()` to validate identifiers -- so this costs no
 * extra database query beyond the `loadAllowlist()` this branch already made as its probe.
 *
 * Consequence, accepted deliberately rather than discovered later: **bare `/explore` is
 * `no-store`**, because `decode("")` throws `missing required key 'v'` and that page has always
 * rendered the error state for it. Nothing links it -- `TopBar` links `/` and `/watch`, the front
 * door links the full sample permalink, and `app/sitemap.ts` has no `/explore` entry.
 *
 * NOT extended to `runPivot()` throwing after `decode()` has succeeded: that is the residual gap
 * `docs/architecture/hosting.md` § "The gap" documents, and this task does not change it. */
async function isExploreCacheable(rawQuery: string): Promise<boolean> {
  try {
    const allowlist = await loadAllowlist();
    decode(rawQuery, allowlist);
    return true;
  } catch {
    return false;
  }
}

/** `/`'s fail-safe probe, and deliberately NOT `isDataLayerHealthy()`.
 *
 * The two probes read different objects, and only this one reads what the front door depends on:
 * `isDataLayerHealthy()` calls `loadAllowlist()`, which reads the pivot catalog views, while
 * `app/src/app/page.tsx` calls `dataAsOf()`, which reads `fct_segment_month` -- a view over
 * `data/parquet/`. A deployment holding `upgauge.duckdb` but not its Parquet tree (`make
 * portability` negative 1, already reproducible) leaves `loadAllowlist()` succeeding while
 * `dataAsOf()` throws, so a `loadAllowlist`-shaped probe here would stamp `HTML_CACHE` on a `/`
 * that is about to 500. That is M6 Task 8's measured bug (§ "The gap", hosting.md) with a
 * different table name: `loadAllowlist()` never opens a Parquet file at all -- it reads only the
 * pivot catalog views -- which is exactly why it cannot stand in for this probe.
 *
 * Costs one extra `data_as_of` per request -- 4.8-5.5 ms measured against the real warehouse --
 * on top of the page's own call. That is the "SECOND resolution for the request" trade
 * `isCacheable`'s doc comment already documents and accepts.
 *
 * Errors are swallowed to `false`, same reasoning as `isDataLayerHealthy()` and `isCacheable()`:
 * declining the cache costs a cache miss, and the page still surfaces the real failure loudly. */
async function isFreshnessReadable(): Promise<boolean> {
  try {
    await dataAsOf();
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
 * `lib/airport.ts`, alongside `AIRPORT_PREFIX`; see that file and `lib/entityLink.ts`).
 *
 * Why the four rows below still call `routeSlugFromPath`/`airportSlugFromPath`/etc. rather than
 * `entitySlugFromPath(pathname, PREFIX)` inlined here, now that all four are one-line wrappers
 * around the same function: `airportSlugFromPath` is NOT a bare partial application of
 * `entitySlugFromPath` -- it additionally maps the bare-prefix empty slug to `null` rather than
 * `""` (`lib/airport.ts`'s own header explains why: an empty code segment must opt the request
 * out of entity resolution entirely, not send `""` into `resolveAirportCode` as a slug to
 * reject). Inlining `entitySlugFromPath(pathname, PREFIX)` for all four here would silently
 * drop that one line for airport alone, and the four rows would stop reading as the same shape
 * they are meant to be. `lib/entitySlug.ts`'s own header records the other three readers'
 * un-opinionated default; this note exists so the next person adding a row does not "simplify"
 * this table by inlining and lose the one reader that isn't a bare wrapper.
 *
 * M7 Task 9 pulled `/airport/:code` back OUT of this table, for the identical reason `/watch`
 * was never added to it (above): the airport branch now has a second cacheability input (the
 * `y` query param, `lib/year.ts`) that this table's generic `isCacheable(entity, slug)` call
 * has no slot for. Its own `if` branch runs BEFORE this loop and returns early, so `/airport`
 * requests never reach the code below at all -- `airportSlugFromPath` and
 * `resolveAirportCode` are still imported and still used, just from that branch instead of
 * from a row here. */
const ENTITY_ROUTES: ReadonlyArray<{
  slugFromPath: (pathname: string) => string | null;
  resolve: (slug: string) => Promise<{ kind: string }>;
}> = [
  { slugFromPath: routeSlugFromPath, resolve: resolveRoutePair },
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

/** The HTML page routes' Cache-Control -- `/explore`, every `ENTITY_ROUTES` page, and (M6 Task
 * 7) `/watch` plus every `/watch/:preset` -- and ONLY those. `/watch`'s pages belong here for
 * the identical reason `/explore` does: each preset page reads live `mart_route_health` state
 * per request (`WatchPresetView`'s `runPreset()`), not a fixed catalog query the way
 * `/sitemap.xml`/`robots.txt` do, so it carries the same per-request-resolution risk this
 * shortened value exists to bound. Do not reuse this for `/api/pivot` (it already sets its own, and stays at the
 * project's full `s-maxage=2592000`, see route.ts) or for `/sitemap.xml`/`robots.txt` (M5 Task
 * 8, below: `PROJECT_CACHE`, not this constant -- neither reads live warehouse state per
 * request the way an entity page's pivot does, so neither carries the risk this shortened
 * value exists to bound) or for `/search` (Task 8: `NO_STORE`, unconditionally -- an unbounded
 * free-text cache key is a cache-fill vector regardless of how short the window is).
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
 * here is a statement about the current dataset, and the dataset changes monthly. `/search`
 * (M5 Task 8) also uses this, unconditionally, for a different reason -- see that branch. */
const NO_STORE = "no-store";
/** CLAUDE.md's project-wide value, applied here (M5 Task 8) to the two surfaces that carry
 * none of the entity pages' per-request resolution risk: `/sitemap.xml` and `/robots.txt` are
 * built from the same catalog queries no matter who is asking, so there is no "is this a
 * well-formed, known entity" question to answer first the way there is for `/explore` or an
 * `ENTITY_ROUTES` page. `/api/pivot` sets this exact string itself, in its own route handler
 * (route.ts) -- untouched by this file, same as always -- so this is a second declaration of
 * one literal value, not a second source of truth for it; keeping the sitemap/robots branch
 * next to `HTML_CACHE`/`NO_STORE` rather than importing a constant from route.ts avoided a
 * page-route module importing a route-handler module for a string. */
const PROJECT_CACHE = "public, s-maxage=2592000, stale-while-revalidate=86400";

// Without a matcher, proxy runs on every request including _next/static and public assets.
// Every entry point needs the header (or, for /api/pivot, the raw-query passthrough only
// -- see above): /api/pivot's own `new URL(request.url).search` is normalized too -- measured,
// every filtered API query returned `malformed filter 'origin_state%3AOR'` before this. They
// now read the identical raw string from one source.
//
// Each `/<entity>/:slug` entry covers every `/<entity>/<anything>` request with exactly ONE
// dynamic segment, matching the segment its `app/<entity>/[x]/page.tsx` owns -- a prefix test in
// spirit, but narrow enough that it cannot accidentally net `/api/pivot` or a future unrelated
// top-level route. `/search`, `/sitemap.xml` and `/robots.txt` (M5 Task 8) are exact-path
// entries for the same reason: each is one literal pathname, not a dynamic segment, and each
// needs the header/cache branches above to run at all -- the sitemap and robots.txt would
// otherwise ship with NO Cache-Control (Next infers none for a MetadataRoute export), and
// `/search`, while its own `no-store` doesn't strictly depend on the pathname header the way a
// `not-found.tsx` does, still follows the same "every route gets a row" discipline this list
// exists to enforce rather than becoming the one silent exception.
//
// THIS LIST AND `ENTITY_ROUTES` MUST AGREE, with the one carved-out exception each of
// `/airport/:code` and `/watch`/`/watch/:preset` already is: those pathnames stay in THIS list
// (the matcher) but have their own `if` branch above rather than a row in `ENTITY_ROUTES`,
// because each has a cacheability question the generic table can't express (a live
// `mart_route_health` read for `/watch`; the `y` query param for `/airport`, M7 Task 9). Absent
// their own branch OR their matcher entry, the same two failure modes below still apply. A row
// here without a row (or branch) there ships an entity page that is long-cached on its 404s; a
// row there without a row here ships a page with no Cache-Control at all AND turns each of its
// 404s into a 500 (`not-found.tsx` throws `MissingRawPathError` when the pathname header is
// absent). Neither asymmetry is visible in a build, a unit test, or a rendered page -- only
// `app/smoke.sh` sees them, which is why every row here has a served-build header assertion and
// a served-build `no-store` assertion there.
//
// ELEVEN entries as of M6 Task 7 (was nine through M5 Task 8) -- `/watch` and `/watch/:preset`
// added here. `/watch` is an exact-path entry, same reasoning as `/search`/`/sitemap.xml`/
// `/robots.txt`: one literal pathname, not a dynamic segment. `/watch/:preset` IS a dynamic
// segment, same shape as the four ENTITY_ROUTES entries -- but it has no ENTITY_ROUTES row of
// its own, because its cacheability branch (above) answers "known" from the static `PRESETS`
// registry rather than a database resolve(). `app/sitemap.ts` is a single default export
// (23,694 URLs -- was 23,689 through M5, +5 for `/watch` and its four presets -- well under
// the sitemap protocol's 50,000-per-file limit, see that file's own header), not
// `generateSitemaps()`'s multi-file convention, so there is exactly one `/sitemap.xml` route to
// list, not a family of numbered children.
//
// STILL eleven at M7 Task 9 -- `/airport/:code` was already here; only its `ENTITY_ROUTES` row
// moved into its own branch above (see that branch's doc comment, and `ENTITY_ROUTES`'s own).
//
// TWELVE as of M8 Task 1 (#13) -- `/` added here, an exact-path entry like `/search`,
// `/sitemap.xml`, `/robots.txt` and `/watch`. It is the only entry whose branch probes
// `dataAsOf()` rather than `isDataLayerHealthy()`; see `isFreshnessReadable`'s doc comment for
// why those two are not interchangeable.
export const config = {
  matcher: [
    "/",
    "/explore",
    "/api/pivot",
    "/route/:pair",
    "/airport/:code",
    "/carrier/:code",
    "/aircraft/:name",
    "/search",
    "/sitemap.xml",
    "/robots.txt",
    "/watch",
    "/watch/:preset",
  ],
};
