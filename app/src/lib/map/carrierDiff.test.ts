import { describe, expect, it } from "vitest";
import {
  DIFF_CATEGORIES,
  fetchCarrierDiff,
  toPanels,
  type CarrierDiff,
  type DiffRow,
} from "./carrierDiff";
import { belowFloor } from "@/lib/floor";

// Live-database tests, not fixtures, for the reason lib/resolve.ts's header gives: this codebase
// has no mocks. Every figure below was measured directly against fct_route_month on the 2026-06
// warehouse; map_carrier_diff.sql's header states each population figure together with the exact
// predicate that produced it, which is what makes them re-derivable after a refresh.
const AS = 19930; // Alaska -- every panel under the cap, so cap behaviour cannot mask a bug
const OO = 20304; // SkyWest -- every panel OVER the cap
const WN = 19393; // Southwest -- 16 downgauged routes tied at its panel maximum fall of 38.0
const MQ = 20398; // Envoy -- 330 added routes tied at exactly 76 seats across the 400th row
const WRIGHT = 20333; // 8V -- owns 19 of the 27 wholly-quarantined windows in this span
const ZW = 20046; // Air Wisconsin -- 86 dropped, 0 added, 0 downgauged
const AIR_FLAMENCO = 21615; // F4 -- 3 wholly-quarantined-window routes and ZERO drawable arcs
const VIRGIN_AMERICA = 21171; // dormant since 2018: nothing in either window
const FOUR_W = 20323; // 4W -- downgauged panel UNDER the cap, and averaging moves it 2 -> 1
const AA = 19805; // American -- downgauged panel over the cap, and its first ten reorder if
                  // `gauge_fall` (the RANKING key) is averaged rather than a ratio of sums
const AS_OF = "2026-06";

