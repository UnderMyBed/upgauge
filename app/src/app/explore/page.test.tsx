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

// Same partial-mock idiom, same reason: wraps the REAL exploreHref so every other test in this
// file still gets its real return value, but the empty-state "wider window" test below can see
// which arguments actually reached it -- the only way to tell "routed through the centralised
// helper" apart from "a second hand-spelled `/explore?${encode(...)}` that happens to produce the
// same string today", which is exactly the drift Finding 4 named.
vi.mock("@/lib/pivot/builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pivot/builder")>();
  return { ...actual, exploreHref: vi.fn(actual.exploreHref) };
});

import { ExploreView, FALLBACK_QUERY } from "@/app/explore/page";
import { dataAsOf, loadAllowlist, runPivot } from "@/lib/db";
import { resolveAirportCode } from "@/app/airport/[code]/resolveAirport";
import { trailing12From } from "@/lib/entityFacts";
import { exploreHref } from "@/lib/pivot/builder";
import { decodeRequest } from "@/lib/pivot/bounds";
import { encode } from "@/lib/pivot/urlstate";
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
    // Scoped to `thead`, not `screen.getByText("Seats")`: the builder's `m` row now renders a
    // chip carrying the same catalog label, so an unscoped lookup finds two nodes and throws.
    // The claim here is about the TABLE's header, so that is where it is asserted.
    const { container } = render(await ExploreView({ rawQuery: qs(OK) }));
    expect(container.querySelector("thead")?.textContent).toContain("Seats");
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
    // End-to-end regression: 'f=route:JFK-LAX' clears decode()'s structural check (two
    // non-empty dash-separated parts) and is rejected by renderPivot's per-part value rule.
    // Without that rule it reaches a bound param and fails deep inside runPivot() with a
    // PivotError this page did not catch -- an unhandled throw, not a rendered error page.
    // Proves the OUTCOME (a named error page, not a crash); the next test proves the SPECIFIC
    // guard this file added, independent of render.ts's own rule.
    //
    // The substring asserted here is the one app/smoke.sh needles on the served build, so this
    // is also the unit-level proof that the message survives the whole render path.
    const raw = "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&f=route:JFK-LAX&n=5&g=op";
    render(await ExploreView({ rawQuery: raw }));
    expect(screen.getByText(/must be a plain whole number/i)).toBeDefined();
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
  // (route_key_low == route_key_high) is real, filed traffic -- 532 distinct pairs, 12,995
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

