// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Partial mock: wraps the REAL runPivot so every test except the one that opts in via
// `mockRejectedValueOnce` still exercises the real DuckDB catalog read (this codebase's
// integration-test style -- db.test.ts has no mocks at all). Exists to simulate a PivotError
// thrown from INSIDE runPivot() specifically (Important 4, final whole-branch review) --
// distinct from decode()'s own guard, which now also catches this for any input decode()
// itself can validate.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, runPivot: vi.fn(actual.runPivot) };
});

import { ExploreView } from "@/app/explore/page";
import { loadAllowlist, runPivot } from "@/lib/db";
import { PivotError } from "@/lib/pivot/types";

const OK = {
  v: "1",
  k: "seg",
  d: "op_airline_id",
  m: "seats",
  t: "2025-05:2026-04",
  s: "-seats",
  n: "5",
  g: "op",
};

// No real op_airline_id is anywhere near this value (BTS AIRLINE_IDs top out in the
// low-20000s over 2015-2026), so filtering on it is a valid query -- op_airline_id is a
// real, allowlisted dimension -- that genuinely matches zero rows, distinct from an invalid
// permalink.
const NO_SUCH_CARRIER = { ...OK, f: "op_airline_id:999999999" };

/** ExploreView takes the RAW query string, which is what a permalink actually is. None of
 * the values in these fixtures contain a character the format uses structurally, so a plain
 * join is an exact encoding of them -- the cases where that is NOT true are the point of the
 * second describe block below, and they are written as raw strings directly. */
function qs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

describe("/explore", () => {
  it("renders a table from a valid permalink", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText("Seats")).toBeDefined();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });

  it("shows DATA AS OF", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("shows the encoded permalink", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText(/\/explore\?v=1/)).toBeDefined();
  });

  it("shows the legend rail alongside a populated result", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText("Chart legend")).toBeDefined();
    expect(screen.getByText(/operating carrier is the grain/i)).toBeDefined();
  });

  it("names the offending key on an invalid permalink instead of falling back", async () => {
    render(await ExploreView({ rawQuery: qs({ ...OK, d: "nope" }) }));
    expect(screen.getByText(/unknown dimension/i)).toBeDefined();
    expect(screen.queryAllByRole("row").length).toBe(0);
  });

  it("names a non-numeric composite filter value rather than an unhandled server error", async () => {
    // End-to-end regression, Important 4 (final whole-branch review): before the render.ts
    // fix, 'f=route:JFK-LAX' passed decode()'s structural check (two non-empty dash-separated
    // parts) and only failed deep inside runPivot() with a PivotError this page did not catch
    // -- an unhandled throw, not a rendered error page. Verified against a running build
    // before this fix. Proves the OUTCOME (a named error page, not a crash); the next test
    // proves the SPECIFIC guard this file added, independent of render.ts's own fix.
    const raw = "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&f=route:JFK-LAX&n=5&g=op";
    render(await ExploreView({ rawQuery: raw }));
    expect(screen.getByText(/two ids joined by/i)).toBeDefined();
    expect(screen.queryAllByRole("row").length).toBe(0);
  });

  it("treats a PivotError thrown from inside runPivot() the same as an invalid permalink", async () => {
    // The specific gap: PivotError does not extend UrlStateError, and until this fix
    // decode()'s own guard was the ONLY thing standing between a PivotError and an unhandled
    // crash -- anything that made it past decode() (a TOCTOU catalog change between decode()'s
    // loadAllowlist() call and runPivot()'s own internal one, or any future PivotError source
    // decode()'s validation pass doesn't also check) would render Next's raw error boundary
    // instead of this page's own error UI. Bypasses decode() entirely by making the
    // (separately mocked) runPivot() throw directly, so this fails if the
    // `e instanceof PivotError` branch is ever removed, independent of what decode() itself
    // catches.
    vi.mocked(runPivot).mockRejectedValueOnce(
      new PivotError("unknown dimension 'simulated-catalog-race'"),
    );
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText(/simulated-catalog-race/)).toBeDefined();
    expect(screen.queryAllByRole("row").length).toBe(0);
  });

  it("states the query and offers a broader window for a valid query matching nothing", async () => {
    render(await ExploreView({ rawQuery: qs(NO_SUCH_CARRIER) }));
    // Empty is not an error: header, stat strip and legend rail all stay.
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
    expect(screen.getByText("Chart legend")).toBeDefined();
    // The query is stated in words, including the filter that produced the empty result.
    expect(screen.getByText(/no rows match/i)).toBeDefined();
    // Appears both in the stated-query message and the still-visible permalink bar.
    expect(screen.getAllByText(/999999999/).length).toBeGreaterThan(0);
    // A widened-window permalink is offered, never a blank panel.
    expect(screen.getByRole("link", { name: /same query over 2015-01/i })).toBeDefined();
    expect(screen.queryAllByRole("row").length).toBe(0);
  });
});

