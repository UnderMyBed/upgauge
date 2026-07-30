import { describe, expect, it, vi } from "vitest";

// Partial mock: wraps the REAL loadAllowlist so every test except the one that opts in via
// `mockRejectedValueOnce` still exercises the real DuckDB catalog read, matching the rest of
// this codebase's real-database integration-test style (db.test.ts has no mocks at all).
// Only `loadAllowlist` needs a hook -- it is the first thing GET() calls, so failing it is
// enough to reach the handler's catch-all branch without also needing to fail runPivot().
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, loadAllowlist: vi.fn(actual.loadAllowlist) };
});

import { GET } from "@/app/api/pivot/route";
import { loadAllowlist } from "@/lib/db";

const OK = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=5&g=op";

describe("GET /api/pivot", () => {
  it("returns rows and the canonical permalink for a valid query", async () => {
    const res = await GET(new Request(`http://localhost/api/pivot?${OK}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.url).toBe(OK);
    // Task 7 renamed this field -- pinned here so a route.ts that reverted to the brief's
    // stale `quarantinedRows` name would fail loudly instead of just shipping `undefined`.
    expect(typeof body.quarantinedRowsOnPage).toBe("number");
  });

  it("sets the caching header on success", async () => {
    const res = await GET(new Request(`http://localhost/api/pivot?${OK}`));
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=2592000, stale-while-revalidate=86400",
    );
  });

  it("rejects an off-allowlist dimension with 400 and a message, never a default", async () => {
    const res = await GET(
      new Request(
        "http://localhost/api/pivot?v=1&k=seg&d=nope&m=seats&t=2025-05:2026-04&n=5&g=op",
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown dimension/i);
  });

  it("does not cache an error response", async () => {
    const res = await GET(new Request("http://localhost/api/pivot?v=1&bogus=1"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("turns an unexpected (non-UrlStateError) failure into an uncached 500 with no leaked detail", async () => {
    // Simulates a failure deeper than decode()'s own validation -- e.g. a transient catalog
    // read problem -- surfacing as a plain Error rather than a UrlStateError. The handler
    // must not rethrow it (a raw Next.js error page can leak a stack trace and real
    // filesystem paths), must not fall back to a 200, and must not let a CDN cache the 500.
    vi.mocked(loadAllowlist).mockRejectedValueOnce(
      new Error("duckdb: IO Error: /home/ci/secret/upgauge.duckdb not found"),
    );
    const res = await GET(new Request(`http://localhost/api/pivot?${OK}`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal error");
    expect(JSON.stringify(body)).not.toMatch(/duckdb|secret|\.duckdb|IO Error/i);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
