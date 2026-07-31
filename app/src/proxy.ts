import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { RAW_PATH_HEADER, routeSlugFromPath } from "@/lib/rawPath";
import { resolveRoutePair } from "@/lib/routePair";

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

  // CLAUDE.md: "Every response gets Cache-Control: public, s-maxage=2592000,
  // stale-while-revalidate=86400" -- the caching IS the cost control, not the hosting tier
  // (docs/architecture/hosting.md). /api/pivot sets its own on the JSON response, including
  // `no-store` on errors, so it must not be overridden here. /explore and /route/<pair> both
  // export `dynamic = "force-dynamic"` (each page's own header comment explains why: their
  // content depends on live warehouse state), so Next emits its own no-store for the HTML and
  // every shared permalink -- the growth mechanic, and the cold-start path the always-on box
  // is sized around -- hit DuckDB with the CDN doing nothing. Setting it on the proxy response
  // is what makes it stick regardless of the route segment config.
  //
  // CRITICAL fix (final whole-branch review): the matcher below used to list only "/explore"
  // and "/api/pivot", so `/route/<pair>` -- M4b's headline SEO-canonical permalink page --
  // shipped `private, no-cache, no-store, max-age=0, must-revalidate`, reproducing the exact
  // bug this file exists to fix. A prefix test (`routeSlugFromPath`), not an exact match: the
  // matcher below only forwards the literal `/route/:pair` shape (one dynamic segment), so
  // this can't accidentally net `/api/pivot` or some future unrelated top-level route.
  //
  // Fix wave 2, NEW-1: the CRITICAL fix above set CACHE on EVERY `/route/` response, with no
  // status discrimination, so a 404 was pinned in a shared CDN cache for 30 days. That
  // outlives the condition that caused it: the dataset refreshes monthly, so `/route/XYZ-JFK`
  // 404ing today because XYZ has no `fct_segment_month` rows yet keeps 404ing for up to
  // another 30 days after the ingest that makes it real -- `stale-while-revalidate` only
  // applies AFTER `s-maxage` expires, so the page cannot self-correct. The project already
  // holds this principle: /api/pivot sets `no-store` on its own error responses.
  //
  // A Next proxy CANNOT read the downstream response status -- `NextResponse.next()` is a
  // passthrough sentinel created before the page runs -- so "exempt 404s" has no direct
  // implementation, and a Server Component page cannot set response headers either. The
  // reframing that DOES have one: cache-worthiness here is not "did it return 200", it is
  // "is this a well-formed, known pair", and that IS knowable before the page runs. A
  // well-formed known pair returns 200 (including the empty-state 200) or a 308 -- both
  // stable, both worth caching. A malformed slug, an unknown code, a self-route or a
  // recognized-but-non-domestic code returns 404 and is not.
  const slug = routeSlugFromPath(pathname);
  if (pathname === "/explore") {
    response.headers.set("Cache-Control", CACHE);
  } else if (slug !== null) {
    response.headers.set("Cache-Control", (await isKnownPair(slug)) ? CACHE : NO_STORE);
  }
  return response;
}

/** The proxy runs on the Node.js runtime -- Next 16's docs are explicit that "Proxy defaults
 * to using the Node.js runtime" and that the `runtime` config option is not available here
 * (.../03-file-conventions/proxy.md:221-223) -- so `lib/db.ts`'s in-process DuckDB is
 * reachable from this file. That was NOT assumed: it was established by building and serving
 * (`make app-smoke`), because this branch has five bugs whose shape was "green tests, broken
 * production" and every one of them was found only by curling a real server.
 *
 * This is a second `resolveRoutePair` for the request -- `page.tsx` runs its own, because the
 * proxy has no channel to hand a resolved object to a Server Component. The alternative
 * (serialising the resolution into a header) would make the page's correctness depend on the
 * proxy having agreed with it, which is a worse trade than one small query.
 *
 * WHAT IT COSTS, measured, because the first version of this comment guessed and guessed
 * WRONG in the expensive direction -- it called this "one extra read of dimension-sized
 * tables ... on a request that is about to run a much larger pivot", and M4d is told to copy
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
 * NOTE the memo it uses is on `globalThis`, not a module-level `let`, and this file is why:
 * Turbopack emits `lib/db.ts` into a separate chunk per entry graph, so the proxy's copy of
 * that module is NOT the page's copy. With a module-level memo the process held three
 * DuckDBInstances (measured), and the proxy's could hold a different snapshot of the
 * database file than the page's -- which is a route straight back to the bug this branch
 * fixed, since the proxy's answer would then be about a file the page is no longer reading.
 *
 * Errors are swallowed to `false`, deliberately: a transient DuckDB failure inside a PROXY
 * would 500 a request that the page itself might well have served, and `false` is the
 * conservative outcome anyway (decline to cache something we could not vouch for). Nothing
 * is hidden by this -- `page.tsx` immediately runs the same resolution unguarded, so a real
 * database failure still surfaces as a loud error from the page. */
async function isKnownPair(slug: string): Promise<boolean> {
  try {
    return (await resolveRoutePair(slug)).kind !== "notFound";
  } catch {
    return false;
  }
}

const CACHE = "public, s-maxage=2592000, stale-while-revalidate=86400";
/** Matches what `/api/pivot`'s route handler already sets on its own error responses. A 404
 * here is a statement about the current dataset, and the dataset changes monthly. */
const NO_STORE = "no-store";

// Without a matcher, proxy runs on every request including _next/static and public assets.
// All three entry points need the header (or, for /api/pivot, the raw-query passthrough only
// -- see above): /api/pivot's own `new URL(request.url).search` is normalized too -- measured,
// every filtered API query returned `malformed filter 'origin_state%3AOR'` before this. They
// now read the identical raw string from one source. `/route/:pair` covers every
// `/route/<anything>` request, matching the dynamic segment `app/route/[pair]/page.tsx` owns.
export const config = {
  matcher: ["/explore", "/api/pivot", "/route/:pair"],
};
