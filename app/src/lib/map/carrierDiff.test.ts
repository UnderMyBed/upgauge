import { describe, expect, it } from "vitest";
import { DIFF_CATEGORIES, fetchCarrierDiff, type CarrierDiff } from "./carrierDiff";
import { DEPARTURE_FLOOR } from "./arcs";

// Live-database tests, not fixtures, for the reason lib/resolve.ts's header gives: this codebase
// has no mocks. Every figure below was measured directly against fct_route_month on the 2026-05
// warehouse -- the queries are in sql/03_queries/map_carrier_diff.sql's header.
const AS = 19930; // Alaska -- every panel under the cap, so cap behaviour cannot mask a bug
const OO = 20304; // SkyWest -- every panel OVER the cap
const MQ = 20398; // Envoy -- 317 added routes tied at exactly 76 seats across the 400th row
const WRIGHT = 20333; // 8V -- owns 16 of the 25 wholly-quarantined windows in this span
const ZW = 20046; // Air Wisconsin -- 92 dropped, 0 added, 0 downgauged
const VIRGIN_AMERICA = 21171; // dormant since 2018: nothing in either window
const AS_OF = "2026-05";

function panel(diffs: CarrierDiff[], category: string): CarrierDiff {
  const found = diffs.find((d) => d.category === category);
  if (found === undefined) throw new Error(`no ${category} panel`);
  return found;
}

function pairs(diff: CarrierDiff): string[] {
  return diff.map.segments.map((s) => `${s.from.code}-${s.to.code}`);
}

describe("DIFF_CATEGORIES", () => {
  it("is the panel order, and that order is the category encoding", () => {
    // Catches: a second copy of the order living in the page. arcs.ts has already spent width,
    // dash and dotted-muted, so POSITION is what encodes category -- reordering silently changes
    // what the map means.
    expect(DIFF_CATEGORIES).toEqual(["added", "dropped", "downgauged"]);
  });
});

