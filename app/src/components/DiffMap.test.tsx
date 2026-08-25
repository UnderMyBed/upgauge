// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DiffMap } from "@/components/DiffMap";
import type { CarrierDiff, DiffCategory } from "@/lib/map/carrierDiff";
import type { SegmentDatum } from "@/lib/map/segmentMap";

/**
 * Fixtures are PRODUCER-SHAPED, which for this component is the whole ballgame.
 *
 * `fetchCarrierDiff` emits `rankedBy: row.gauge_fall` UNCONDITIONALLY (carrierDiff.ts:116), so
 * an added or dropped segment arrives carrying `rankedBy: null` -- the key PRESENT, the value
 * null. A fixture that omitted the key would make `"rankedBy" in seg` and
 * `seg.rankedBy !== undefined` both behave correctly here and both ship the bug, which is this
 * epic's signature failure: a fixture that cannot express the defect it is written to catch.
 * So `seg()` sets `rankedBy: null` by default, exactly as the producer does.
 */
const N = {
  ORD: { code: "ORD", lat: 41.98, lon: -87.9 },
  LAX: { code: "LAX", lat: 33.94, lon: -118.4 },
  SEA: { code: "SEA", lat: 47.45, lon: -122.31 },
  DFW: { code: "DFW", lat: 32.9, lon: -97.04 },
  JFK: { code: "JFK", lat: 40.64, lon: -73.78 },
  DEN: { code: "DEN", lat: 39.86, lon: -104.67 },
} as const;

function seg(
  from: keyof typeof N,
  to: keyof typeof N,
  over: Partial<SegmentDatum> = {},
): SegmentDatum {
  return {
    from: N[from],
    to: N[to],
    seats: 100_000,
    // Above DEPARTURE_FLOOR, so `strokeFor` scales width by seats rather than overriding it
    // with the fixed 1px dotted floor stroke. The width assertions below are unreachable
    // otherwise -- every arc would render "1.00" and the shared-ramp test could not fail.
    departures: 200,
    loadFactor: 0.85,
    rankedBy: null,
    ...over,
  };
}

const TRAILING = "2025-06 → 2026-05";
const PRIOR = "2024-06 → 2025-05";

function diff(
  category: DiffCategory,
  segments: SegmentDatum[],
  over: { window?: string; totalRoutes?: number; sameAirportSeats?: number } = {},
): CarrierDiff {
  const window = over.window ?? (category === "dropped" ? PRIOR : TRAILING);
  return {
    category,
    window,
    map: {
      segments,
      window,
      totalRoutes: over.totalRoutes ?? segments.length,
      // Carrier-wide by construction, so every panel carries 0 (carrierDiff.ts:263). The real
      // count reaches the page on CarrierDiffResult, and this component states it once.
      quarantinedRoutes: 0,
      sameAirportSeats: over.sameAirportSeats ?? 0,
    },
  };
}

const ADDED = diff("added", [seg("ORD", "LAX"), seg("SEA", "DFW", { seats: 250_000 })]);
const DROPPED = diff("dropped", [seg("JFK", "DEN")]);
const DOWNGAUGED = diff("downgauged", [
  seg("ORD", "DEN", { rankedBy: 12.5 }),
  seg("SEA", "JFK", { rankedBy: 3.25 }),
]);

const DIFFS = [ADDED, DROPPED, DOWNGAUGED];
// The producer returns DIFF_CATEGORIES order; this component must not TRUST that, because the
// order is the encoding and DIFF_CATEGORIES is its one owner.
const DIFFS_OUT_OF_ORDER = [DOWNGAUGED, ADDED, DROPPED];

function panels(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="diff-panel"]')];
}

function textOf(scope: HTMLElement, testid: string): string {
  const el = scope.querySelector(`[data-testid="${testid}"]`);
  if (el === null) throw new Error(`no [data-testid="${testid}"] in this scope`);
  return el.textContent ?? "";
}

