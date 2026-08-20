import { describe, expect, it, vi } from "vitest";

// Partial mock: wraps the REAL loadAllowlist/runPivot so every test except the ones that opt
// in via `mockRejectedValueOnce` still exercises the real DuckDB catalog read, matching the
// rest of this codebase's real-database integration-test style (db.test.ts has no mocks at
// all). `runPivot` is also wrapped (Important 4, final whole-branch review) so a test can
// simulate a PivotError surfacing from INSIDE runPivot() specifically -- distinct from
// decode()'s own guard, which converts the same error class before this handler ever sees it
// for any input decode() itself can validate.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    loadAllowlist: vi.fn(actual.loadAllowlist),
    runPivot: vi.fn(actual.runPivot),
  };
});

import { GET } from "@/app/api/pivot/route";
import { loadAllowlist, runPivot } from "@/lib/db";
import { PivotError } from "@/lib/pivot/types";

const OK = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=5&g=op";

/** In production the raw query reaches this handler as a header set by proxy.ts, never from
 * request.url -- Next normalizes that, form-encoding the format's structural delimiters. The
 * URL here is only for realism; the header is what the handler reads. */
function req(rawQuery: string): Request {
  return new Request(`http://localhost/api/pivot?${rawQuery}`, {
    headers: { "x-upgauge-raw-query": rawQuery },
  });
}

