import { describe, expect, it, vi } from "vitest";

// Partial mock, same shape as app/api/pivot/route.test.ts and app/explore/page.test.tsx: wraps
// the REAL loadAllowlist so every test except the ones that opt in via `mockRejectedValueOnce`
// still exercises the real DuckDB catalog read. M5 Task 7 Part A's fail-safe test needs a way
// to make the proxy's own /explore probe throw without a mock; this codebase's own precedent
// for that (route.test.ts, page.test.tsx) is a partial mock, not a fake in-memory database.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, loadAllowlist: vi.fn(actual.loadAllowlist) };
});

import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { RAW_PATH_HEADER } from "@/lib/rawPath";
import { loadAllowlist } from "@/lib/db";

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
    const res = await proxy(new NextRequest("http://localhost/explore?v=1"));
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
    const res = await proxy(new NextRequest("http://localhost/explore?v=1"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // Not vacuous: the immediately-preceding test above (a real request against a healthy
  // database) proves the SAME code path returns CACHE when loadAllowlist() is not made to
  // fail, so the assertion above is actually discriminating on the probe's outcome rather than
  // the branch never being reachable at all.

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
  // characters with nothing else here only by luck of naming.
  it.each([
    ["/", null],
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
    // NextRequest here does not exercise Next's own normalization, but this pins that the
    // value read is whatever rawQuery carries, by using a key ordering searchParams would not
    // reorder differently -- a regression to `request.nextUrl.searchParams.get("y")` would
    // still pass this one, so app/smoke.sh is what actually proves the raw-header path (see
    // that file's /airport section).
    const res = await proxy(new NextRequest("http://localhost/airport/SEA?y=2020&other=1"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
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
});

/** NextResponse.next({request:{headers}}) encodes the upstream request headers into the
 * response's own `x-middleware-request-*` set; this reads the value back out whichever
 * spelling this Next version uses. */
function getReqHeader(res: { headers: Headers }, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`) ?? res.headers.get(name);
}