function panel(panels: CarrierDiff[], category: string): CarrierDiff {
  const found = panels.find((d) => d.category === category);
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
    const diffs = (await fetchCarrierDiff(AS, AS_OF)).panels;
    expect(diffs.map((d) => d.category)).toEqual(["added", "dropped", "downgauged"]);
  });

  it("puts no carrier-route in two panels at once", async () => {
    // Catches: rebuilding the single CASE as three independent filters and dropping one arm's
    // exclusion clause -- e.g. `dropped` selecting on flew_p12 alone, which would put every
    // continuing downgauged route in the dropped panel too. AS is the subject because all three
    // of its panels sit under the cap, so a duplicate cannot be hidden by truncation.
    const diffs = (await fetchCarrierDiff(AS, AS_OF)).panels;
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
    const diffs = (await fetchCarrierDiff(AS, AS_OF)).panels;
    const dropped = panel(diffs, "dropped");
    expect(dropped.map.segments.length).toBeGreaterThan(0);
    expect(dropped.map.segments).toHaveLength(144);
    expect(dropped.map.totalRoutes).toBe(144);
  });

  it("gives a dropped route its PRIOR-window seats and the prior window's label", async () => {
    // Catches: reading t12_seats for the dropped panel. AS DAL-SEA filed nothing at all in the
    // trailing window, so under that bug its seats are NULL and its window line names months in
    // which the carrier did not fly it. Measured: 98,218 seats over 563 performed departures in
    // 2024-07..2025-06.
    const dropped = panel((await fetchCarrierDiff(AS, AS_OF)).panels, "dropped");
    expect(dropped.window).toBe("2024-07 → 2025-06");
    expect(dropped.map.window).toBe("2024-07 → 2025-06");
    const top = dropped.map.segments[0];
    expect(`${top.from.code}-${top.to.code}`).toBe("DAL-SEA");
    expect(top.seats).toBe(98218);
    expect(top.departures).toBe(563);
  });

  it("gives added and downgauged the TRAILING window", async () => {
    // The other half of the same mutant: a single window applied to all three panels. Added and
    // dropped must differ, or the small multiple is three views of one window.
    const diffs = (await fetchCarrierDiff(AS, AS_OF)).panels;
    expect(panel(diffs, "added").window).toBe("2025-07 → 2026-06");
    expect(panel(diffs, "downgauged").window).toBe("2025-07 → 2026-06");
    expect(panel(diffs, "added").window).not.toBe(panel(diffs, "dropped").window);
  });

  it("floors all three categories at ONE performed departure, not at the mart's 30", async () => {
    // Catches: flooring added at 30 (mart_route_health's floor) while dropped stays at 1 -- which
    // would floor two panels of one small multiple differently by a factor of 14 and make them
    // incomparable. Measured under the shared floor: AS is 212 added / 144 dropped / 139
    // downgauged; under a 30-floor on added alone it is 38.
    //
    // The below-floor assertion is the second half and is not decoration: arcs.ts draws a
    // below-floor arc dotted and muted, so if one panel were floored at 30 that "barely flown"
    // encoding would be reachable in the other panels only, and a VISUAL difference would read
    // as a DATA difference. It asks `belowFloor` (departures per month FLOWN, #134), not a raw
    // departure count, because that is the rule the arc is actually drawn by.
    const diffs = (await fetchCarrierDiff(AS, AS_OF)).panels;
    expect(diffs.map((d) => d.map.segments.length)).toEqual([212, 144, 139]);
    for (const diff of diffs) {
      const departures = diff.map.segments.map((s) => s.departures);
      expect(Math.min(...departures)).toBe(1);
      expect(diff.map.segments.some((x) => belowFloor(x.departures, x.activeMonths))).toBe(true);
    }
  });

  it("reports the TRUE route count behind a capped panel, not the capped one", async () => {
    // Catches: totalRoutes = segments.length, which makes the disclosure line read "400 of 400"
    // and silently truncates. Measured: SkyWest added 1,653 carrier-routes in the trailing window
    // and the map draws the top 400 by seats.
    const added = panel((await fetchCarrierDiff(OO, AS_OF)).panels, "added");
    expect(added.map.totalRoutes).toBe(1653);
    expect(added.map.segments).toHaveLength(400);
  });

  it("keeps the volume term OFF the added and dropped panels", async () => {
    // Catches: dropping the `category = 'downgauged'` guard on the volume term. Added and dropped
    // rank on seats alone, so a seats tie there must fall through to the airport-id tiebreak and
    // NOT be reordered by frequency.
    //
    // The obvious fixture does not work and the reason is worth knowing: every one of the eleven
    // added and dropped tie-at-cut blocks has a single distinct departure count -- MQ's 330 routes
    // tied at 76 seats all flew exactly 1 -- so an unscoped term cannot move any of their CUTS. It
    // moves panel INTERIORS. 8V's dropped panel ties ANV-KYU and KGX-NUL at 6 seats over 1 and 2
    // departures; ranked on seats then airport id, ANV-KYU (low id 10313) comes first, and only a
    // departures term reverses that.
    const dropped = panel((await fetchCarrierDiff(WRIGHT, AS_OF)).panels, "dropped");
    const codes = pairs(dropped);
    const anv = codes.indexOf("ANV-KYU");
    const kgx = codes.indexOf("KGX-NUL");
    expect(anv).toBeGreaterThanOrEqual(0);
    expect(kgx).toBeGreaterThanOrEqual(0);
    expect(anv).toBeLessThan(kgx);
    // ...and the two really are the tie this claims: same seats, and the FIRST one flew LESS.
    expect(dropped.map.segments[anv].seats).toBe(dropped.map.segments[kgx].seats);
    expect(dropped.map.segments[anv].departures).toBeLessThan(
      dropped.map.segments[kgx].departures,
    );
  });

  it("cuts a tied panel at a deterministic place", async () => {
    // Catches: dropping the (route_key_low, route_key_high) tiebreak from the ranking ORDER BY.
    // 12 of the 15 over-cap panels have a tie sitting on the cut, all 11 added and dropped ones
    // among them; MQ added is the worst, with 330 routes tied at exactly 76 seats spanning row
    // 400. Without the tiebreak, WHICH of those 330 are drawn is SQL-unspecified.
    //
    // This asserts the POSITION of the cut -- the identity of the last five drawn routes -- and
    // not the set, because at a 330-way tie the set of stroke widths is identical under either
    // ordering. Same shape as networkMap's draw-order test.
    const added = panel((await fetchCarrierDiff(MQ, AS_OF)).panels, "added");
    expect(added.map.totalRoutes).toBe(557);
    expect(pairs(added).slice(-5)).toEqual([
      "MDT-TVC",
      "MEM-TPA",
      "MFR-PDX",
      "MHK-TUL",
      "MKE-ORF",
    ]);
    expect(added.map.segments.slice(-5).map((s) => s.seats)).toEqual([76, 76, 76, 76, 76]);
  });

  it("categorizes no carrier-route whose window is wholly quarantined", async () => {
    // Catches: coalesce(departures_performed, 0) in the floor. A route-month whose every row is
    // quarantined sums to NULL, meaning "nothing filed here can be trusted" -- NOT "flew
    // nothing". Under a coalesce, 8V BTI-VEE (trailing window wholly quarantined, prior window
    // real) becomes a fabricated DROPPED route, and 8V CXF-RMP (prior window wholly quarantined,
    // trailing window real) becomes a fabricated ADDED one.
    //
    // ONE FIXTURE PER ARM of the three-valued floor, and a window move can flip which arm a pair
    // exercises while this test stays green: re-check both directions on every refresh, not just
    // that the pairs are still absent. CXF-RMP's only filings are a quarantined 2025-06 and a real
    // 2026-05, so it covers the prior arm through the 2027-04 build and no further; BTI-VEE's only
    // trailing-window filing is a quarantined 2026-03, which covers the trailing arm through the
    // 2027-02 build -- both unless 8V files the pair again.
    const diffs = (await fetchCarrierDiff(WRIGHT, AS_OF)).panels;
    const all = diffs.flatMap(pairs);
    expect(all.length).toBeGreaterThan(0); // anti-vacuity: absence must not pass on an empty result
    expect(all).not.toContain("BTI-VEE");
    expect(all).not.toContain("CXF-RMP");
  });

  it("omits a category the carrier has nothing in, rather than returning an empty panel", async () => {
    // fetchAirportNetwork's rule -- no panel rather than an empty panel -- and it is live: 24 of
    // the 66 carriers with any change have at least one empty category. ZW dropped 86
    // carrier-routes and added none. A caller rendering a fixed three-panel layout must handle
    // this; that consequence belongs to #110.
    const diffs = (await fetchCarrierDiff(ZW, AS_OF)).panels;
    expect(diffs.map((d) => d.category)).toEqual(["dropped"]);
    expect(diffs[0].map.segments).toHaveLength(86);
  });

  it("returns no panels, and an honest zero, for a carrier with no filings in either window", async () => {
    // Virgin America, dormant since 2018 -- the same fixture sitemap lastmod uses. No panel and
    // no empty panel, but still a record: the carrier-wide count is part of the answer even when
    // there is nothing to draw, which is why this is not an array.
    expect(await fetchCarrierDiff(VIRGIN_AMERICA, AS_OF)).toEqual({
      panels: [],
      quarantinedRoutes: 0,
    });
  });

  it("checks asOf even for a carrier with no drawable arc", async () => {
    // This asserts the OPPOSITE of what it did before the query grew its anchor row, and the
    // change is the point. The month was read off an arc row, so the guard silently did not run
    // for the 48 of 114 carrier codes that have no arc -- a caller asking for a window this query
    // does not serve was told `[]` rather than refused. The anchor row always exists, so the
    // guard always runs.
    await expect(fetchCarrierDiff(VIRGIN_AMERICA, "1999-01")).rejects.toThrow("1999-01");
  });

  it("refuses an asOf the fact table does not agree with, naming both months", async () => {
    // The windows are derived inside the SQL from fct_route_month's own max(year_month). A caller
    // passing a different asOf would get a map whose window line disagrees with the page's DATA
    // AS OF badge -- the disagreement entityFacts.ts exists to make impossible. Fail loud.
    // Both months named, not just "mismatch": which one is wrong is the whole diagnostic.
    await expect(fetchCarrierDiff(AS, "2025-01")).rejects.toThrow("2025-01");
    await expect(fetchCarrierDiff(AS, "2025-01")).rejects.toThrow("2026-06");
  });


  it("CUTS the downgauged panel by gauge fall, not by seats", async () => {
    // THE BUG THIS EXISTS FOR, and it is not the one the next test covers. The ranking key appears
    // in TWO independent clauses -- a QUALIFY deciding WHICH 400 survive and a final ORDER BY
    // deciding the order they arrive in -- and the round-1 defect was in the CUT. Reverting only
    // the QUALIFY reproduced it verbatim while every ordering assertion here still passed, because
    // AS's downgauged panel is under the cap and its order was unchanged. The query now computes
    // `rn` ONCE so the two cannot diverge; this test is what would catch the split coming back.
    //
    // So this asserts the cut, on a CAPPED panel, through quantities the payload actually emits.
    // Measured on OO's 570-route downgauged panel: 165 of the drawn 400 differ between the two
    // cuts, and each of these two numbers alone is a kill.
    const dg = panel((await fetchCarrierDiff(OO, AS_OF)).panels, "downgauged");
    expect(dg.map.segments).toHaveLength(400);
    // A fall-cut panel reaches down to 50-seat routes; a seats-cut one stops at 250.
    expect(Math.min(...dg.map.segments.map((s) => s.seats))).toBe(50);
    // ...and carries 258 below-floor arcs against a seats cut's 137. Both are consequences of
    // cutting on a key that is orthogonal to seats; neither is observable from row order.
    // Measured under the monthly floor (#134), not carried over from the raw one -- the same two
    // cuts read 233 and 88 against a raw twelve-month departure count of 30. Asserted through
    // `belowFloor`, not through `departures < 30`, so the figure is about what the map DRAWS:
    // the arc encoding does not compare a window sum against 30.
    expect(
      dg.map.segments.filter((s) => belowFloor(s.departures, s.activeMonths)),
    ).toHaveLength(258);
  });

  it("carries the ranked quantity on the segment, not only in the row order", async () => {
    // Without `rankedBy` nothing downstream holds a fall value: #110 cannot state the ranked
    // quantity in an aria-label, and the ordering is checkable only by inferring it from
    // position. It must also be monotone with the order it explains.
    const dg = panel((await fetchCarrierDiff(OO, AS_OF)).panels, "downgauged");
    const falls = dg.map.segments.map((s) => s.rankedBy);
    expect(falls[0]).toBeCloseTo(26.0, 6);
    expect(falls.every((f) => typeof f === "number")).toBe(true);
    for (let i = 1; i < falls.length; i++) {
      expect(falls[i]!).toBeLessThanOrEqual(falls[i - 1]!);
    }
    // Null on the panels that rank on a field the segment already carries.
    for (const cat of ["added", "dropped"] as const) {
      const other = panel((await fetchCarrierDiff(OO, AS_OF)).panels, cat);
      expect(other.map.segments.every((s) => s.rankedBy === null)).toBe(true);
    }
  });

  it("orders the downgauged panel by gauge fall, not by seats", async () => {
    // Catches: one shared ranking key across all three panels. For added and dropped, seats IS
    // the magnitude of the claim; for downgauged it is orthogonal to it. Measured on OO, whose
    // downgauged panel is cut: ranked by seats it DREW a median fall of 1.44 and CUT a median of
    // 7.92, discarding the largest fall in the set under a disclosure reading "400 of 570".
    //
    // AS's downgauged panel is under the cap, so nothing is cut and the ORDER is the observable
    // -- which is the point: the two keys disagree about the leader by a factor of ~6.5.
    const dg = panel((await fetchCarrierDiff(AS, AS_OF)).panels, "downgauged");
    expect(pairs(dg)[0]).toBe("KOA-OGG");
    const seatsLeader = [...dg.map.segments].sort((a, b) => b.seats - a.seats)[0];
    expect(`${seatsLeader.from.code}-${seatsLeader.to.code}`).toBe("SEA-SFO");
    expect(seatsLeader.seats).toBeGreaterThan(dg.map.segments[0].seats * 5);
  });

  it("decides downgauged on a ratio of sums, never an average of monthly ratios", async () => {
    // CLAUDE.md's #1 homemade-tool bug, and this query's ONE cross-window comparison of a derived
    // measure. Averaging the monthly seats/departures ratios instead yields 4,991 downgauged
    // carrier-routes against 4,994, and moves the count for 27 carriers.
    //
    // It MUST assert totalRoutes, not segments.length: OO's downgauged panel is over the cap, so
    // segments.length is 400 under BOTH forms and cannot tell them apart. Measured: 570 correct,
    // 577 averaged.
    const oo = panel((await fetchCarrierDiff(OO, AS_OF)).panels, "downgauged");
    expect(oo.map.totalRoutes).toBe(570);
    // 4W confirms it on an UNCAPPED panel, so the kill does not rest on a capped panel's
    // arithmetic: 2 correct, 1 averaged, and here segments.length moves too.
    const fourW = panel((await fetchCarrierDiff(FOUR_W, AS_OF)).panels, "downgauged");
    expect(fourW.map.totalRoutes).toBe(2);
    expect(fourW.map.segments).toHaveLength(2);
  });

  it("computes the downgauged RANKING key as a ratio of sums too, not just the category test", async () => {
    // `gauge_fall` has two consumers and they fail differently. The category CASE decides
    // MEMBERSHIP -- averaging there moves totalRoutes, which the test above catches. `gauge_fall`
    // decides the panel's RANKING, and averaging only THAT leaves every count in this file
    // identical while moving 30 routes into and out of AA's drawn 400 and reordering its first
    // ten. No count assertion anywhere can see it; only the ORDER can.
    const aa = panel((await fetchCarrierDiff(AA, AS_OF)).panels, "downgauged");
    expect(aa.map.totalRoutes).toBe(439);
    // AA's panel is CAPPED, so this order is a property of the cut as well as of the sort --
    // stated because the two clauses are separable and only naming both keeps that true.
    expect(aa.map.segments).toHaveLength(400);
    expect(pairs(aa).slice(0, 10)).toEqual([
      "MDT-SFO",
      "OMA-PHL",
      "ATL-TYS",
      "GSO-PHL",
      "ATL-JAX",
      "AVL-BNA",
      "BOS-STL",
      "CHS-TPA",
      "FLL-ILM",
      "MCO-MSY",
    ]);
  });

  it("breaks a tie at the panel maximum by departures, on the downgauged panel only", async () => {
    // 16 OO routes tie at the maximum fall of 26.0 and 16 WN routes at 38.0, so which arc a
    // reader sees first was decided ALPHABETICALLY. The volume term picks the most-flown of the
    // tied set instead: OO moves from ACV-FAT (1 performed departure) to ATW-SBN (4), WN from
    // ABQ-ORF (1) to JAN-MCI (2).
    //
    // The scoping is pinned by the next test, not by this one.
    const oo = panel((await fetchCarrierDiff(OO, AS_OF)).panels, "downgauged");
    expect(pairs(oo)[0]).toBe("ATW-SBN");
    expect(oo.map.segments[0].departures).toBe(4);
    const wn = panel((await fetchCarrierDiff(WN, AS_OF)).panels, "downgauged");
    expect(pairs(wn)[0]).toBe("JAN-MCI");
  });

  it("cuts each panel exactly where its own pre-cap total and the cap say it should", async () => {
    // `drawnRoutes` came OFF the interface in A6 -- the renderer derives the drawn count from
    // `drawableSegments`. The invariant is still asserted here, where both halves are knowable:
    // the SQL's `rn <= $cap` cut and the window function's pre-cap count must imply each other, or
    // the "N of M" disclosure rests on a cut nobody can reproduce. Kills mutant 12b, an
    // off-by-one between `<= $cap` and this arithmetic.
    const as = (await fetchCarrierDiff(AS, AS_OF)).panels;
    expect(as.map((d) => d.map.segments.length)).toEqual([212, 144, 139]);
    for (const d of as) expect(d.map.totalRoutes).toBe(d.map.segments.length);
    const oo = (await fetchCarrierDiff(OO, AS_OF)).panels;
    for (const d of oo) {
      expect(d.map.segments).toHaveLength(400);
      expect(d.map.totalRoutes).toBeGreaterThan(400);
    }
  });

  it("discloses the seats on same-airport pairs rather than losing them with the arcs", async () => {
    // A same-airport pair cannot be an arc, so it is out of `segments` and out of `totalRoutes`
    // -- but its seats must still reach the reader (segmentMap.ts owns that contract). Measured
    // for OO: 5,404 added, 5,201 dropped, 277,326 downgauged -- in DIFF_CATEGORIES order, which
    // is NOT the query's alphabetical one.
    const oo = (await fetchCarrierDiff(OO, AS_OF)).panels;
    expect(oo.map((d) => d.map.sameAirportSeats)).toEqual([5404, 5201, 277326]);
    // An explicit 0, never an omitted field, for a carrier that filed none -- the contract says
    // to say "none" out loud, because an omitted optional disclosure is the failure the field
    // exists to prevent. AS files no same-airport pair in any category.
    for (const d of (await fetchCarrierDiff(AS, AS_OF)).panels) {
      expect(d.map.sameAirportSeats).toBe(0);
    }
  });

  it("counts the routes no category could reach because a window was wholly quarantined", async () => {
    // Without this they vanish: not an arc, not in any total, no trace anything was there.
    // 8V owns 19 of the 27 such carrier-routes in the span -- BTI-VEE and CXF-RMP among them,
    // which the test above proves are in no panel.
    //
    // It is CARRIER-WIDE, so it belongs to the record and not to a panel. Stated on each panel
    // instead -- which is what an earlier revision did to satisfy SegmentMapInput's required
    // field -- 8V's three panels each said 16, the same 16, and a reader summing the small
    // multiple got 48. Each panel now says 0, which is true of it: no route OF THAT CATEGORY went
    // undrawn, because an undrawable route has no category at all.
    const wright = await fetchCarrierDiff(WRIGHT, AS_OF);
    expect(wright.quarantinedRoutes).toBe(19);
    expect(wright.panels).toHaveLength(3);
    for (const d of wright.panels) expect(d.map.quarantinedRoutes).toBe(0);

    const as = await fetchCarrierDiff(AS, AS_OF);
    expect(as.quarantinedRoutes).toBe(0);
  });

  it("still reports quarantined routes for a carrier that has no drawable arc at all", async () => {
    // THE CASE THE RECORD EXISTS FOR. F4 has 3 wholly-quarantined-window carrier-routes and zero
    // arcs, so while this function returned an array the count was lost on the floor -- the exact
    // "no trace" the field prevents -- and there was nothing for a page-level disclosure to be
    // built FROM, which meant deferring it foreclosed the remedy in the one case that needed it.
    const f4 = await fetchCarrierDiff(AIR_FLAMENCO, AS_OF);
    expect(f4.panels).toEqual([]);
    expect(f4.quarantinedRoutes).toBe(3);
  });

  it("carries a load factor computed as a ratio of sums, never averaged", async () => {
    // Every segment's loadFactor comes from SUM(passengers) / NULLIF(SUM(seats), 0) over the
    // panel's own window. Measured: AS HNL-ITO is 0.7875 over 574,499 seats.
    const added = panel((await fetchCarrierDiff(AS, AS_OF)).panels, "added");
    const top = added.map.segments[0];
    expect(`${top.from.code}-${top.to.code}`).toBe("HNL-ITO");
    expect(top.seats).toBe(574499);
    expect(top.loadFactor).toBeCloseTo(0.7875, 4);
    // NOT "and null when absent": no emitted arc can have a null load factor. The >= 1 floor
    // guarantees departures, and zero arcs have departures >= 1 with null-or-zero seats
    // (measured: 0, both windows), so the denominator is always positive. The nullable type is
    // the contract's, honoured here rather than exercised -- claiming coverage of it would be
    // claiming a branch this data cannot reach.
    for (const s of added.map.segments) {
      // `>= 0`, not `> 0`: 3,617 of the 19,383 categorized carrier-routes carry a load factor
      // of exactly 0 -- passengers 0 against real seats and real departures. AS's added panel
      // happens to have none, so `> 0` passed here while being false of the population.
      expect(s.loadFactor === null || (s.loadFactor >= 0 && s.loadFactor < 2)).toBe(true);
    }
  });
});