describe("fetchCarrierDiff, against the warehouse", () => {
  it("returns the panels in DIFF_CATEGORIES order, not the query's collation order", async () => {
    // Catches: passing the query's rows straight through. map_carrier_diff.sql's ORDER BY is
    // `p.category`, which is ALPHABETICAL -- it emits added, downgauged, dropped, and measured,
    // that is exactly what AS comes back as before this module reorders. A set assertion cannot
    // fail here; the ORDERING is the property.
    const diffs = await fetchCarrierDiff(AS, AS_OF);
    expect(diffs.map((d) => d.category)).toEqual(["added", "dropped", "downgauged"]);
  });

  it("puts no carrier-route in two panels at once", async () => {
    // Catches: rebuilding the single CASE as three independent filters and dropping one arm's
    // exclusion clause -- e.g. `dropped` selecting on flew_p12 alone, which would put every
    // continuing downgauged route in the dropped panel too. AS is the subject because all three
    // of its panels sit under the cap, so a duplicate cannot be hidden by truncation.
    const diffs = await fetchCarrierDiff(AS, AS_OF);
    const all = diffs.flatMap(pairs);
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBe(all.length);
  });

  it("returns a NON-EMPTY dropped panel, which mart_route_health structurally cannot supply", async () => {
    // Catches: sourcing dropped from mart_route_health. That table filters
    // t12_departures_performed >= 30, and a route the carrier stopped flying has zero trailing
    // departures -- so the mart yields ZERO dropped rows and the panel would render empty.
    // The non-emptiness assertion is written FIRST and explicitly: a test whose only assertion
    // is a count would pass vacuously against an empty result, which is the failure this whole
    // task exists to avoid.
    const diffs = await fetchCarrierDiff(AS, AS_OF);
    const dropped = panel(diffs, "dropped");
    expect(dropped.map.segments.length).toBeGreaterThan(0);
    expect(dropped.map.segments).toHaveLength(138);
    expect(dropped.map.totalRoutes).toBe(138);
  });

  it("gives a dropped route its PRIOR-window seats and the prior window's label", async () => {
    // Catches: reading t12_seats for the dropped panel. AS DAL-SEA filed nothing at all in the
    // trailing window, so under that bug its seats are NULL and its window line names months in
    // which the carrier did not fly it. Measured: 108,110 seats over 619 performed departures in
    // 2024-06..2025-05.
    const dropped = panel(await fetchCarrierDiff(AS, AS_OF), "dropped");
    expect(dropped.window).toBe("2024-06 → 2025-05");
    expect(dropped.map.window).toBe("2024-06 → 2025-05");
    const top = dropped.map.segments[0];
    expect(`${top.from.code}-${top.to.code}`).toBe("DAL-SEA");
    expect(top.seats).toBe(108110);
    expect(top.departures).toBe(619);
  });

  it("gives added and downgauged the TRAILING window", async () => {
    // The other half of the same mutant: a single window applied to all three panels. Added and
    // dropped must differ, or the small multiple is three views of one window.
    const diffs = await fetchCarrierDiff(AS, AS_OF);
    expect(panel(diffs, "added").window).toBe("2025-06 → 2026-05");
    expect(panel(diffs, "downgauged").window).toBe("2025-06 → 2026-05");
    expect(panel(diffs, "added").window).not.toBe(panel(diffs, "dropped").window);
  });

  it("floors all three categories at ONE performed departure, not at the mart's 30", async () => {
    // Catches: flooring added at 30 (mart_route_health's floor) while dropped stays at 1 -- which
    // would floor two panels of one small multiple differently by a factor of 14 and make them
    // incomparable. Measured under the shared floor: AS is 225 added / 138 dropped / 128
    // downgauged; under a 30-floor on added alone it is 39.
    //
    // The sub-30 assertion is the second half and is not decoration: arcs.ts draws a
    // sub-30-departure arc dotted and muted, so if one panel were floored at 30 that "barely
    // flown" encoding would be reachable in the other panels only, and a VISUAL difference would
    // read as a DATA difference.
    const diffs = await fetchCarrierDiff(AS, AS_OF);
    expect(diffs.map((d) => d.map.segments.length)).toEqual([225, 138, 128]);
    for (const diff of diffs) {
      const departures = diff.map.segments.map((s) => s.departures);
      expect(Math.min(...departures)).toBe(1);
      expect(departures.some((d) => d < DEPARTURE_FLOOR)).toBe(true);
    }
  });

  it("reports the TRUE route count behind a capped panel, not the capped one", async () => {
    // Catches: totalRoutes = segments.length, which makes the disclosure line read "400 of 400"
    // and silently truncates. Measured: SkyWest added 1,624 carrier-routes in the trailing window
    // and the map draws the top 400 by seats.
    const added = panel(await fetchCarrierDiff(OO, AS_OF), "added");
    expect(added.map.drawnRoutes).toBe(400);
    expect(added.map.totalRoutes).toBe(1624);
    expect(added.map.segments).toHaveLength(400);
  });

  it("cuts a tied panel at a deterministic place", async () => {
    // Catches: dropping the (route_key_low, route_key_high) tiebreak from the ranking ORDER BY.
    // EVERY one of the 14 over-cap panels has a seats tie sitting on the cut; MQ added is the
    // worst, with 317 routes tied at exactly 76 seats spanning row 400. Without the tiebreak,
    // WHICH of those 317 are drawn is SQL-unspecified.
    //
    // This asserts the POSITION of the cut -- the identity of the last five drawn routes -- and
    // not the set, because at a 317-way tie the set of stroke widths is identical under either
    // ordering. Same shape as networkMap's draw-order test.
    const added = panel(await fetchCarrierDiff(MQ, AS_OF), "added");
    expect(added.map.totalRoutes).toBe(548);
    expect(pairs(added).slice(-5)).toEqual([
      "MEM-TPA",
      "MFR-PDX",
      "MHK-TUL",
      "MHT-STL",
      "MKE-ORF",
    ]);
    expect(added.map.segments.slice(-5).map((s) => s.seats)).toEqual([76, 76, 76, 76, 76]);
  });

  it("categorizes no carrier-route whose window is wholly quarantined", async () => {
    // Catches: coalesce(departures_performed, 0) in the floor. A route-month whose every row is
    // quarantined sums to NULL, meaning "nothing filed here can be trusted" -- NOT "flew
    // nothing". Under a coalesce, 8V BTI-VEE (trailing window wholly quarantined, prior window
    // real) becomes a fabricated DROPPED route, and 8V KAL-TAL (prior window wholly quarantined,
    // trailing window real) becomes a fabricated ADDED one.
    const diffs = await fetchCarrierDiff(WRIGHT, AS_OF);
    const all = diffs.flatMap(pairs);
    expect(all.length).toBeGreaterThan(0); // anti-vacuity: absence must not pass on an empty result
    expect(all).not.toContain("BTI-VEE");
    expect(all).not.toContain("KAL-TAL");
  });

  it("omits a category the carrier has nothing in, rather than returning an empty panel", async () => {
    // fetchAirportNetwork's rule -- no panel rather than an empty panel -- and it is live: 33 of
    // the 66 carriers with any change have at least one empty category. ZW dropped 92
    // carrier-routes and added none. A caller rendering a fixed three-panel layout must handle
    // this; that consequence belongs to #110.
    const diffs = await fetchCarrierDiff(ZW, AS_OF);
    expect(diffs.map((d) => d.category)).toEqual(["dropped"]);
    expect(diffs[0].map.segments).toHaveLength(92);
  });

  it("returns nothing at all for a carrier with no filings in either window", async () => {
    // Virgin America, dormant since 2018 -- the same fixture sitemap lastmod uses. No panel, no
    // empty panel, and no throw.
    expect(await fetchCarrierDiff(VIRGIN_AMERICA, AS_OF)).toEqual([]);
  });

  it("refuses an asOf the fact table does not agree with, naming both months", async () => {
    // The windows are derived inside the SQL from fct_route_month's own max(year_month). A caller
    // passing a different asOf would get a map whose window line disagrees with the page's DATA
    // AS OF badge -- the disagreement entityFacts.ts exists to make impossible. Fail loud.
    // Both months named, not just "mismatch": which one is wrong is the whole diagnostic.
    await expect(fetchCarrierDiff(AS, "2025-01")).rejects.toThrow("2025-01");
    await expect(fetchCarrierDiff(AS, "2025-01")).rejects.toThrow("2026-05");
  });

  it("carries a load factor computed as a ratio of sums, never averaged, and null when absent", async () => {
    // Every segment's loadFactor comes from SUM(passengers) / NULLIF(SUM(seats), 0) over the
    // panel's own window. Measured: AS HNL-ITO is 0.7824 over 480,681 seats.
    const added = panel(await fetchCarrierDiff(AS, AS_OF), "added");
    const top = added.map.segments[0];
    expect(`${top.from.code}-${top.to.code}`).toBe("HNL-ITO");
    expect(top.seats).toBe(480681);
    expect(top.loadFactor).toBeCloseTo(0.7824, 4);
    for (const s of added.map.segments) {
      expect(s.loadFactor === null || (s.loadFactor > 0 && s.loadFactor < 2)).toBe(true);
    }
  });
});