/** Arc stroke widths IN DRAWN ORDER. Arcs are `<polyline>`, not `<path>` -- `<path>` in this
 *  SVG is the basemap coastline (`path[data-panel]`), which carries no `stroke-width`
 *  attribute at all (globals.css styles it). Reading `path[stroke-width]` matches nothing and
 *  every width assertion would compare undefined to undefined. */
function widthsIn(scope: HTMLElement): string[] {
  return [...scope.querySelectorAll("polyline[stroke-width]")].map(
    (p) => p.getAttribute("stroke-width") ?? "",
  );
}

function ariaLabelsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll("svg[role='img']")].map(
    (s) => s.getAttribute("aria-label") ?? "",
  );
}

describe("DiffMap", () => {
  it("renders the panels in added, dropped, downgauged order whatever order they arrive in", () => {
    // Catches: rendering `diffs` in arrival order instead of imposing DIFF_CATEGORIES. POSITION
    // is the category encoding (arcs.ts has already spent width, dash and dotted-muted), so a
    // reorder silently changes what the map means. A SET assertion passes under the bug; the
    // ordering is the property, so the ordering is what is asserted.
    const { container } = render(<DiffMap diffs={DIFFS_OUT_OF_ORDER} quarantinedRoutes={0} carrier="AS" />);
    const labels = panels(container).map((p) => textOf(p, "diff-panel-label"));
    // Sentence case in the DOM, uppercased by CSS (`.dp-label`) -- see the component. The
    // property under test is the ORDER, which is unaffected by which layer does the casing.
    expect(labels).toEqual(["Added", "Dropped", "Downgauged"]);
  });

  it("labels a lone panel by ITS category, never by its position in the layout", () => {
    // Catches: labelling by index into DIFF_CATEGORIES instead of by each panel's own
    // `category`. On a carrier with all three, index and category AGREE, so the ordering test
    // above passes under this bug. ZW (Air Wisconsin) is the live shape -- 92 dropped, 0 added,
    // 0 downgauged -- and 26 of the 66 carriers with any change have at least one empty category.
    const { container } = render(<DiffMap diffs={[DROPPED]} quarantinedRoutes={0} carrier="ZW" />);
    expect(panels(container).map((p) => textOf(p, "diff-panel-label"))).toEqual(["Dropped"]);
    expect(ariaLabelsIn(container)[0]).toContain("ZW dropped.");
  });

  it("gives the three panels DISTINCT accessible names", () => {
    // Catches: shipping `panel.map` with no `title`, which is what fetchCarrierDiff did before
    // this unit. renderSegmentMap's aria-label is `Route map, <window>.` without one, and added
    // and downgauged SHARE the trailing window (map_carrier_diff.sql) -- so two of the three
    // maps announce themselves identically and the only thing separating them is position,
    // which is already carrying the category. Counting three panels passes under that defect.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    const labels = ariaLabelsIn(container);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(3);
  });

  it("names the carrier in each panel's accessible name, not only in the heading", () => {
    // arcsSentence emits "N routes drawn", uncarrier-qualified shared copy this unit must not
    // fork. A screen-reader user reaching role="img" by graphic navigation never sees the
    // section heading, so without the carrier in `title` the map's accessible name is a count
    // claim that does not name the carrier -- mart_route_health's grain rule, at the a11y layer.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    expect(ariaLabelsIn(container)).toEqual([
      expect.stringContaining("AS added."),
      expect.stringContaining("AS dropped."),
      expect.stringContaining("AS downgauged."),
    ]);
  });

  it("gives each panel its own window line, read off that panel's own row", () => {
    // Catches: one window line derived from `asOf` for all three. Added and downgauged carry the
    // TRAILING window and dropped the PRIOR one -- deriving instead of reading would make the
    // dropped panel's label disagree with its own data.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    const windows = panels(container).map((p) => textOf(p, "diff-panel-window"));
    expect(windows).toEqual([TRAILING, PRIOR, TRAILING]);
  });

  it("does not scale two panels against a shared maximum", () => {
    // Catches: one seat ramp across the small multiple. An added route's seats and a dropped
    // route's come from DIFFERENT WINDOWS -- two denominators -- so one width scale across both
    // looks comparable without being comparable.
    //
    // The fixture is built so the two readings DISAGREE on a specific arc: JFK-DEN carries
    // 100,000 seats and is the ONLY arc in the dropped panel, so its own panel max is 100,000
    // and it must render at the formula's ceiling, 0.7 + 2.9*sqrt(1) = 3.60. Under a shared max
    // of 250,000 (SEA-DFW, in the ADDED panel) the same arc renders 0.7 + 2.9*sqrt(0.4) = 2.53.
    // Asserting the VALUE, not merely that the two panels differ: equal-seat arcs happening to
    // differ is also true under several wrong implementations.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    const [added, dropped] = panels(container);
    // Added panel: 100,000 and 250,000 against its own max of 250,000, thinnest first.
    expect(widthsIn(added)).toEqual(["2.53", "3.60"]);
    // Dropped panel: 100,000 against its own max of 100,000.
    expect(widthsIn(dropped)).toEqual(["3.60"]);
  });

  it("names the carrier in each per-category count", () => {
    // Catches: a count sentence that says "225 route pairs" with no carrier.
    // mart_route_health's grain is (op_airline_id, route) -- a carrier-route pair, never a
    // route -- so a count that does not name the carrier is a claim the query never made.
    //
    // Asserted on the COUNT ELEMENT, not on container.textContent: the section heading already
    // says "What AS added, dropped and downgauged", so `textContent.toContain("AS")` is green
    // under the bug this test exists to catch.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    const counts = panels(container).map((p) => textOf(p, "diff-panel-count"));
    expect(counts[0]).toMatch(/^AS added 2 route pairs/);
    expect(counts[1]).toMatch(/^AS dropped 1 route pair/);
    expect(counts[2]).toMatch(/^AS downgauged 2 route pairs/);
  });

  it("counts the TRUE pre-cap total, not the drawn arcs", () => {
    // Catches: counting `segments.length`. The producer caps at NETWORK_ARC_CAP and returns the
    // pre-cap `category_total`, so on OO's added panel the honest count is 1,624 with 400 drawn.
    const capped = [diff("added", [seg("ORD", "LAX")], { totalRoutes: 1_624 })];
    const { container } = render(<DiffMap diffs={capped} quarantinedRoutes={0} carrier="OO" />);
    expect(textOf(panels(container)[0], "diff-panel-count")).toMatch(/^OO added 1,624 route pairs/);
  });

  it("states the carrier-wide quarantine count EXACTLY ONCE", () => {
    // Catches: putting the count on each panel. It is carrier-wide by construction -- a route
    // excluded because the window deciding it was wholly quarantined has no category at all --
    // so three panels state 8V's same 16 routes three times and a reader sums the small multiple
    // to 48. An occurrence COUNT, never a presence check: presence is green under that bug.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={16} carrier="8V" />);
    const hits = (container.textContent ?? "").match(/are on no panel above/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(textOf(container, "diff-quarantine")).toMatch(/^16 of 8V’s route pairs are on no panel above/);
  });

  it("gives the quarantine reason this query's exclusion actually has", () => {
    // Catches: reusing #105's sentence. segmentMap.ts's quarantinedNote says "not drawn -- failed
    // an invariant"; map_carrier_diff.sql measured that ZERO of these 25 have BOTH windows
    // quarantined and 7 performed real departures in the window that stayed clean. The property
    // they share is narrower: the window that DECIDES the category was wholly quarantined.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={16} carrier="8V" />);
    expect(textOf(container, "diff-quarantine")).toMatch(/window that decides the category was wholly quarantined/);
    expect(textOf(container, "diff-quarantine")).toMatch(/never clamped/);
  });

  it("discloses the quarantine count for a carrier with NO panels at all", () => {
    // Catches: gating the whole section on `panels.length > 0`. F4 (Air Flamenco, 21615) is
    // exactly this carrier and it is a live page: 3 undrawable carrier-routes and zero drawable
    // arcs. Gate the section on the panels and the count this field exists to surface is dropped
    // on the floor -- the "no trace that anything was there" the field exists to prevent.
    const { container } = render(<DiffMap diffs={[]} quarantinedRoutes={3} carrier="F4" />);
    expect(container.querySelector('[data-testid="diff-map"]')).not.toBeNull();
    expect(panels(container)).toHaveLength(0);
    expect(textOf(container, "diff-quarantine")).toMatch(/^3 of F4’s route pairs are on no panel above/);
  });

  it("renders nothing at all when there is no change and nothing withheld", () => {
    // A dormant carrier (VX, nothing in either window) gets no empty panel and no orphan
    // heading -- fetchAirportNetwork's "no panel rather than an empty panel" rule.
    const { container } = render(<DiffMap diffs={[]} quarantinedRoutes={0} carrier="VX" />);
    expect(container.querySelector('[data-testid="diff-map"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("says a dropped pair may still be flown by another carrier", () => {
    // map_carrier_diff.sql:111 -- 3,640 of 5,959 (61.1%) dropped carrier-routes had a DIFFERENT
    // carrier flying the pair inside the trailing window.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    expect(container.textContent).toMatch(/another carrier may still be flying it/i);
  });

  it("says added is re-entry rather than first appearance", () => {
    // map_carrier_diff.sql:97 -- 4,691 of 8,357 (56.1%) added carrier-routes had already filed
    // that pair BEFORE the prior window. This query has no lookback past p12.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    expect(container.textContent).toMatch(/re-entry, not first appearance/i);
  });

  it("never claims a route is new to the industry", () => {
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    expect(container.textContent).not.toMatch(/nobody flew/i);
    expect(container.textContent).not.toMatch(/first time/i);
    expect(container.textContent).not.toMatch(/new route/i);
  });

  it("names the downgauged panel's ranking key, on the panel that has one", () => {
    // map_carrier_diff.sql: "'400 of 584' alone reads as the largest 400 ROUTES, not the largest
    // 400 falls", and renderSegmentMap REFUSES to name a key it was not told -- so naming it is
    // this page's obligation and nowhere else's.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    const dg = panels(container)[2];
    expect(textOf(dg, "diff-panel-ranking")).toMatch(/fall in seats per departure/i);
  });

  it("does not claim the added or dropped panels are ranked on gauge fall", () => {
    // Catches the two natural misreadings of SegmentDatum.rankedBy: `"rankedBy" in seg` and
    // `seg.rankedBy !== undefined`. The producer emits `rankedBy: null` on added and dropped --
    // the key is PRESENT -- so both predicates conclude EVERY panel ranks on gauge fall and both
    // put this sentence on all three. The only correct predicate is `typeof x === "number"`.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    const [added, dropped] = panels(container);
    expect(added.querySelector('[data-testid="diff-panel-ranking"]')).toBeNull();
    expect(dropped.querySelector('[data-testid="diff-panel-ranking"]')).toBeNull();
  });

  it("never calls the dropped panel's window the trailing one", () => {
    // map_carrier_diff.sql, FOR #110: arcs.ts documents its 30-departure floor as
    // "trailing-window departures". On the DROPPED panel those departures are PRIOR-window ones,
    // so a panel-level caption saying "trailing" would be false on one panel in three.
    const { container } = render(<DiffMap diffs={DIFFS} quarantinedRoutes={0} carrier="AS" />);
    expect(panels(container)[1].textContent).not.toMatch(/trailing/i);
  });

  it("renders SegmentMap's own disclosure notes rather than a hand-rolled sentence", () => {
    // The copy has ONE owner: disclosureNotes(). A hand-rolled "N smaller routes are not drawn"
    // assumes one reason a route is undrawn; there are three, and only one of them is size.
    const capped = [diff("added", [seg("ORD", "LAX")], { totalRoutes: 1_624 })];
    const { container } = render(<DiffMap diffs={capped} quarantinedRoutes={0} carrier="OO" />);
    const notes = [...container.querySelectorAll('[data-testid="map-notes"] p')].map((p) => p.textContent);
    expect(notes).toContain("1 of 1,624 routes drawn.");
    expect(container.textContent).not.toMatch(/smaller/i);
  });
});