describe("toPanels tells an absent same-airport pair from an unstateable one", () => {
  /** One panel's worth of rows in the shape `map_carrier_diff.sql` returns. Only the three
   * fields this describe block is about are varied; the rest are the minimum a panel needs. */
  function headRow(over: Partial<DiffRow>): DiffRow[] {
    return [
      {
        category: "added",
        category_total: 1,
        window_start_month: "2025-06",
        window_end_month: "2026-05",
        undrawable_routes: 0,
        same_airport_pairs: null,
        same_airport_seats: null,
        from_code: "SEA",
        from_lat: 47.45,
        from_lon: -122.31,
        to_code: "PDX",
        to_lat: 45.58,
        to_lon: -122.59,
        seats: 100,
        departures: 2,
        load_factor: 0.5,
        gauge_fall: null,
        dataset_end_month: "2026-05",
        ...over,
      } as DiffRow,
    ];
  }

  // The LEFT JOIN missing: this category has no same-airport pair, so nothing is being withheld
  // and 0 is the honest answer. Unchanged behaviour, asserted so the fix below cannot regress it
  // into a false alarm on every panel that has none -- which is most of them.
  it("reports 0 when the category has no same-airport pair at all", () => {
    const [panel] = toPanels(headRow({ same_airport_pairs: null, same_airport_seats: null }));
    expect(panel.map.sameAirportSeats).toBe(0);
  });

  // THE MUTANT THIS EXISTS FOR: `head.same_airport_seats ?? 0`, which reads the two NULLs as one
  // and tells the reader nothing is withheld while a pair is. No carrier on this warehouse
  // produces this row (measured across all 115), which is exactly why it needs a constructed one.
  it("reports null when a pair exists whose seats cannot be summed", () => {
    const [panel] = toPanels(headRow({ same_airport_pairs: 1, same_airport_seats: null }));
    expect(panel.map.sameAirportSeats).toBeNull();
  });

  it("reports the figure when it can be stated", () => {
    const [panel] = toPanels(headRow({ same_airport_pairs: 2, same_airport_seats: 4321 }));
    expect(panel.map.sameAirportSeats).toBe(4321);
  });
});