describe("GET /api/pivot", () => {
  it("returns rows and the canonical permalink for a valid query", async () => {
    const res = await GET(req(OK));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.url).toBe(OK);
    // Task 7 renamed this field -- pinned here so a route.ts that reverted to the brief's
    // stale `quarantinedRows` name would fail loudly instead of just shipping `undefined`.
    expect(typeof body.quarantinedRowsOnPage).toBe("number");
  });

  it("does not emit an empty resolved object in the JSON body", async () => {
    const res = await GET(req(OK));
    const body = await res.json();
    expect(body.resolved).toBeUndefined();
    expect(body.rows.length).toBeGreaterThan(0);
  });

  it("sets the caching header on success", async () => {
    const res = await GET(req(OK));
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=2592000, stale-while-revalidate=86400",
    );
  });

  it("rejects an off-allowlist dimension with 400 and a message, never a default", async () => {
    const res = await GET(
      req("v=1&k=seg&d=nope&m=seats&t=2025-05:2026-04&n=5&g=op"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown dimension/i);
  });

  it("rejects a non-numeric composite filter value with 400, not 500", async () => {
    // End-to-end regression: a malformed composite filter must never 500. As of the render.ts
    // fix (Important 4) this specific input is actually caught one level up, by decode()'s
    // own renderPivot-based validation (which now also rejects non-numeric ids) -- so this
    // proves the OUTCOME (400, named message, no leak) without pinning which of the two guard
    // layers below is responsible. Fails if the composite-value digit check in render.ts
    // regresses to accept non-numeric ids again.
    const res = await GET(
      req("v=1&k=route&d=route&m=seats&t=2025-05:2026-04&f=route:JFK-LAX&n=5&g=op"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/two ids joined by/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("treats a PivotError thrown from inside runPivot() the same as a UrlStateError", async () => {
    // The specific gap Important 4 (final whole-branch review) named: PivotError does not
    // extend UrlStateError, and until this fix, decode()'s own guard was the ONLY thing
    // standing between a PivotError and an unhandled 500 -- anything that made it past
    // decode() (a TOCTOU catalog change between decode()'s loadAllowlist() call and
    // runPivot()'s own internal one, or any future PivotError source not ALSO checked by
    // decode()'s validation pass) would 500 as an opaque "internal error". Bypasses decode()
    // entirely by making the (separately mocked) runPivot() throw directly, so this fails if
    // the `e instanceof PivotError` branch in route.ts's catch is ever removed, independent
    // of whatever decode() itself does or doesn't catch.
    vi.mocked(runPivot).mockRejectedValueOnce(
      new PivotError("unknown dimension 'simulated-catalog-race'"),
    );
    const res = await GET(req(OK));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unknown dimension 'simulated-catalog-race'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not cache an error response", async () => {
    const res = await GET(req("v=1&bogus=1"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // Whole-branch review, Finding 2. lib/canonicalQuery.ts declared this path exempt because the
  // handler already answers 400 + no-store to an unknown KEY -- which says nothing about the
  // keyless axis: urlstate.ts's splitPairs does `if (!chunk) continue`, so every one of
  // `?<valid>&`, `&&`, `&&&`... decoded cleanly and came back 200 under
  // `public, s-maxage=2592000` -- an unbounded, attacker-chosen family of 30-day CDN entries,
  // each a full pivot render, ten times the TTL of any HTML page the proxy's gate protects.
  // Deliberate behaviour change on a public endpoint: these were 200, they are now 400.
  it("rejects a trailing '&' with 400 + no-store rather than serving a 30-day-cached 200", async () => {
    const res = await GET(req(`${OK}&`));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error).toMatch(/non-canonical query/);
  });

  it("rejects an empty chunk in the middle of an otherwise valid query", async () => {
    // `&&` carries no key for decode() to object to, and is a distinct CDN cache key regardless.
    const res = await GET(req("v=1&&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("names the canonical spelling in the 400, so a client can fix the request", async () => {
    const res = await GET(req(`${OK}&&`));
    expect((await res.json()).error).toContain(`/api/pivot?${OK}`);
  });

  // The control the three tests above need, and the reason this endpoint's `keys` had to stop
  // being NO_KEYS: a gate that called everything non-canonical would pass every one of them
  // while 400ing every real query in the product. Two filters, because `f` is the one repeatable
  // key and a blanket duplicate rule breaks exactly the multi-filter permalink this API exists
  // to serve.
  it("still answers a two-filter permalink 200, under the project cache header", async () => {
    const two =
      "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&f=origin_state:OR&f=dest_state:WA&n=5&g=op";
    const res = await GET(req(two));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=2592000, stale-while-revalidate=86400",
    );
  });

  it("turns an unexpected (non-UrlStateError) failure into an uncached 500 with no leaked detail", async () => {
    // Simulates a failure deeper than decode()'s own validation -- e.g. a transient catalog
    // read problem -- surfacing as a plain Error rather than a UrlStateError. The handler
    // must not rethrow it (a raw Next.js error page can leak a stack trace and real
    // filesystem paths), must not fall back to a 200, and must not let a CDN cache the 500.
    vi.mocked(loadAllowlist).mockRejectedValueOnce(
      new Error("duckdb: IO Error: /home/ci/secret/upgauge.duckdb not found"),
    );
    const res = await GET(req(OK));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal error");
    expect(JSON.stringify(body)).not.toMatch(/duckdb|secret|\.duckdb|IO Error/i);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// Whole-branch review follow-up: `new URL(request.url).search` is NOT raw. Next normalizes
// the request URL by round-tripping the query through form-encoding, which turns the format's
// structural `:` into `%3A` and -- worse -- collapses `k:a%2Cb,c` into `k%3Aa%2Cb%2Cc`, making
// a data comma indistinguishable from a separator. Measured against a running production
// server: EVERY filtered query returned `malformed filter 'origin_state%3AOR'`, including
// ones with no reserved characters at all. proxy.ts (with skipProxyUrlNormalize) supplies the
// untouched string, exactly as it does for /explore, so both entry points now agree.
describe("GET /api/pivot raw query fidelity", () => {
  const RESERVED = "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&f=origin_state:14%2C771,13%26487&n=5&g=op";

  it("reads the raw query from the proxy header, not the normalized request URL", async () => {
    // The URL carries the NORMALIZED form Next would hand a route handler; the header carries
    // what the client actually sent. Only the header can parse, so a handler still reading
    // request.url fails this.
    const res = await GET(
      new Request(`http://localhost/api/pivot?v=1&k=seg&d=op_airline_id&m=seats&t=2015-01%3A2015-12&f=origin_state%3AOR&n=5&g=op`, {
        headers: { "x-upgauge-raw-query": "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&f=origin_state:OR&n=5&g=op" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("keeps a filter value's encoded comma as one value", async () => {
    const res = await GET(
      new Request("http://localhost/api/pivot?ignored=1", { headers: { "x-upgauge-raw-query": RESERVED } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Round-trips back out re-encoded: proof it stayed "14,771" rather than becoming 14 and 771.
    expect(body.url).toContain("origin_state:14%2C771,13%26487");
  });

  it("returns a generic 500, not an uncaught throw, when proxy.ts did not run", async () => {
    // A misconfigured deploy must not escape the catch-all: an uncaught MissingRawQueryError
    // would surface a Next stack trace carrying QUERIES_DIR and DB_PATH to the client.
    const res = await GET(new Request("http://localhost/api/pivot?v=1&k=seg"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal error");
    expect(JSON.stringify(body)).not.toMatch(/x-upgauge-raw-query|proxy\.ts|\/home\//);
  });
});

// #52. The value axis, on the path whose SUCCESSES carry the 30-day `PROJECT_CACHE` -- ten
// times any HTML page here. `/api/pivot` reads the same grammar as `/explore` (its
// `QUERY_ROWS` row declares `keys: ALLOWED_KEYS`, "the SAME keys as /explore, and for the same
// reason"), so leaving it out of the bound would have left the LONGER-lived unbounded family
// outside the fix -- the `exempt`-means-the-rules-are-off misreading that already left the
// `&&` axis a 30-day-cached 200 on this exact path.
describe("GET /api/pivot value bounds (#52)", () => {
  const BASE = "v=1&k=seg&d=op_airline_id&m=seats&s=-seats&g=op";

  it("400s a time range outside the dataset window, uncached", async () => {
    const res = await GET(req(`${BASE}&t=1999-01:1999-12&n=5`));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error).toMatch(/time range/i);
  });

  it("400s a reversed time range whose months are both in window", async () => {
    const res = await GET(req(`${BASE}&t=2026-04:2025-05&n=5`));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("400s a limit above the ceiling, uncached", async () => {
    const res = await GET(req(`${BASE}&t=2025-05:2026-04&n=999999`));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error).toMatch(/limit/i);
  });

  it("400s a redundantly-spelled n that decodes to a perfectly legal value", async () => {
    // n=0000005 IS 5. The value is in bounds; the SPELLING is one of unboundedly many, and
    // each one is a distinct 30-day CDN entry for an identical response body.
    const res = await GET(req(`${BASE}&t=2025-05:2026-04&n=0000005`));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 400, never a 307 -- a JSON endpoint must not redirect an XHR", async () => {
    const res = await GET(req(`${BASE}&t=1999-01:1999-12&n=5`));
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("still 200s the same query in bounds, under the project's 30-day header", async () => {
    // The control. Without it every assertion above is satisfied by a handler that 400s
    // everything, which is the vacuity this repo has been bitten by before.
    const res = await GET(req(`${BASE}&t=2025-05:2026-04&n=5`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=2592000, stale-while-revalidate=86400",
    );
    expect((await res.json()).rows.length).toBeGreaterThan(0);
  });
});
