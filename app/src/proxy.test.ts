import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";

const CACHE = "public, s-maxage=2592000, stale-while-revalidate=86400";

// These tests pin what proxy.ts controls: the header it sets and the value it copies. They
// CANNOT pin the thing that broke twice in production -- whether Next hands this function a
// normalized `request.url` -- because constructing a NextRequest here bypasses Next's own URL
// normalization entirely. That gap is why `make app-smoke` exists; see the Makefile.
describe("proxy", () => {
  it("copies the raw query string, percent-encoding intact", () => {
    const raw = "v=1&f=origin_state:14%2C771,13%26487&t=2015-01:2015-12";
    const res = proxy(new NextRequest(`http://localhost/explore?${raw}`));
    expect(getReqHeader(res)).toBe(raw);
  });

  it("sets an empty string, not nothing, for a query-less request", () => {
    const res = proxy(new NextRequest("http://localhost/explore"));
    expect(getReqHeader(res)).toBe("");
  });

  it("sets the project's Cache-Control on /explore", () => {
    const res = proxy(new NextRequest("http://localhost/explore?v=1"));
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
  });

  it("leaves /api/pivot's own Cache-Control alone", () => {
    // route.ts sets `no-store` on errors and the long cache on success; overriding here would
    // make every 400 publicly cacheable for a month.
    const res = proxy(new NextRequest("http://localhost/api/pivot?v=1"));
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

/** NextResponse.next({request:{headers}}) encodes the upstream request headers into the
 * response's own `x-middleware-request-*` set; this reads the value back out whichever
 * spelling this Next version uses. */
function getReqHeader(res: { headers: Headers }): string | null {
  return (
    res.headers.get(`x-middleware-request-${RAW_QUERY_HEADER}`) ?? res.headers.get(RAW_QUERY_HEADER)
  );
}
