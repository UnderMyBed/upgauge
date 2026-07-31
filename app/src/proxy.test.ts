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
