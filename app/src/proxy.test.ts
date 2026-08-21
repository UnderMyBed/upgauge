import { describe, expect, it, vi } from "vitest";

// Partial mock, same shape as app/api/pivot/route.test.ts and app/explore/page.test.tsx: wraps
// the REAL loadAllowlist so every test except the ones that opt in via `mockRejectedValueOnce`
// still exercises the real DuckDB catalog read. M5 Task 7 Part A's fail-safe test needs a way
// to make the proxy's own /explore probe throw without a mock; this codebase's own precedent
// for that (route.test.ts, page.test.tsx) is a partial mock, not a fake in-memory database.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    loadAllowlist: vi.fn(actual.loadAllowlist),
    dataAsOf: vi.fn(actual.dataAsOf),
  };
});

import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { RAW_PATH_HEADER } from "@/lib/rawPath";
import { dataAsOf, loadAllowlist } from "@/lib/db";

// M5 Task 7, Part B fallback: /explore and every entity page get the shorter HTML_CACHE value
// (proxy.ts's own constant, renamed and re-documented there), not CLAUDE.md's project-wide
// 30-day value -- see proxy.ts's HTML_CACHE doc comment and docs/architecture/hosting.md §
// "The gap" for the measured reason a route-handler fix was not reachable.
const CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";

