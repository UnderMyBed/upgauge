import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { RAW_PATH_HEADER } from "@/lib/rawPath";

const CACHE = "public, s-maxage=2592000, stale-while-revalidate=86400";

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
    ["an aircraft slug whose name carries a '/'", "/aircraft/A321-LR"],
  ])("sets the project's Cache-Control on %s", async (_label, path) => {
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it.each([
    ["a lower-case airport code", "/airport/sea"],
    ["a lower-case carrier code", "/carrier/dl"],
    ["a lower-case aircraft slug", "/aircraft/a321-lr"],
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
});

/** NextResponse.next({request:{headers}}) encodes the upstream request headers into the
 * response's own `x-middleware-request-*` set; this reads the value back out whichever
 * spelling this Next version uses. */
function getReqHeader(res: { headers: Headers }, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`) ?? res.headers.get(name);
}