// #52, the page-side half. proxy.ts has already independently answered `no-store` for each of
// these (proxy.test.ts's own block); this is what the reader actually gets, and it must be the
// named error with the real reason in it -- never a silent fallback to a default view, and
// never a full pivot render of a query the dataset cannot answer.
describe("/explore refuses a value outside what this dataset can answer", () => {
  const BASE = { v: "1", k: "seg", d: "op_airline_id", m: "seats", s: "-seats", g: "op" };
  const shown = () => screen.getByRole("alert").textContent ?? "";

  it("names the window when t falls outside it, rather than guessing", async () => {
    render(await ExploreView({ rawQuery: qs({ ...BASE, t: "1999-01:1999-12", n: "25" }) }));
    expect(screen.getByText(/can’t be read|can't be read/i)).toBeDefined();
    // The offending value AND the valid range, per docs/design/system.md's invalid-permalink
    // contract. A bare "invalid permalink" would pass a weaker assertion than this.
    expect(shown()).toMatch(/1999-01:1999-12/);
    expect(shown()).toMatch(/2015-01/);
  });

  it("names a reversed range for what it is", async () => {
    render(await ExploreView({ rawQuery: qs({ ...BASE, t: "2026-04:2025-05", n: "25" }) }));
    expect(shown()).toMatch(/start on or before it ends/i);
  });

  it("names the ceiling when n is above it", async () => {
    render(await ExploreView({ rawQuery: qs({ ...BASE, t: "2025-05:2026-04", n: "999999" }) }));
    expect(shown()).toMatch(/limit/i);
    expect(shown()).toMatch(/999999/);
  });

  it("refuses a redundantly-spelled n even though its value is legal", async () => {
    render(await ExploreView({ rawQuery: qs({ ...BASE, t: "2025-05:2026-04", n: "00000025" }) }));
    expect(shown()).toMatch(/decimal/i);
  });

  it("still renders the table when every value is in bounds", async () => {
    // The control. All four above are satisfied by a page that errors on everything.
    render(await ExploreView({ rawQuery: qs({ ...BASE, t: "2025-05:2026-04", n: "5" }) }));
    expect(screen.queryByText(/can’t be read|can't be read/i)).toBeNull();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------
// THE ONE SURFACE EXEMPT FROM THE FLOOR PARTITION (#127). Every other table sorts below-floor
// rows last; this page does not, because here the order is the visitor's own stated request
// (`s=` carries a key AND a direction, urlstate.ts:120, :223-225) rather than the product's
// editorial choice, and there is no rank column for "excluded from ranking" to bite on.
//
// ASSERTED AT THE CALL SITE, separately from DataTable's own `partition={false}` test. Without
// this, deleting `partition={false}` from page.tsx breaks nothing: the component test keeps
// passing because it passes the prop itself. Per CLAUDE.md, when several checks guard one
// property, assert WHICH check refuses the fixture -- this one refuses the call site.
describe("/explore renders the visitor's order, below-floor rows in place", () => {
  /** The rendered rows' below-floor flags, top to bottom. */
  function floorFlags(container: HTMLElement): boolean[] {
    const table = container.querySelector("table.data-table");
    if (table === null) throw new Error("expected a results table");
    return [...table.querySelectorAll("tbody tr")].map(
      (tr) => tr.getAttribute("data-below-floor") === "true",
    );
  }

  /** The same query /airport/STT offers as its own Explorer permalink (airport/page.tsx's
   * `endpointQuery`): one either-endpoint filter on STT, grouped by operating carrier, sorted
   * by seats descending. It reproduces that page's carrier table as an ordinary pivot -- which
   * is what makes it the fixture that distinguishes the two surfaces' orderings. The window and
   * the airport id are derived, never spelled: a BTS refresh moves `dataAsOf()` and a hardcoded
   * `t=` would rot into an empty result that passes vacuously. */
  async function sttQuery(): Promise<string> {
    const asOf = await dataAsOf();
    const r = await resolveAirportCode("STT");
    if (r.kind !== "ok") throw new Error("expected STT to resolve for this fixture");
    return qs({
      v: "1",
      k: "seg",
      d: "op_airline_id",
      m: "seats,departures_performed",
      t: `${trailing12From(asOf)}:${asOf}`,
      f: `endpoint_airport_id:${r.airport.id}`,
      s: "-seats",
      n: "50",
      g: "op",
    });
  }

  it("leaves a below-floor row where the sort put it, above a scored row", async () => {
    // MUTANT M10: ignore the prop, or delete `partition={false}` from the call site -> the
    // below-floor rows become a contiguous suffix and this goes red.
    //
    // THE DISCRIMINATOR IS THE INTERLEAVE, not the presence of a dashed row. On this fixture the
    // measure sort puts MQ (380 seats, 5 departures) above VD (115 seats, 120 departures), so a
    // scored row follows a below-floor one -- and that is the exact arrangement /airport/STT is
    // asserted NOT to render. Both tests read the same underlying rows; only the surface differs.
    const flags = floorFlags(render(await ExploreView({ rawQuery: await sttQuery() })).container);
    const firstBelow = flags.indexOf(true);
    expect(firstBelow).toBeGreaterThanOrEqual(0);
    expect(flags.slice(firstBelow).includes(false)).toBe(true);
  });
});

// =======================================================================================
// THE BUILDER, MOUNTED (epic #6, Task 6). Three states, and the two defects that live in the
// WIRING rather than in any of the seven controls: which state gets a builder at all, and where
// the filter chips' display values come from.
// =======================================================================================

/** The active-filter chip for a dimension, by its catalog label. `DimensionChips` renders a chip
 *  whose text is exactly "Carrier" and `FilterChips`'s add-half one reading "Carrier →", so the
 *  " = " is what identifies the filter chip among the three. */
function filterChip(container: HTMLElement, label: string): Element | undefined {
  return [...container.querySelectorAll(".builder .chip")].find((n) =>
    n.textContent?.startsWith(`${label} =`),
  );
}

describe("/explore mounts the builder on every state, not just the populated one", () => {
  it("renders it on a populated result, between the stat strip and the body", async () => {
    const { container } = render(await ExploreView({ rawQuery: qs(OK) }));
    const builder = container.querySelector(".builder");
    expect(builder).not.toBeNull();
    // Position, not mere presence: "assert the ordering, never the set of things present"
    // (CLAUDE.md). `compareDocumentPosition` & FOLLOWING === 4.
    const stats = container.querySelector(".stats")!;
    const body = container.querySelector(".body")!;
    expect(stats.compareDocumentPosition(builder!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4);
    expect(builder!.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4);
  });

  // THE VIEW THAT MOST NEEDS ADJUSTING MUST NOT BE THE ONE WITHOUT CONTROLS. An implementation
  // that renders the builder inside the populated branch passes the test above and fails here.
  it("renders it on the empty state, where adjusting the query is the whole job", async () => {
    const { container } = render(await ExploreView({ rawQuery: qs(NO_SUCH_CARRIER) }));
    expect(container.querySelector(".empty-state")).not.toBeNull();
    expect(container.querySelector(".builder")).not.toBeNull();
  });

  // THE STATE A "RENDER IT ABOVE THE TABLE" IMPLEMENTATION SILENTLY SKIPS: `decode()` threw, so
  // there is no `query` to mutate and no table to sit above. It is also the state a builder is
  // worth the most -- the reader is holding a permalink they cannot fix by hand.
  it("renders it on the error state, seeded from the query the escape link offers", async () => {
    const { container } = render(await ExploreView({ rawQuery: qs({ ...OK, d: "nope" }) }));
    expect(screen.getByText(/unknown dimension/i)).toBeDefined();
    expect(container.querySelector(".builder")).not.toBeNull();
    // One constant behind both, so the link and the chips beside it cannot describe different
    // queries. A mutant that re-spells either literal separates them and turns this red.
    const escape = container.querySelector(".error-page a")!;
    expect(escape.getAttribute("href")).toBe(exploreHref(FALLBACK_QUERY));
  });

  // The recovery query is spelled by hand as a bare href in six other files (`search/page.tsx`,
  // four `not-found.tsx`, `explore/filter/[dim]/page.tsx`). This pins the constant against that
  // exact string, so a codec change or an edit to FALLBACK_QUERY is red HERE rather than
  // discovered as a dead recovery link -- and it is the canary for those six copies too.
  it("encodes FALLBACK_QUERY to the string the rest of the app spells by hand", () => {
    expect(exploreHref(FALLBACK_QUERY)).toBe(
      "/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op",
    );
  });

  // `bounds.test.ts` scans every page for hardcoded `/explore?` literals and asserts the server
  // still ADMITS each one -- "a permalink this product has already shipped must not become
  // unreadable". Turning this one into a constant put it out of that scan's reach by
  // construction, so its coverage moves here rather than being lost: the recovery link offered
  // to someone whose permalink did not parse must itself parse.
  it("offers a recovery query the server actually admits", async () => {
    const allowlist = await loadAllowlist();
    expect(() => decodeRequest(encode(FALLBACK_QUERY), allowlist)).not.toThrow();
  });
});

// FINDING 4: `widerWindowHref` used to hand-spell `` `/explore?${encode(...)}` `` while the four
// entity pages centralised the identical link onto `exploreHref`. Byte-identical output today, so
// a string-equality check cannot tell the two apart -- only whether `exploreHref` itself was
// actually CALLED for this link can. The top-of-file mock wraps the real `exploreHref` in a spy
// without changing its behaviour (same idiom as the `runPivot` mock above), so this only adds
// visibility, and the fixture below is chosen so nothing ELSE this render produces (WindowControl's
// "Full window" preset and its 2015 year chip both also target `timeFrom: EARLIEST_MONTH`) can
// coincidentally satisfy the same predicate: `t=2020-01:2020-12` keeps `timeTo` away from both
// `asOf` (Full window's `to`) and "2015-12" (the 2015 year chip's `to`).
describe("/explore's empty-state 'wider window' link", () => {
  it("routes through exploreHref, not a second hand-spelled encode() call", async () => {
    const allowlist = await loadAllowlist();
    const raw = qs({ ...OK, f: "op_airline_id:999999999", t: "2020-01:2020-12" });
    const query = decodeRequest(raw, allowlist);

    vi.mocked(exploreHref).mockClear();
    const { container } = render(await ExploreView({ rawQuery: raw }));
    expect(container.querySelector(".empty-state")).not.toBeNull();
    const link = container.querySelector(".empty-state a")!;
    expect(link).not.toBeNull();

    // The exact call `widerWindowHref` must make: the same query, floored to EARLIEST_MONTH.
    // `encode`'s own hand-spelled form would never register here, since it bypasses this spy.
    const wideCall = vi.mocked(exploreHref).mock.calls.find(
      ([q]) =>
        q.timeFrom === "2015-01" &&
        q.timeTo === query.timeTo &&
        JSON.stringify(q.filters) === JSON.stringify(query.filters) &&
        JSON.stringify(q.dimensions) === JSON.stringify(query.dimensions) &&
        q.grouping === query.grouping,
    );
    expect(wideCall).toBeDefined();
    expect(link.getAttribute("href")).toBe(exploreHref(wideCall![0]));
  });
});

// `/explore/filter/:dim` shipped in Task 5 with NOTHING linking to it -- reachable only by typing
// the URL. CLAUDE.md: "A new top-level route is not shipped until something already-reachable
// links to it. Neither `sitemap.ts` nor `proxy.ts`'s matcher counts." `/watch` shipped that way
// one milestone after a review existed to prevent it, which is why this is a test and not a note.
describe("/explore is the inbound link that ends /explore/filter's island", () => {
  it("emits real anchors into the value-list route", async () => {
    const { container } = render(await ExploreView({ rawQuery: qs(OK) }));
    const links = [...container.querySelectorAll("a")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.startsWith("/explore/filter/"));
    expect(links.length).toBeGreaterThan(0);
    // Each carries the current query, so the list it opens is scoped to this window and these
    // filters -- a bare `/explore/filter/op_airline_id` would render, and rank against a query
    // nobody asked for. `Chip` renders href="" as a live empty anchor, so "an anchor exists" is
    // weaker than it looks (Chips.tsx).
    expect(links.every((h) => h.includes("?v=1&k=seg&"))).toBe(true);
    expect(links.some((h) => h.startsWith("/explore/filter/endpoint_airport_id?"))).toBe(true);
  });
});

// =======================================================================================
// THE SHELL RESOLVES ITS OWN FILTER VALUES. `runPivot` resolves only the ids present in the rows
// it RETURNED, and `FilterChips` is synchronous by design, so neither can reach this: the page
// has to ask. FilterChips.test.tsx pins the degraded half ("falls back to the raw id when the
// filtered dimension is not also grouped", measured there as `resolved.size === 0`); this is the
// other end of that same measurement, at the mount that closes it.
// =======================================================================================
describe("/explore resolves filter values the pivot's own rows never carry", () => {
  // THE ONLY SHAPE THAT DISCRIMINATES: filtered on `op_airline_id`, grouped by `year_month`. A
  // query that also GROUPS by the filtered dimension gets its ids resolved by `runPivot` for
  // free, so it passes with or without the merge and proves nothing.
  const GROUPED_ELSEWHERE =
    "v=1&k=seg&d=year_month&m=seats&t=2025-05:2026-04&f=op_airline_id:19790&s=-seats&n=25&g=op";

  it("shows a carrier filter as its code when the query groups by something else", async () => {
    const { container } = render(await ExploreView({ rawQuery: GROUPED_ELSEWHERE }));
    const chip = filterChip(container, "Carrier");
    expect(chip).toBeDefined();
    // MUTANT: pass `result.resolved` instead of the merged map -> "Carrier = 19790".
    expect(chip!.textContent).toContain("DL");
    expect(chip!.textContent).not.toContain("19790");
  });

  // The control that keeps the test above honest: the raw id is still in the permalink bar and
  // in the chip's own href, so a page-wide `not.toContain("19790")` would be asserting something
  // false. `f` targets the BTS id and must keep doing so -- `dim_carrier` carries the CURRENT
  // code (CLAUDE.md), so a code-valued filter would change meaning across a rebuild.
  it("keeps the raw id in the URL while showing the code", async () => {
    const { container } = render(await ExploreView({ rawQuery: GROUPED_ELSEWHERE }));
    expect(container.querySelector(".permalink code")!.textContent).toContain(
      "f=op_airline_id:19790",
    );
    expect(filterChip(container, "Carrier")!.getAttribute("href")).not.toContain("19790");
  });

  // The composite shape, resolved from a query that groups by neither half. `route`'s value is
  // '<low>-<high>' across two fact columns, so this is the case a single-column merge gets wrong
  // -- 12478-12892 is JFK-LAX.
  it("resolves a composite route filter into two codes", async () => {
    const raw =
      "v=1&k=route&d=year_month&m=seats&t=2025-05:2026-04&f=route:12478-12892&s=-seats&n=25&g=op";
    const { container } = render(await ExploreView({ rawQuery: raw }));
    const chip = filterChip(container, "Route");
    expect(chip!.textContent).toContain("JFK–LAX");
    expect(chip!.textContent).not.toContain("12478");
  });

  // THE FILTER EVERY ENTITY PAGE'S "Open in the Explorer" LINK ACTUALLY EMITS. `endpoint_airport_id`
  // is `either`-mode: ONE id that may sit in either of two fact columns, and it is `filter_only`,
  // so a query can never group by it -- which makes "filtered but not grouped" its PERMANENT state,
  // not an edge case. 12892 is LAX.
  it("resolves an either-end airport filter, which no query can ever group by", async () => {
    const raw =
      "v=1&k=seg&d=year_month&m=seats&t=2025-05:2026-04&f=endpoint_airport_id:12892&s=-seats&n=25&g=op";
    const { container } = render(await ExploreView({ rawQuery: raw }));
    const chip = filterChip(container, "Airport (either end)");
    expect(chip!.textContent).toContain("LAX");
    expect(chip!.textContent).not.toContain("12892");
  });

  // An id no dimension carries resolves to nothing, and the chip must then show the raw value --
  // never a dash. Absence of a NAME is not absence of DATA (lib/format.ts). This is also the
  // guard against a merge that throws or blanks on a miss.
  it("degrades a filter value that resolves to nothing to its raw id, not a dash", async () => {
    const { container } = render(await ExploreView({ rawQuery: qs(NO_SUCH_CARRIER) }));
    const chip = filterChip(container, "Carrier");
    expect(chip!.textContent).toContain("999999999");
    expect(chip!.textContent).not.toContain("—");
  });
});

// =======================================================================================
// D4, THE MAINLINE/OPERATING DISCLOSURE. Gated on BOTH operands. Keyed on the grouping alone it
// fires on every mainline view; keyed on the filter alone it fires on every carrier-filtered
// operating view. `cardSixthStat` shipped as the one-operand form, which is why CLAUDE.md carries
// the rule -- and why the negative case below is two fixtures, one per operand.
// =======================================================================================
describe("/explore discloses a mainline rollup filtered on the operating carrier", () => {
  const MAINLINE_FILTERED = qs({ ...OK, g: "ml", f: "op_airline_id:19790", n: "25" });
  const MAINLINE_UNFILTERED = qs({ ...OK, g: "ml", n: "25" });
  const OPERATING_FILTERED = qs({ ...OK, f: "op_airline_id:19790", n: "25" });

  it("says so when the rollup and the carrier filter are both active", async () => {
    const { container } = render(await ExploreView({ rawQuery: MAINLINE_FILTERED }));
    expect(container.querySelector(".foot")!.textContent).toContain(
      "rolled-up row can show more seats",
    );
  });

  it("says nothing about the rollup when only one of the two conditions holds", async () => {
    for (const raw of [MAINLINE_UNFILTERED, OPERATING_FILTERED]) {
      const { container } = render(await ExploreView({ rawQuery: raw }));
      expect(container.querySelector(".foot")!.textContent).not.toContain("rolled-up row");
    }
  });

  // Neither negative fixture may be vacuous: both must reach the `.foot` at all. A permalink that
  // errored would satisfy the `not.toContain` above without exercising the gate, which is the
  // half-disguised vacuous fixture CLAUDE.md names.
  it("both negative fixtures actually render a result foot", async () => {
    for (const raw of [MAINLINE_UNFILTERED, OPERATING_FILTERED]) {
      const { container } = render(await ExploreView({ rawQuery: raw }));
      expect(container.querySelector(".foot")!.textContent).toContain("quarantined row");
      expect(container.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
    }
  });
});