// Whole-branch review, CRITICAL 1: the page used to take Next's `searchParams` and rebuild a
// query string from it. Next percent-DECODES those before a page sees them -- parse-url.js
// builds `query` via searchParamsToUrlQuery(parsedURL.searchParams), i.e. URLSearchParams
// semantics -- so the rebuild re-emitted decoded values raw and splitPairs then re-split on
// delimiters no longer distinguishable from data. `/api/pivot` never had the bug because it
// reads the raw `new URL(request.url).search`.
//
// The fix is structural rather than defensive: ExploreView now takes the raw string as its
// only input, so there is no decoded object anywhere in the page for a future change to
// reconstruct from. proxy.ts supplies it. These cases would be unfixable under the old
// signature -- a `,` that was inside a value is, once decoded, indistinguishable from a `,`
// that separated two, so no amount of re-encoding could recover them.

// The values are the project's own pinned golden `filter_value_reserved_characters`
// (sql/03_queries/goldens/urlstate.json): every character the URL format uses structurally.
// docs/product/features.md:47 states the contract they encode.
//
// The golden puts them on `origin_airport_id`, which pins the CODEC round-trip only -- these
// tests execute a real query, and origin_airport_id is INT32, so DuckDB rejects '14,771' on
// type before fidelity can be observed. `origin_state` is the allowlisted segment-grain
// VARCHAR dimension, so the same values are type-valid there and simply match no rows --
// which is what puts them in the empty state's stated query, where they can be asserted on.
const RESERVED_RAW =
  "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12" +
  "&f=origin_state:14%2C771,13%26487,9%255,12%3A34,a%3Db,a%2Bb,a%20b" +
  "&n=100&g=op";