// These tests pin what proxy.ts controls: the headers it sets and the values it copies. They
// CANNOT pin the thing that broke twice in production -- whether Next hands this function a
// normalized `request.url` -- because constructing a NextRequest here bypasses Next's own URL
// normalization entirely. That gap is why `make app-smoke` exists; see the Makefile.
//
// The /route/ cases below DO hit the real database (vitest.config.ts chdirs to the repo root,
// as db.test.ts and page.test.tsx rely on), because the whole point of the cache rule is that
// it depends on whether the pair is real.
describe("proxy", () => {
  it("copies the raw query string, percent-encoding intact", async () => {
    const raw = "v=1&f=origin_state:14%2C771,13%26487&t=2015-01:2015-12";
    const res = await proxy(new NextRequest(`http://localhost/explore?${raw}`));
    expect(getReqHeader(res, RAW_QUERY_HEADER)).toBe(raw);
  });

  it("sets an empty string, not nothing, for a query-less request", async () => {
    const res = await proxy(new NextRequest("http://localhost/explore"));
    expect(getReqHeader(res, RAW_QUERY_HEADER)).toBe("");
  });

  it("copies the pathname, which is the only channel not-found.tsx has", async () => {
    // not-found.js accepts no props and gets no route params; without this header the 404
    // page cannot name what was requested. Fails if the header is dropped or misspelled.
    const res = await proxy(new NextRequest("http://localhost/route/ZZZZ-LAX"));
    expect(getReqHeader(res, RAW_PATH_HEADER)).toBe("/route/ZZZZ-LAX");
  });

  it("sets the project's Cache-Control on /explore", async () => {
    // A permalink that actually DECODES. This test used `?v=1` until M8 Task 4, which was
    // missing four required keys -- fine while the branch only probed the data layer, wrong once
    // cacheability includes the permalink's own validity.
    const res = await proxy(
      new NextRequest(
        "http://localhost/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op",
      ),
    );
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  // M5 Task 7, Part A. Named the bug it exists to catch: before this fix, /explore's branch
  // ran no database query at all and set CACHE unconditionally, so a broken data layer -- the
  // exact scenario docs/architecture/hosting.md § "The gap" measured against a served build --
  // still produced the 30-day header on a page.tsx that was about to 500. `loadAllowlist` is
  // mocked to reject because it is exactly what ExploreView calls first, before its own
  // try/catch (which wraps only decode()+runPivot()) -- this is the query a missing
  // meta_pivot_dimensions/meta_pivot_measures catalog view would break.
  it("does not long-cache /explore when the proxy's own data-layer probe throws", async () => {
    vi.mocked(loadAllowlist).mockRejectedValueOnce(
      new Error("duckdb: Catalog Error: Table with name meta_pivot_dimensions does not exist"),
    );
    // Same decoding permalink as the healthy-case test above, added M8 Task 4: with `?v=1` this
    // would pass for two reasons at once once cacheability includes decode() -- the mocked
    // rejection AND the permalink's own failure to decode -- which makes it vacuous as a probe
    // test. The mocked loadAllowlist() rejection is the only reason this can go red now.
    const res = await proxy(
      new NextRequest(
        "http://localhost/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op",
      ),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // Not vacuous: the immediately-preceding test above (a real request against a healthy
  // database) proves the SAME code path returns CACHE when loadAllowlist() is not made to
  // fail, so the assertion above is actually discriminating on the probe's outcome rather than
  // the branch never being reachable at all.

  // M8 Task 4. The canonical-query gate rejects unknown query KEYS; junk VALUES ride legitimate
  // ones. ExploreView catches UrlStateError/PivotError and renders "This permalink can't be read"
  // as a 200 (app/src/app/explore/page.tsx), and the proxy long-cached it -- so at 4aa8087
  // `?d=junk1..N` was an unbounded family of cacheable error pages. `d=junk` reaches decode()'s
  // renderPivot() call, which raises "unknown dimension 'junk'".
  it("does not long-cache /explore when the permalink does not decode", async () => {
    const res = await proxy(
      new NextRequest("http://localhost/explore?v=1&k=seg&d=junk&m=seats&t=2025-05:2026-04"),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not long-cache a bare /explore, which has always been the error page", async () => {
    // decode("") throws `missing required key 'v'`, so bare /explore renders the error state and
    // is not a cacheable answer. Accepted consequence, and nothing links it: TopBar links / and
    // /watch, the front door links the full sample permalink, and app/sitemap.ts has no
    // /explore entry.
    const res = await proxy(new NextRequest("http://localhost/explore"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sets the project's Cache-Control on a real /route/<pair>", async () => {
    // Critical fix, final whole-branch review: the matcher used to omit /route/<pair>
    // entirely, so page.tsx's own `force-dynamic` export made Next emit `no-store` for
    // every shared /route permalink -- the exact bug this file exists to prevent, just on a
    // different path. Fails if the matcher regresses to ["/explore", "/api/pivot"] or the
    // pathname check reverts to an exact `=== "/explore"`.
    const res = await proxy(new NextRequest("http://localhost/route/JFK-LAX"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("caches the non-canonical spelling too, because it 308s rather than 404s", async () => {
    // LAX-JFK is a well-formed known pair; page.tsx redirects it to the canonical JFK-LAX.
    // A redirect is as stable as the 200 it points at, so it stays cacheable -- a
    // status-shaped rule that exempted "anything that isn't a 200" would wrongly drop this.
    const res = await proxy(new NextRequest("http://localhost/route/LAX-JFK"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  // Fix wave 2, NEW-1. Each of these renders a 404, and a 404 here is a statement about the
  // CURRENT dataset, which is rebuilt monthly: `s-maxage=2592000` would pin it in a shared
  // CDN cache for up to 30 days past the ingest that made the pair real, with no way for the
  // page to self-correct (stale-while-revalidate only applies after s-maxage expires).
  it.each([
    ["an unknown code", "/route/ZZZZ-LAX"],
    ["a recognized but non-domestic code", "/route/JFK-LHR"],
    ["a self-route", "/route/LAX-LAX"],
    ["a malformed slug", "/route/JFK"],
  ])("does not long-cache a 404 from %s", async (_label, path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // M4d. Three more entity pages, one row each in proxy.ts's ENTITY_ROUTES and one each in its
  // matcher. These tests cannot see the matcher at all -- they call `proxy()` directly, so a
  // matcher entry could be missing and every one of them would still pass. That gap is the whole
  // reason `app/smoke.sh` asserts the same header against a served build; see the file header.
  it.each([
    ["a real airport", "/airport/SEA"],
    ["a real carrier", "/carrier/DL"],
    ["a real aircraft type", "/aircraft/B737-8"],
    ["an aircraft slug whose name carries a '/'", "/aircraft/A320-1-2"],
  ])("sets the project's Cache-Control on %s", async (_label, path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it.each([
    ["a lower-case airport code", "/airport/sea"],
    ["a lower-case carrier code", "/carrier/dl"],
    ["a lower-case aircraft slug", "/aircraft/a320-1-2"],
  ])("caches the 308 from %s, because its target is derived from the slug alone", async (
    _label,
    path,
  ) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it.each([
    ["an unknown airport code", "/airport/ZZZZ"],
    ["an airport outside this domestic-only dataset", "/airport/LHR"],
    ["a carrier code nothing has filed under", "/carrier/ZZ"],
    ["a BTS carrier that never filed a segment row", "/carrier/PA"],
    ["an unknown aircraft slug", "/aircraft/NOPE-1"],
    ["an over-separated aircraft slug", "/aircraft/A-B-C-D-E-F"],
  ])("does not long-cache a 404 from %s", async (_label, path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // THE M4d TRAP, and the reason `isCacheable` is an allow-list of kinds rather than
  // `!== "notFound"`. `resolveAircraftSlug` has FOUR outcomes: `/aircraft/CE-180` names BTS codes
  // 030 (CESSNA 180) and 031 (CESSNA 180A/B), resolves to `ambiguous`, and the page renders it as
  // a 404. Copying `/route`'s `!== "notFound"` shape -- the obvious thing to do -- would pin that
  // 404 in a shared CDN cache for 30 days. Fails the moment the predicate is written that way.
  it("does not long-cache the ambiguous-slug 404, which is not a 'notFound'", async () => {
    const res = await proxy(new NextRequest("http://localhost/aircraft/CE-180"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // The header the three M4d not-found.tsx files read. Without a matcher entry it is absent and
  // each of them throws MissingRawPathError -- a 500 where a 404 was the answer -- so this is a
  // 500-vs-404 test, not a cosmetic one. (Again: only smoke.sh can see the matcher itself.)
  it.each([
    ["/airport/ZZZZ"],
    ["/carrier/ZZ"],
    ["/aircraft/NOPE-1"],
  ])("copies the pathname for %s, without which its not-found.tsx throws", async (path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(getReqHeader(res, RAW_PATH_HEADER)).toBe(path);
  });

  // The prefix readers must not net each other, or a request would be resolved by the wrong
  // entity's lookup -- and `/aircraft/...` sits under a prefix that shares its first four
  // characters with nothing else here only by luck of naming. `/` itself moved out of this list
  // in M8 Task 1 (#13): it now has its own branch above and is no longer "not an entity page".
  it.each([
    ["/routes/JFK-LAX", null],
    ["/airports/SEA", null],
    ["/carrierz/DL", null],
  ])("sets no Cache-Control on %s, which is not an entity page", async (path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("leaves /api/pivot's own Cache-Control alone", async () => {
    // route.ts sets `no-store` on errors and the long cache on success; overriding here would
    // make every 400 publicly cacheable for a month.
    const res = await proxy(new NextRequest("http://localhost/api/pivot?v=1"));
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  // M5 Task 8. `/search` is `no-store` UNCONDITIONALLY -- not the well-formed-vs-not split
  // ENTITY_ROUTES gets, because `q` is an unbounded, attacker-chosen string and there is no
  // proxy-side resolution that would make caching it safe. Two different queries prove it is
  // unconditional rather than a coincidence of one input: a query that resolves (PDX, a real
  // airport code) and one that cannot possibly resolve to anything real.
  it.each([
    ["a query that resolves to a real entity", "/search?q=PDX"],
    ["a query that cannot resolve to anything", "/search?q=zzzzzzzzzz"],
  ])("sets /search to no-store regardless of whether %s", async (_label, path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // The sitemap and robots.txt carry none of the entity pages' per-request resolution risk, so
  // they get CLAUDE.md's project-wide value outright -- neither app/sitemap.ts nor
  // app/robots.ts sets its own Cache-Control, so absent this branch they would ship with none
  // at all (Next infers no shared-cache header for a MetadataRoute export).
  it.each([["/sitemap.xml"], ["/robots.txt"]])(
    "sets the project's 30-day Cache-Control on %s",
    async (path) => {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.headers.get("Cache-Control")).toBe(
        "public, s-maxage=2592000, stale-while-revalidate=86400",
      );
    },
  );

  // Final whole-branch review, F4. Same shape as /explore's "does not long-cache ... when the
  // proxy's own data-layer probe throws" above -- and the same gap: the sitemap/robots branch
  // used to set PROJECT_CACHE unconditionally, with no isDataLayerHealthy() probe, even though
  // app/sitemap.ts runs four DuckDB queries and both parseLastmod and dedupeAircraftBySlug
  // throw by design. A broken data layer would 500 /sitemap.xml -- the one URL the entire
  // crawl graph is submitted through -- under a 30-DAY shared-cache header, worse than
  // /explore's now-one-hour exposure because this branch bypassed the probe entirely.
  it.each([["/sitemap.xml"], ["/robots.txt"]])(
    "does not long-cache %s when the proxy's own data-layer probe throws",
    async (path) => {
      vi.mocked(loadAllowlist).mockRejectedValueOnce(
        new Error("duckdb: Catalog Error: Table with name meta_pivot_dimensions does not exist"),
      );
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  // M5 Task 8's own version of the M4d trap above: a request under a prefix that merely LOOKS
  // like one of the three new exact-path routes must not be netted by them. `/search` is an
  // exact match, not a prefix, so a nested path falls through untouched.
  it.each([["/search/nope"], ["/sitemap.xml.map"], ["/robots.txt.bak"]])(
    "sets no Cache-Control on %s, which is not one of the three exact routes",
    async (path) => {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.headers.get("Cache-Control")).toBeNull();
    },
  );

  // M6 Task 7. `/watch` and every `/watch/:preset` get the same shorter HTML_CACHE as /explore
  // and the four ENTITY_ROUTES pages, not PROJECT_CACHE -- each preset page reads live
  // mart_route_health state per request, the same per-request-resolution risk /explore carries
  // and /sitemap.xml/robots.txt do not.
  it("gives the /watch index HTML_CACHE", async () => {
    const res = await proxy(new NextRequest("http://localhost/watch"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("gives a known preset HTML_CACHE", async () => {
    const res = await proxy(new NextRequest("http://localhost/watch/gauge"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("gives an unknown preset no-store", async () => {
    // 404s are never cached: the dataset is rebuilt monthly and a 404 pinned in a shared cache
    // outlives the condition that caused it.
    const res = await proxy(new NextRequest("http://localhost/watch/nope"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // THE bug this catches, and it has already shipped once on this project: M5's final review
  // found /sitemap.xml setting PROJECT_CACHE unconditionally with no health probe. A static
  // slug allow-list cannot see a broken database, and the proxy commits to a header BEFORE the
  // page runs -- so a 500 would go out under a one-hour public cache. `/watch/gauge` is a KNOWN
  // preset (the allow-list says yes), so the only thing standing between it and HTML_CACHE here
  // is the probe -- this is the test that isolates that.
  it("declines to cache /watch when the data layer is broken", async () => {
    vi.mocked(loadAllowlist).mockRejectedValueOnce(
      new Error("duckdb: Catalog Error: Table with name mart_route_health does not exist"),
    );
    const res = await proxy(new NextRequest("http://localhost/watch/gauge"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // Same probe, same reasoning, on the bare index: unlike a preset slug, `/watch` has no id to
  // fail to resolve at all, so if this branch's "known" check were the only gate, `/watch`
  // would ALWAYS read as known and this test would be the only thing catching a dropped probe
  // on that specific path.
  it("declines to cache the /watch index when the data layer is broken", async () => {
    vi.mocked(loadAllowlist).mockRejectedValueOnce(
      new Error("duckdb: Catalog Error: Table with name mart_route_health does not exist"),
    );
    const res = await proxy(new NextRequest("http://localhost/watch"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // The header /watch/[preset]/not-found.tsx reads. Without a matcher entry it is absent and
  // that not-found.tsx throws MissingRawPathError -- a 500 where a 404 was the answer, same
  // shape as the ENTITY_ROUTES pages' equivalent test above.
  it("copies the pathname for /watch/nope, without which its not-found.tsx throws", async () => {
    const res = await proxy(new NextRequest("http://localhost/watch/nope"));
    expect(getReqHeader(res, RAW_PATH_HEADER)).toBe("/watch/nope");
  });

  // Prefix guard, same shape as the M4d/M5 traps above: a path that merely LOOKS like /watch
  // must not be netted by the exact-match branch or by presetSlugFromPath's prefix test.
  it.each([["/watches"], ["/watch-list"]])(
    "sets no Cache-Control on %s, which is not /watch",
    async (path) => {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.headers.get("Cache-Control")).toBeNull();
    },
  );

  // M7 Task 9. `/airport/:code?y=<year>` -- `y`'s legitimate value set is closed (the calendar
  // years this dataset covers), which is what makes validating it the right answer instead of
  // /search's blanket no-store (that branch's own test above). Both halves are required: a
  // `no-store`-everywhere regression would pass "declines to cache ... out-of-range" vacuously,
  // so "still caches ... a valid year" has to go red too for the pair to mean anything.
  it("declines to cache an airport page with an out-of-range year", async () => {
    const res = await proxy(new NextRequest("http://localhost/airport/SEA?y=1999"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("still caches an airport page with a valid year", async () => {
    // The other half. Without this, `no-store` everywhere passes the test above vacuously --
    // both halves or neither.
    const res = await proxy(new NextRequest("http://localhost/airport/SEA?y=2019"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("still caches an airport page with no y at all -- the default trailing-12 view", async () => {
    // parseYear(null) is "default", not "invalid" -- an implementation that flipped the
    // allow-list to require an explicit "year" kind would fail every un-parameterized
    // /airport/<code> request, which is the overwhelming majority of this page's traffic.
    const res = await proxy(new NextRequest("http://localhost/airport/SEA"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("declines to cache a malformed year the same way as an out-of-range one", async () => {
    const res = await proxy(new NextRequest("http://localhost/airport/SEA?y=nonsense"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("still declines the cache when BOTH the airport and the year are bad", async () => {
    // Guards the `&&` in `entityOk && yearOk`: a mutant that dropped the airport half (caching
    // on year-validity alone) would pass every test above but cache a 404.
    const res = await proxy(new NextRequest("http://localhost/airport/ZZZZ?y=1999"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reads y from the raw query string, not from a normalized searchParams", async () => {
    // Same discipline as the raw-query tests at the top of this file: constructing a
    // NextRequest here does not exercise Next's own normalization, so this test cannot itself
    // distinguish rawQuery from request.nextUrl.searchParams -- app/smoke.sh's own /airport
    // section is what actually proves the raw-header path end to end. This used to carry a
    // second, unrelated `&other=1` key to prove the branch reads a real query rather than an
    // empty one, but M8 Task 3's canonicalization gate (canonicalize(), lib/canonicalQuery.ts)
    // now 307s any key outside AIRPORT_KEYS = {"y"} before this branch ever runs -- so a lone
    // `y` is the only shape this branch still sees, and that second key would make this test
    // assert a redirect, not a cache header.
    const res = await proxy(new NextRequest("http://localhost/airport/SEA?y=2020"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  // #8. The four OG card routes. Before this they were absent from the matcher entirely, so each
  // shipped `ImageResponse`'s own default -- measured on a served build, `next start` on :3251:
  // `cache-control: public, max-age=0, must-revalidate`, which forbids a shared cache from
  // serving the card without revalidating, on 23,780 URLs whose only traffic is crawlers
  // re-fetching them.
  //
  // HTML_CACHE, not PROJECT_CACHE: a card runs the same live warehouse reads its page does
  // (dataAsOf, runPivot, fetchAircraftMix, out of lib/entityFacts.ts by design), so it carries
  // the per-request-resolution risk the shortened s-maxage exists to bound -- see proxy.ts's
  // HTML_CACHE doc comment and its OG branch.
  it.each([
    ["a real route", "/route/JFK-LAX/opengraph-image"],
    ["a real airport", "/airport/SEA/opengraph-image"],
    ["a real carrier", "/carrier/DL/opengraph-image"],
    ["a real aircraft type", "/aircraft/B737-8/opengraph-image"],
  ])("gives the OG card for %s HTML_CACHE", async (_label, path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  // THE ORDERING TEST for the `/airport` branch, and it has to be a 404 card rather than a real
  // one. Every entity slug reader is a bare prefix test that does not stop at one segment, so
  // `airportSlugFromPath("/airport/SEA/opengraph-image")` is `"SEA/opengraph-image"` -- and with
  // the OG loop moved BELOW the airport branch, that branch claims the request and hands that
  // string to `resolveAirportCode`, which UPPERCASES BEFORE IT LOOKS ANYTHING UP: the lowercase
  // `opengraph-image` in the slug makes it answer `redirect`, which `isCacheable` allows. So the
  // real card above still gets HTML_CACHE under the mutant -- the right header for entirely the
  // wrong reason, pointing at a 308 to `/airport/SEA%2FOPENGRAPH-IMAGE`. MUTANT RUN: moving the
  // OG loop below the airport branch leaves every "real card" case green and reddens exactly the
  // 404 cards, because `LHR/opengraph-image` is a `redirect` too and the correct answer for a
  // non-domestic code is `no-store`. This is CLAUDE.md's rule about asserting the outcome a buggy
  // implementation also produces, met head-on: the discriminating input is the one where the two
  // branches DISAGREE, not the one where both happen to say CACHE.
  it("resolves an airport CARD from the OG branch, not from the /airport branch below it", async () => {
    const res = await proxy(new NextRequest("http://localhost/airport/LHR/opengraph-image"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // A card takes no query of its own -- not even `y`, which its PAGE reads. The airport row in
  // canonicalQuery.ts declares NO_KEYS for the card, so `?y=2019` is redirected away before the
  // OG branch runs. A row that reused AIRPORT_KEYS for the card would make `?y=1..N` an unbounded
  // family of long-cached card renders instead.
  it("307s a page-only query key off an airport card", async () => {
    const res = await proxy(new NextRequest("http://localhost/airport/SEA/opengraph-image?y=2019"));
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("http://localhost/airport/SEA/opengraph-image");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["an unknown route code", "/route/ZZZZ-LAX/opengraph-image"],
    ["a self-route", "/route/LAX-LAX/opengraph-image"],
    ["an unknown airport code", "/airport/ZZZZ/opengraph-image"],
    ["a carrier code nothing has filed under", "/carrier/ZZ/opengraph-image"],
    ["an unknown aircraft slug", "/aircraft/NOPE-1/opengraph-image"],
  ])("does not long-cache the OG card 404 from %s", async (_label, path) => {
    // Same rule as every entity page's 404: the dataset is rebuilt monthly, so a 404 pinned in a
    // shared cache outlives the condition that caused it. The card route's own `notFound()` uses
    // the identical allow-list, so this header and that status cannot disagree.
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // THE M4d TRAP AGAIN, one level down, and the reason the OG branch reuses `isCacheable` rather
  // than growing its own predicate. `resolveAircraftSlug` has FOUR outcomes: `/aircraft/CE-180`
  // is `ambiguous` (BTS 030 CESSNA 180 and 031 CESSNA 180A/B share one short name), the card
  // route renders it as a 404, and a `!== "notFound"` test -- the obvious shape -- would pin that
  // 404 in a shared CDN cache for HTML_CACHE's full s-maxage. MUTANT RUN: widening the OG branch
  // to `kind !== "notFound"` turns exactly this test red.
  it("does not long-cache the ambiguous-slug OG card 404, which is not a 'notFound'", async () => {
    const res = await proxy(new NextRequest("http://localhost/aircraft/CE-180/opengraph-image"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("caches a card whose slug 308s, because its target is derived from the slug alone", async () => {
    // The card route `permanentRedirect`s a non-canonical slug to the canonical card, exactly as
    // the page does. A redirect derived from the slug alone cannot be invalidated by an ingest,
    // so it stays cacheable -- and a status-shaped rule that exempted "anything not a 200" would
    // wrongly drop it.
    const res = await proxy(new NextRequest("http://localhost/route/LAX-JFK/opengraph-image"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("sets no Cache-Control on the bare /opengraph-image suffix, which belongs to no entity", async () => {
    // A reader that tested the suffix without also requiring a non-empty slug under a known
    // prefix would send `""` into a resolver here. The other shapes the reader must refuse --
    // two dynamic segments, an empty slug -- are asserted in canonicalQuery.test.ts against
    // `QUERY_ROWS.find`, because at THIS layer they fall through to the entity branches and get
    // `no-store` either way, so the assertion could not discriminate.
    const res = await proxy(new NextRequest("http://localhost/opengraph-image"));
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  // The landmine, and the one assertion here that a green unit suite could not have found on its
  // own: Next appends a KEYLESS content hash to every file-convention og:image URL. Measured on
  // the served production build --
  // `<meta property="og:image" content=".../route/JFK-LAX/opengraph-image?083d4242d9090de4"/>`,
  // one hash per opengraph-image.tsx FILE (all three of /route/JFK-LAX, /route/ORD-LAX and
  // /route/HNL-ITO carried `083d4242d9090de4`). A keyless chunk is exactly the axis rule 4 of
  // lib/canonicalQuery.ts exists to catch, so without the `cacheBuster` declaration the proxy
  // would 307 the site's own card URL on all four entity pages. The SHAPE is pinned here, never
  // the literal: the hash is `[contenthash]` over the compiled route file and changes whenever
  // that file is edited.
  it.each([
    ["/route/JFK-LAX/opengraph-image"],
    ["/airport/SEA/opengraph-image"],
    ["/carrier/DL/opengraph-image"],
    ["/aircraft/B737-8/opengraph-image"],
  ])("serves %s with its cache-buster instead of redirecting it", async (path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}?083d4242d9090de4`));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("307s a keyless chunk on a card that is not cache-buster-shaped", async () => {
    // The bound. Admitting EVERY keyless chunk would pass the four tests above and re-open the
    // unbounded cache-key family on 23,780 URLs -- `?x`, `?xx`, `?xxx`, ... each a distinct CDN
    // entry for a byte-identical PNG.
    const res = await proxy(new NextRequest("http://localhost/route/JFK-LAX/opengraph-image?zz"));
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("http://localhost/route/JFK-LAX/opengraph-image");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("307s a doubled '?' on a card instead of 500ing on it", async () => {
    // CLAUDE.md's rule, re-run against the new predicates: `rawQuery` is
    // `.search.replace(/^\?/, "")`, NON-global, and proxy() has no try/catch, so a doubled `?`
    // reaching a throwing predicate is a 500 on every matcher path at once. `ogSlugFromPath`
    // delegates its decode to lib/entitySlug.ts's guard for the same reason.
    const res = await proxy(
      new NextRequest("http://localhost/route/JFK-LAX/opengraph-image??083d4242d9090de4"),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe(
      "http://localhost/route/JFK-LAX/opengraph-image?083d4242d9090de4",
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("copies the pathname for an OG card request", async () => {
    // An opengraph-image.tsx compiles to a route handler, so there is no not-found.tsx on this
    // path and no MissingRawPathError to trigger -- but the header rides the same
    // NextResponse.next({request:{headers}}) every matcher path gets, and a branch that built a
    // fresh response would silently drop it for a future reader of it.
    const res = await proxy(new NextRequest("http://localhost/route/JFK-LAX/opengraph-image"));
    expect(getReqHeader(res, RAW_PATH_HEADER)).toBe("/route/JFK-LAX/opengraph-image");
  });

  it("lists all four OG card routes in the matcher", async () => {
    // proxy() takes a request, not a matcher, so every test above passes just as well with the
    // matcher entries missing -- and then NOTHING in this file runs in production, because the
    // proxy is never invoked for those paths. Only `app/smoke.sh` sees the real thing; this is
    // the cheapest guard short of it. MUTANT RUN: removing "/route/:pair/opengraph-image" from
    // config.matcher turns this red, and canonicalQuery.test.ts's agreement test with it.
    const { config } = await import("@/proxy");
    expect(config.matcher).toContain("/route/:pair/opengraph-image");
    expect(config.matcher).toContain("/airport/:code/opengraph-image");
    expect(config.matcher).toContain("/carrier/:code/opengraph-image");
    expect(config.matcher).toContain("/aircraft/:name/opengraph-image");
  });

  it("deliberately leaves /api/health out of the matcher", async () => {
    const { config } = await import("@/proxy");
    // Not a style preference. The matcher grants cacheability; the healthcheck must never be
    // cached, sets its own no-store, takes no query and has no not-found path. This test exists
    // so a future "add every route to the matcher" sweep cannot quietly make it cacheable.
    expect(config.matcher).not.toContain("/api/health");
    // Anti-vacuity: prove this test is reading the real matcher.
    expect(config.matcher).toContain("/api/pivot");
  });

  // M8 Task 1 (#13). `/` was the one page route missing from config.matcher, so it fell through
  // to Next's own force-dynamic fallback: measured on a served build at 4aa8087:
  // `private, no-cache, no-store, max-age=0, must-revalidate` -- which forbids caching
  // EVERYWHERE including the CDN, on the front door, which queries DuckDB for DATA AS OF.
  it("sets the project's Cache-Control on /", async () => {
    const res = await proxy(new NextRequest("http://localhost/"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  // The bug this catches: giving `/` the isDataLayerHealthy() probe every other branch uses.
  // That probe calls loadAllowlist(), which reads the pivot catalog views; `/`'s page reads
  // dataAsOf(), which reads fct_segment_month -- a view over data/parquet/. A deployment holding
  // upgauge.duckdb but not its Parquet tree (`make portability` negative 1) leaves loadAllowlist()
  // succeeding while dataAsOf() throws, so the wrong probe stamps HTML_CACHE on a 500. That is
  // M6 Task 8's measured bug with a different table name.
  it("does not long-cache / when dataAsOf throws", async () => {
    vi.mocked(dataAsOf).mockRejectedValueOnce(
      new Error("duckdb: IO Error: No files found that match the pattern data/parquet/..."),
    );
    const res = await proxy(new NextRequest("http://localhost/"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // The other half of the same pair, and the reason it is a PAIR: a wrong probe passes every
  // test where both probes agree, so only an input where they DISAGREE can tell them apart.
  // `/` must not consult the pivot catalog at all. Asserted as "was never called" rather than
  // by rejecting loadAllowlist, because a queued mockRejectedValueOnce that `/` never consumes
  // would leak into whichever later test calls loadAllowlist first.
  it("never asks the pivot catalog about /", async () => {
    vi.mocked(loadAllowlist).mockClear();
    await proxy(new NextRequest("http://localhost/"));
    expect(vi.mocked(loadAllowlist)).not.toHaveBeenCalled();
  });

  // M8 Task 3 (epic #3). Cloudflare's default cache key includes the full query string, so
  // before this gate `?x=1..N` minted an unbounded family of long-cached entries on every
  // cacheable path -- measured at 4aa8087, on all TEN that this gate answers for. `/api/pivot` is
  // an ELEVENTH cacheable path (its own successes take the same 30-day PROJECT_CACHE) and it
  // carried the same disease on a different axis, closed in its own handler rather than here --
  // see app/api/pivot/route.ts and lib/canonicalQuery.ts's `queryVerdict`. `/search` is the
  // twelfth matcher entry and the only one that is never cacheable at all.
  //
  // DEVIATION from the task brief's literal code, measured rather than assumed (see the doc
  // comment on this gate in proxy.ts, and this task's report for the exact served-build error):
  // the brief's `Location: canonical.location` (bare relative) 500s EVERY redirect below on a
  // served build. `next/dist/server/web/adapter.js` reads `Location` off whatever `proxy()`
  // returns and does `new NextURL(redirect, {...})` with no base argument -- `ERR_INVALID_URL`
  // for any relative string, for a `new NextResponse` exactly as much as for
  // `NextResponse.redirect()` (that factory only forces its OWN argument absolute; it does not
  // change what the adapter does to the header afterward). So every `Location` value below is
  // built ABSOLUTE, scoped to `request.nextUrl.origin`. What relativizes it back down before the
  // wire is NOT that same adapter code (whole-branch review round 2, Finding 3: that
  // relativization branch is dead-code eliminated by `skipProxyUrlNormalize` in this build) --
  // it is `next/dist/server/lib/router-utils/resolve-routes.js`'s unconditional
  // `getRelativeURL(location, initUrl)`, where `initUrl` is THIS SERVER'S OWN bind config, not
  // the client's `Host` header (proxy.ts's own doc comment on this gate has the full citation
  // and the Host-spoofing measurement that confirms it). `proxy()` alone can only see the
  // pre-relativization (absolute) value, which is what every assertion below pins;
  // `app/smoke.sh`'s canonical-query section is what asserts the actual wire bytes are relative.
  it("307s an unknown query key to the canonical URL, uncached", async () => {
    const res = await proxy(new NextRequest("http://localhost/watch?x=1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("http://localhost/watch");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // CRITICAL, whole-branch review. `rawQuery` above is
  // `new URL(request.url).search.replace(/^\?/, "")` and that regex is NOT global, so a doubled
  // `?` in the request line reaches canonicalize() with one `?` still on the front. It used to
  // throw there ("a wiring bug, not something a real request can trigger"), proxy() has no
  // try/catch around the call, and Next answered 500 -- on all twelve matcher paths, `/` and
  // `/sitemap.xml` included, to any client with no auth and no unusual encoding. Measured on a
  // served build at d109845, and re-measured by restoring the throw on top of the fix:
  // `/watch?x=1` 307, `/watch??x=1` 500, and the same for every other doubled-`?` row in
  // app/smoke.sh §15. `?x=1..N` behind a doubled `?` is itself an unbounded family of
  // origin-hitting 500s -- the same cost shape this gate exists to close.
  it("307s a doubled '?' instead of 500ing on it", async () => {
    const res = await proxy(new NextRequest("http://localhost/watch??x=1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("http://localhost/watch");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps the legitimate key behind a doubled '?', rather than dropping it", async () => {
    // The discriminating half: a fix that answered `?y=2019` by treating "?y" as an unknown key
    // would 307 to `/airport/ORD` -- no 500, and the year silently gone. The location is also the
    // one `/airport/ORD??y=2019` and `/airport/ORD???y=2019` must SHARE, or the same typo typed
    // twice is two cache entries again (canonicalQuery.test.ts pins the run-collapsing rule).
    const res = await proxy(new NextRequest("http://localhost/airport/ORD??y=2019"));
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("http://localhost/airport/ORD?y=2019");
  });

  it("redirects with 307, never 308", async () => {
    // A 308 is cached by the requesting browser permanently, independent of any CDN, so a
    // canonicalisation rule that ever changes would leave wrong permanent client-side redirects
    // no server-side fix could reach. Same reason /search 307s.
    const res = await proxy(new NextRequest("http://localhost/carrier/DL?utm_source=x"));
    expect(res.status).toBe(307);
    expect(res.status).not.toBe(308);
  });

  it("keeps a legitimate key while stripping the junk beside it", async () => {
    const res = await proxy(new NextRequest("http://localhost/airport/ORD?y=2019&junk=1"));
    expect(res.headers.get("Location")).toBe("http://localhost/airport/ORD?y=2019");
  });

  // The property that actually matters at this layer, given the deviation above: the origin
  // comes from the REQUEST, not a hardcoded host -- a request against a different host must
  // redirect to that same host, not to whatever default this process was last configured with.
  // A mutant that hardcodes the origin (e.g. `request.url` replaced by a literal
  // `"http://localhost:3000"`) would pass every test above, which all happen to use `localhost`,
  // and only goes red here.
  it("builds the Location from the request's own origin, not a hardcoded host", async () => {
    const res = await proxy(new NextRequest("https://upgauge.example/route/JFK-LAX?cachebust=99"));
    expect(res.headers.get("Location")).toBe("https://upgauge.example/route/JFK-LAX");
  });

  it("declines to cache a duplicated key, and does not redirect it", async () => {
    // ?y=2019&y=2020 was cacheable at 4aa8087 because parseYear reads the FIRST y. There is no
    // canonical form to send the caller to, so this is no-store on the page as rendered, not a
    // redirect that silently drops one occurrence.
    const res = await proxy(new NextRequest("http://localhost/airport/ORD?y=2019&y=2020"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("leaves /api/pivot's own query untouched, header and all", async () => {
    // The handler already answers 400 + no-store for an unknown key; a 307 on a JSON endpoint
    // would be worse. The raw-query header must still reach it.
    const raw = "v=1&bogus=1";
    const res = await proxy(new NextRequest(`http://localhost/api/pivot?${raw}`));
    expect(res.headers.get("Location")).toBeNull();
    expect(getReqHeader(res, RAW_QUERY_HEADER)).toBe(raw);
  });

  it("leaves /search's unbounded query untouched and unconditionally uncached", async () => {
    const res = await proxy(new NextRequest("http://localhost/search?q=DL&x=1"));
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // CRITICAL 1 (whole-branch review round 2). Every RSC request to a gated path used to be an
  // infinite redirect loop: Next's own client appends a `_rsc=<hash>` cache-busting query param
  // to every RSC fetch and sets the `RSC: 1` header; `_rsc` is in no row's `keys`, so the gate
  // above 307d it away, and Next's OWN server then 307d BACK to the URL WITH the correct hash
  // (`experimental.validateRSCRequestHeaders`, default true) -- the two alternated forever.
  // Measured on a served build: `/`, `/explore`, every entity page, `/watch`, `/watch/gauge` all
  // hit the redirect cap and never settled (see this task's fix report for the exact curl
  // output). The fix: an RSC request never reaches `canonicalize()` -- see proxy.ts's own doc
  // comment on this branch for why gating on the HEADER, not adding `_rsc` to `keys`, is what
  // closes the hole rather than reopening it (a plain `GET ?_rsc=1..N` with no `RSC` header
  // would otherwise become clean-and-cacheable).
  //
  // This unit test cannot see the loop itself -- `proxy()` never crosses Next's own server-side
  // RSC validation, so it can only pin what THIS file does: does not redirect, does carry
  // `no-store`. `app/smoke.sh`'s "RSC requests never loop" section is what proves the loop is
  // actually gone against a served build.
  it("never redirects an RSC request, and answers it no-store instead", async () => {
    const res = await proxy(
      new NextRequest("http://localhost/watch?x=1", { headers: { RSC: "1" } }),
    );
    expect(res.status).not.toBe(307);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // The control this pair needs to mean anything: the IDENTICAL URL, minus the RSC header,
  // must still 307 exactly as every other non-canonical-query test in this file does. Without
  // this, the test above would pass just as well against a gate that had been deleted entirely
  // -- it is the pair, not either half alone, that proves the bypass fires ONLY on RSC.
  it("...and the control: the identical URL without the RSC header still 307s", async () => {
    const res = await proxy(new NextRequest("http://localhost/watch?x=1"));
    expect(res.status).toBe(307);
  });
});

/** NextResponse.next({request:{headers}}) encodes the upstream request headers into the
 * response's own `x-middleware-request-*` set; this reads the value back out whichever
 * spelling this Next version uses. */
function getReqHeader(res: { headers: Headers }, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`) ?? res.headers.get(name);
}

// #52. The key gate rejects unknown KEYS and M8 Task 4 required the permalink to decode();
// neither sees a junk VALUE riding a legitimate key. Every URL below still decodes cleanly --
// bare `decode()` accepts all of them by design, and `bounds.test.ts` pins that -- and until the
// proxy called `decodeRequest`, each rendered a distinct 200 under HTML_CACHE. Cloudflare's
// default cache key is the whole query string, so every one was a guaranteed origin miss on the
// most expensive page here.
//
// THREE FAMILIES, not one, and the last two are the ones a range check cannot see:
//   value     `t` outside the window or reversed; `n` above the ceiling.
//   spelling  every byte of `t`/`k`/`d`/`m`/`s`/`g` may be sent as `%XX` in either hex case,
//             because decode() pyUnquotes at urlstate.ts:179 and checks the shape at :214.
//             `t=2015-01:2015-12` alone has 110,592 spellings of one admissible value.
//   repetition `d` and `m` are split on `,` and nothing dedupes, so one token may repeat any
//             number of times.
describe("proxy /explore value bounds (#52)", () => {
  const BASE = "v=1&k=seg&d=op_airline_id&m=seats&s=-seats&g=op";
  const at = (qs: string) => proxy(new NextRequest(`http://localhost/explore?${qs}`));

  it("does not long-cache /explore when t falls outside the dataset window", async () => {
    const res = await at(`${BASE}&t=1999-01:1999-12&n=25`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not long-cache /explore when t is reversed but both months are in window", async () => {
    // Both months are admissible on their own, so this can only go red for the ordering rule.
    const res = await at(`${BASE}&t=2026-04:2025-05&n=25`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not long-cache /explore when a filter value cannot cast to its column type", async () => {
    // Issue #87, and the assertion the whole fix exists for. `2T (1)` on op_airline_id (INTEGER)
    // used to decode cleanly, reach a bound VARCHAR param, and throw a DuckDB Conversion Error at
    // EXECUTION -- by which point this function had already written HTML_CACHE, so a shared cache
    // held the 500 for up to an hour for one request. renderPivot now rejects it inside decode(),
    // which isExploreCacheable() catches.
    const res = await at(`${BASE}&t=2025-05:2026-04&f=op_airline_id:2T%20%281%29&n=25`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not long-cache /explore when an all-digits filter value overflows its column", async () => {
    // The half a digits-only rule cannot see: every character of 99999 is a digit, and
    // distance_group is SMALLINT (max 32767), so this threw exactly like the case above.
    const res = await at(`${BASE}&t=2025-05:2026-04&f=distance_group:99999&n=25`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("still long-caches /explore when the same filter value is valid for its column", async () => {
    // The control that stops the two above being vacuous: same key, same shape, castable value.
    const res = await at(`${BASE}&t=2025-05:2026-04&f=op_airline_id:19790&n=25`);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("does not long-cache /explore when n is above the ceiling", async () => {
    const res = await at(`${BASE}&t=2025-05:2026-04&n=999999`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not long-cache /explore when n is spelled redundantly", async () => {
    // n=00000025 decodes to 25 -- an in-bounds value with unboundedly many spellings, each a
    // distinct CDN entry for a byte-identical page.
    const res = await at(`${BASE}&t=2025-05:2026-04&n=00000025`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not long-cache /explore when t is percent-encoded", async () => {
    // The spelling family on a TEXTUAL key: `%32015-05` unquotes to `2015-05` before MONTH_RE
    // ever runs, so this is in-window, correctly ordered, under the ceiling -- and byte-identical
    // to the control below once rendered. Only a raw-byte rule can decline it.
    const res = await at(`${BASE}&t=%32025-05:2026-04&n=25`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not long-cache /explore when t's structural colon is percent-encoded", async () => {
    const res = await at(`${BASE}&t=2025-05%3A2026-04&n=25`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not long-cache /explore when a measure repeats", async () => {
    // Not a spelling variant -- the page really does render the column twice -- but unbounded in
    // exactly the same way: `m=seats,seats,...` for any number of repeats.
    const res = await at(`${BASE.replace("m=seats", "m=seats,seats")}&t=2025-05:2026-04&n=25`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("still long-caches the SAME query with every value in bounds", async () => {
    // The control that stops all seven above being vacuous: a proxy that answered `no-store`
    // for every /explore request would satisfy them and this one goes red for it.
    const res = await at(`${BASE}&t=2025-05:2026-04&n=25`);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("still long-caches a permalink whose FILTER value is percent-encoded", async () => {
    // The second control, and the one that would break shipped permalinks: `f` is exempt from
    // the raw-byte rule because quote() must escape `,`, `:`, `&`, `=` and spaces there. The
    // golden filter_value_encodeuricomponent_divergence is
    // `f=origin_state:2T%20%281%29,...`. A blanket "no % anywhere" reddens this.
    //
    // origin_state, not an id column: renderPivot type-checks a filter value against its
    // dimension's column type, so '2T (1)' on op_airline_id is now a PivotError and this
    // request would be `no-store` for that reason rather than the percent-encoding one --
    // which would make this control vacuous instead of red.
    const res = await at(`${BASE}&t=2025-05:2026-04&f=origin_state:2T%20%281%29&n=25`);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });
});