describe("/explore permalink fidelity across the Next request boundary", () => {
  it("preserves filter values containing the format's own delimiters", async () => {
    render(await ExploreView({ rawQuery: RESERVED_RAW }));

    // No real airport carries these IDs, so this is a valid query matching zero rows -- the
    // empty state states the query in words, which is where the filter values surface.
    expect(screen.queryByText(/can’t be read|can't be read/i)).toBeNull();
    expect(screen.getByText(/no rows match/i)).toBeDefined();

    // Each value must survive as ONE value. Re-splitting turned "14,771" into 14 and 771 --
    // a different query than the permalink encodes, rendered under a DATA AS OF badge.
    const stated = screen.getByText(/no rows match/i).textContent ?? "";
    for (const value of ["14,771", "13&487", "9%5", "12:34", "a=b", "a+b", "a b"]) {
      expect(stated).toContain(value);
    }
  });

  it("does not silently re-split a single filter value on an encoded comma", async () => {
    const raw = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&f=origin_state:14%2C771&n=5&g=op";
    render(await ExploreView({ rawQuery: raw }));
    // The silent case: no error, just the wrong query. The permalink the page echoes back
    // must re-encode the comma, proving it stayed one value rather than becoming 14 and 771.
    expect(screen.getByText(/14%2C771/)).toBeDefined();
  });
});

describe("/explore displays codes, not ids", () => {
  // Fix round 1, Finding 2: `getAllByText(/^[A-Z0-9]{2}$/)` scanned the whole page, and
  // Wordmark's `<span className="mark">UP<span className="accent">GAUGE</span></span>` has
  // own-text exactly "UP" (Testing Library's getNodeText reads only a node's direct child
  // text, so the nested "GAUGE" span doesn't count) -- a two-character uppercase match on
  // every render, table or no table. Scoped to `tbody td.id` and pinned to the actual top
  // carrier by seats over this window (Southwest, WN -- confirmed against the real warehouse
  // query), this fails the moment DimensionCell renders `hit.name` instead of `hit.code`.
  it("renders the top carrier's code, not its name or the raw id, in the table body", async () => {
    const { container } = render(await ExploreView({ rawQuery: qs(OK) }));
    const idCells = Array.from(container.querySelectorAll("tbody td.id")).map(
      (c) => c.textContent,
    );
    expect(idCells).not.toContain("19790");
    expect(idCells[0]).toBe("WN");
  });

  it("renders a route as two codes joined by an en dash", async () => {
    const raw = "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&s=-seats&n=5&g=op";
    render(await ExploreView({ rawQuery: raw }));
    expect(screen.getAllByText(/^[A-Z]{3}–[A-Z]{3}$/).length).toBeGreaterThan(0);
    // "route_key_low" is what the header WOULD render (label fallback chain, lib/format.ts)
    // if the __route collapse regressed and the raw fact column leaked through as its own
    // header -- unlike "Route key low" (Title Case with a space), a string this codebase
    // cannot emit under any code path, which asserted absence of nothing.
    expect(screen.queryByText("route_key_low")).toBeNull();
  });
});

// Whole-branch review, Finding 2: page.tsx's ROUTE_COLUMNS used to hand-copy
// meta_pivot_dimensions' column_expr for `route` as a literal array. resolve.ts's
// columnsFor() correctly reads it from the live catalog; the two halves disagreed about
// where truth lives, and a renamed fact column would silently flip `hasRoute` false with no
// test going red. page.tsx now derives its route columns from the live allowlist the same
// way resolve.ts does -- which makes that derivation self-fulfilling unless something pins
// the catalog's own shape independently. This test is that pin: same shape as db.test.ts's
// "allowlist.fixture.ts stays in sync with the real catalog" (a hardcoded expectation
// checked against a live query), so a `column_expr` rename or reorder in
// meta_pivot_dimensions is caught here rather than discovered as a blank route column.
describe("route's column_expr stays in sync with the catalog", () => {
  it("matches meta_pivot_dimensions' declared route columns, in this order", async () => {
    const allowlist = await loadAllowlist();
    const expr = allowlist.dims.get("route")?.columnExpr;
    expect(expr?.split(",").map((c) => c.trim())).toEqual(["route_key_low", "route_key_high"]);
  });
});

// M5 "connect the graph", Step 1(c): the route cell's href must be the CODE-alphabetical
// pair, not the displayed (airport-id) order -- the milestone's sharpest trap, per the task
// brief. IFP (airport_id 10590) / IAH (airport_id 12266) is one of the 215 of 22,509 pairs
// (measured via the brief's own SQL, run against upgauge.duckdb) where the two orderings
// disagree: IFP's airport_id is lower, so route_key_low/route_key_high -- and therefore the
// DISPLAYED "IFP–IAH" -- carry it first, but "IAH" < "IFP" alphabetically, so the canonical
// /route/ URL is /route/IAH-IFP, the REVERSE of the displayed order. This pair only flew
// 2015-01..2016-04 (measured), hence the widened time window.
//
// A fixture built on JFK-LAX (12478/12892) cannot fail here: their airport-id order and code
// order agree, as they do for 22,294 of 22,509 pairs, so a buggy implementation that builds
// the href by splitting the DISPLAYED string would produce the identical, coincidentally
// correct answer. The second test below pins that explicitly -- it must stay green under a
// mutant that the first test catches, which is what proves the IFP-IAH fixture choice is
// load-bearing rather than incidental.
describe("/explore route cell links to the canonical, code-alphabetical /route/<pair>", () => {
  it("builds the href from the alphabetical code order, not the displayed airport-id order", async () => {
    const raw =
      "v=1&k=route&d=route&m=seats&t=2015-01:2016-12&f=route:10590-12266&s=-seats&n=5&g=op";
    const { container } = render(await ExploreView({ rawQuery: raw }));
    expect(screen.getByText("IFP–IAH")).toBeDefined();
    const link = container.querySelector('a[href="/route/IAH-IFP"]');
    expect(link?.textContent).toBe("IFP–IAH");
  });

  // Not a Step-1 property by itself -- included so the claim in the block comment above
  // ("mutant 1 stays green here") is something this suite can actually demonstrate, not just
  // assert in a report. Confirmed by hand against the mutant described in task-3-report.md.
  it("also links correctly on a pair whose orderings agree (JFK-LAX)", async () => {
    const raw =
      "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&f=route:12478-12892&s=-seats&n=5&g=op";
    const { container } = render(await ExploreView({ rawQuery: raw }));
    const link = container.querySelector('a[href="/route/JFK-LAX"]');
    expect(link?.textContent).toBe("JFK–LAX");
  });

  // Final whole-branch review, F1: a route-grain row where both halves are the SAME airport
  // (route_key_low == route_key_high) is real, filed traffic -- 530 distinct pairs, 12,738
  // fct_segment_month rows -- not a data error, but routePair.ts's resolveRoutePair() names
  // "'ORD' to itself is not a route between two airports" and 404s it (routePair.ts:33). A
  // routeHref that doesn't special-case a===b links straight into that 404. ORD (airport_id
  // 13930) carries 73,082 seats over this exact trailing-12 window (measured, rank 2,381 of
  // 10,888 route pairs), so this is not a synthetic filter -- it is a real row /explore would
  // otherwise render as a live link today.
  it("renders a same-airport route cell as plain text, never a link into a guaranteed 404", async () => {
    const raw =
      "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&f=route:13930-13930&s=-seats&n=5&g=op";
    const { container } = render(await ExploreView({ rawQuery: raw }));
    expect(screen.getByText("ORD–ORD")).toBeDefined();
    expect(container.querySelector('a[href="/route/ORD-ORD"]')).toBeNull();
    expect(container.querySelector("td.id a")).toBeNull();
  });
});
