import { describe, expect, it } from "vitest";
import {
  NETWORK_ARC_CAP,
  NETWORK_FETCH_CEILING,
  carrierTypeNetworkQuery,
  drawableRoutes,
  fetchCarrierTypeNetwork,
  type CarrierTypeRouteRow,
} from "./carrierTypeNetwork";

// Measured fixtures. The window is FIXED, not derived from max(year_month), for the reason
// airportNetwork.test.ts:50-52 gives: a trailing window recomputed at test time moves under
// every BTS refresh, while a fixed one only rots when the dataset stops covering it.
const FROM = "2025-06";
const TO = "2026-05";

const DL = 19790;
const B8V = 20333;
const B8E = 20331;
const F4 = 21615;

// Type 614 is the BOEING 737-800 (dim_aircraft_type: short_name 'B737-8'), NOT an A321 -- the
// A321neo is 721. The neighbouring evidence agrees: a ~160-seat gauge on LAX-SFO is a 737-800,
// not a 191-seat A321. Naming the type correctly is what lets a future reader judge whether
// this fixture still exercises what it claims, and this repo has had a type renamed out from
// under an entire fixture set before.
//
// DL x 614: 519 drawable pairs over this window -- past the 400 cap, with a 164-way seats tie
// at exactly 160.0 seats ON the cut, and no quarantined or same-airport groups at all.
const TYPE_614 = "614";
const DL_614_TOTAL = 519;

describe("carrierTypeNetworkQuery", () => {
  it("pins the carrier and the type by filter and groups by the route dimension alone", () => {
    // Catches: grouping by op_airline_id/aircraft_type as DIMENSIONS (constant columns), or
    // dropping either filter -- a dropped aircraft_type filter draws the carrier's whole
    // network under a type's name.
    const q = carrierTypeNetworkQuery(DL, TYPE_614, FROM, TO, NETWORK_FETCH_CEILING);
    expect(q.filters).toEqual([
      ["op_airline_id", [String(DL)]],
      ["aircraft_type", [TYPE_614]],
    ]);
    expect(q.dimensions).toEqual(["route"]);
    expect(q.grain).toBe("segment");
    expect(q.grouping).toBe("operating");
  });

  it("requests seats and passengers separately, never a load_factor measure", () => {
    // The structural half of "derived measures are never averaged": the ratio is computed
    // from two summed additive measures, so there is no single column for anything downstream
    // to average.
    const q = carrierTypeNetworkQuery(DL, TYPE_614, FROM, TO, 10);
    expect(q.measures).toEqual(["seats", "passengers", "departures_performed"]);
    expect(q.sort).toBe("seats");
    expect(q.sortDesc).toBe(true);
  });

  it("keeps a zero-padded aircraft type a string", () => {
    // '079' int-parsed to 79 is a different, real aircraft type -- the join does not fail, it
    // silently answers about the wrong aircraft.
    const q = carrierTypeNetworkQuery(DL, "079", FROM, TO, 10);
    expect(q.filters[1]).toEqual(["aircraft_type", ["079"]]);
  });
});

function row(
  low: number,
  high: number,
  seats: number | null,
  passengers: number | null,
  departures: number | null,
): CarrierTypeRouteRow {
  return {
    route_key_low: low,
    route_key_high: high,
    seats,
    passengers,
    departures_performed: departures,
  };
}

describe("drawableRoutes", () => {
  it("ranks the SAME rows identically whatever order they arrive in", () => {
    // THE determinism test. Four pairs tied at 100 seats, mirroring the 164-way tie at DL x
    // 614's cut. Array.sort is STABLE, so a comparator that stops at `b.seats - a.seats`
    // returns a fixed answer for a FIXED input -- calling this twice with one input, or
    // calling fetchCarrierTypeNetwork twice, cannot see the bug at all. Permuting the input
    // is what makes a missing tiebreak observable.
    const tied = [
      row(1000, 2000, 100, 80, 5),
      row(1000, 1500, 100, 80, 5),
      row(900, 3000, 100, 80, 5),
      row(900, 1100, 100, 80, 5),
    ];
    const forward = drawableRoutes(tied, DL, TYPE_614).routes;
    const reversed = drawableRoutes([...tied].reverse(), DL, TYPE_614).routes;
    const shuffled = drawableRoutes([tied[2], tied[0], tied[3], tied[1]], DL, TYPE_614).routes;

    const key = (rs: typeof forward) => rs.map((r) => `${r.routeKeyLow}-${r.routeKeyHigh}`);
    // Assert the ORDERING itself, not that the same set came back -- the set is identical
    // under every permutation and under the buggy comparator too.
    expect(key(forward)).toEqual(["900-1100", "900-3000", "1000-1500", "1000-2000"]);
    expect(key(reversed)).toEqual(key(forward));
    expect(key(shuffled)).toEqual(key(forward));
  });

  it("sorts by seats first, and only then by route key", () => {
    // Anti-vacuity for the test above: a comparator that ignored seats entirely would also
    // make the three permutations agree.
    const routes = drawableRoutes(
      [row(100, 200, 10, 5, 1), row(900, 1000, 900, 500, 9), row(500, 600, 50, 25, 5)],
      DL,
      TYPE_614,
    ).routes;
    expect(routes.map((r) => r.seats)).toEqual([900, 50, 10]);
  });

  it("drops a pair that filed service it never flew, and keeps one that flew", () => {
    // The floor. `departures_performed > 0` on the GROUP sum -- the only filter in issue
    // #105's list that changes any result, since CLASS and AIRCRAFT_CONFIG are applied at
    // ingest (normalize_t100_segment.sql:71-72) and remove nothing here.
    //
    // Both dropped rows carry a REAL zero, never a null: a null departure sum is a quarantined
    // group, which this branch must not touch. An earlier fixture here mixed the two -- a row
    // with `seats: 0, departures: null` -- a state the shared quarantine FILTER cannot produce.
    const view = drawableRoutes(
      [row(100, 200, 0, 0, 0), row(300, 400, 900, 700, 0), row(500, 600, 50, 25, 5)],
      DL,
      TYPE_614,
    );
    expect(view.routes.map((r) => r.routeKeyLow)).toEqual([500]);
    expect(view.quarantinedRoutes).toBe(0);
  });

  it("sets same-airport seats aside rather than drawing or discarding them", () => {
    // A zero-length great circle cannot be an arc, but 598,829 seats sit on such rows across
    // the trailing 12 and silently dropping them would put the map's stated total out of step
    // with the page around it. Kept out of `routes` -- so out of totalRoutes -- and surfaced.
    const view = drawableRoutes(
      [row(700, 700, 3000, 2000, 20), row(500, 600, 50, 25, 5)],
      DL,
      TYPE_614,
    );
    expect(view.routes.map((r) => r.routeKeyLow)).toEqual([500]);
    expect(view.sameAirportSeats).toBe(3000);
  });

  it("applies the floor to same-airport rows too", () => {
    // THE FIXTURE CARRIES SEATS IT NEVER FLEW, and that is the whole point. An earlier version
    // used a 0-seat same-airport row, so `sameAirportSeats` was 0 under BOTH orderings and
    // hoisting the same-airport branch above the floor left every test green -- a fixture that
    // did not exercise the path it named. 3,000 seats on zero departures separates them.
    const view = drawableRoutes(
      [row(700, 700, 3000, 2000, 0), row(500, 600, 50, 25, 5)],
      DL,
      TYPE_614,
    );
    expect(view.sameAirportSeats).toBe(0);
    expect(view.routes.map((r) => r.routeKeyLow)).toEqual([500]);
  });

  it("counts a fully-quarantined group rather than letting it vanish", () => {
    // NULL is not zero. All three sums null means every filing was quarantined: untrustworthy,
    // not unflown. It must not be drawn (the sums are unknowable) and must not disappear.
    const view = drawableRoutes(
      [row(100, 200, null, null, null), row(500, 600, 50, 25, 5)],
      DL,
      TYPE_614,
    );
    expect(view.quarantinedRoutes).toBe(1);
    expect(view.routes.map((r) => r.routeKeyLow)).toEqual([500]);
  });

  it("separates a quarantined group from one that genuinely never flew", () => {
    // The two used to share a `departures <= 0` branch. They are different facts and land in
    // different places: NULL is counted and disclosed, 0 is dropped entirely.
    const view = drawableRoutes(
      [row(100, 200, null, null, null), row(300, 400, 0, 0, 0), row(500, 600, 50, 25, 5)],
      DL,
      TYPE_614,
    );
    expect(view.quarantinedRoutes).toBe(1);
    expect(view.routes).toHaveLength(1);
  });

  it("throws rather than silently reporting a truncated total", () => {
    // A result that reached the fetch ceiling may be a truncated view, and a "N of M" whose M
    // is itself truncated is worse than no disclosure. Driven with an injected ceiling because
    // the pinned fetchCarrierTypeNetwork signature has no slot for one.
    const rows = [row(1, 2, 10, 5, 1), row(3, 4, 10, 5, 1), row(5, 6, 10, 5, 1)];
    expect(() => drawableRoutes(rows, DL, TYPE_614, 3)).toThrow(/may be truncated/);
    expect(drawableRoutes(rows, DL, TYPE_614, 4).routes).toHaveLength(3);
  });

  it("throws when the three measure sums are only PARTIALLY null", () => {
    // The three measures share one quarantine FILTER, so they go null together. A group that
    // is null in one and not the others cannot arise from the catalog as it stands -- it is
    // what a FILTER dropped from one measure and not the others would produce, and it would
    // otherwise surface as a silently wrong seat figure. This is a claim about the CATALOG's
    // invariant, not about a row the warehouse can currently emit.
    expect(() => drawableRoutes([row(100, 200, null, null, 5)], DL, TYPE_614)).toThrow(
      /PARTIALLY null measure sum/,
    );
    // ...and the all-null case is NOT an error: it is the ordinary quarantined group.
    expect(drawableRoutes([row(100, 200, null, null, null)], DL, TYPE_614).quarantinedRoutes).toBe(1);
  });
});

// Live-database tests, not fixtures -- lib/resolve.ts's header rule: this codebase has no
// mocks. Every figure below was measured directly against fct_segment_month over
// 2025-06..2026-05; the queries are in the task report.
describe("fetchCarrierTypeNetwork, against the warehouse", () => {
  it("returns null when the carrier filed nothing on that type in the window", async () => {
    // A window before the dataset's own start (2015-01). Real carrier, real type, empty
    // window -- no fabricated id. Mirrors airportNetwork.test.ts:54-65.
    const result = await fetchCarrierTypeNetwork(DL, TYPE_614, "2014-01", "2014-01");
    expect(result).toBeNull();
  });

  it("drops a pair that was filed and genuinely not flown", async () => {
    // THE FIXTURE MOVED, and why matters. This test used to name F4 x 489, whose three groups
    // are `deps IS NULL` -- fully QUARANTINED, having performed 14, 11 and 2 departures. They
    // never reached the floor at all, so deleting the floor left this test green: a fixture
    // that did not exercise the path it named.
    //
    // DL x 622 is a genuine one. MSP-SLC filed 0 seats on 0 performed departures over the whole
    // window, one of 23 such groups. 336 grouped pairs, 335 drawable.
    const result = await fetchCarrierTypeNetwork(DL, "622", FROM, TO);
    expect(result!.totalRoutes).toBe(335);
    const codes = result!.segments.map((s) => `${s.from.code}-${s.to.code}`);
    expect(codes).not.toContain("MSP-SLC");
  });

  it("surfaces quarantined pairs in the denominator instead of dropping them", async () => {
    // 8V x 035: 33 grouped pairs -- 15 drawable, 14 fully quarantined, 1 same-airport carrying
    // 3 seats, 3 filed-and-never-flown. The carrier SERVED 29 of them, so a denominator of 15
    // describes a smaller network than the one on file and says nothing about the 14 whose
    // filings were all quarantined. Excluded from aggregates, surfaced with a count.
    const result = await fetchCarrierTypeNetwork(B8V, "035", FROM, TO);
    expect(result).not.toBeNull();
    expect(result!.segments).toHaveLength(15);
    expect(result!.quarantinedRoutes).toBe(14);
    expect(result!.totalRoutes).toBe(29);
    expect(result!.sameAirportSeats).toBe(3);
    for (const s of result!.segments) expect(s.from.code).not.toBe(s.to.code);
  });

  it("still renders a map when quarantine is the only thing standing in the way", async () => {
    // F4 x 489: three pairs, every filing on all three quarantined. Returning null hides a
    // data-quality fact behind a missing panel -- the reader is told nothing rather than told
    // the count. No arcs are drawn (the sums are unknowable) but the count reaches the page.
    const result = await fetchCarrierTypeNetwork(F4, "489", FROM, TO);
    expect(result).not.toBeNull();
    expect(result!.segments).toHaveLength(0);
    expect(result!.drawnRoutes).toBe(0);
    expect(result!.quarantinedRoutes).toBe(3);
    expect(result!.totalRoutes).toBe(3);
  });

  it("still renders a map for a view that is nothing but a same-airport filing", async () => {
    // 8E x 340 is one same-airport group carrying 5 seats and no route pairs at all. Gating on
    // "no drawable arcs" swallowed those seats entirely, contradicting segmentMap.ts's own
    // contract text; fetchAirportNetwork gates on `rows.length === 0`, which is a different
    // question.
    const result = await fetchCarrierTypeNetwork(B8E, "340", FROM, TO);
    expect(result).not.toBeNull();
    expect(result!.segments).toHaveLength(0);
    expect(result!.totalRoutes).toBe(0);
    expect(result!.sameAirportSeats).toBe(5);
  });

  it("reports the TRUE uncapped total beside the drawn count", async () => {
    // DL x 614 has 519 drawable pairs. Returning segments.length as the total makes the
    // disclosure read "400 of 400" and elides 119 routes without saying so.
    const result = await fetchCarrierTypeNetwork(DL, TYPE_614, FROM, TO);
    expect(result).not.toBeNull();
    expect(result!.totalRoutes).toBe(DL_614_TOTAL);
    expect(result!.drawnRoutes).toBe(NETWORK_ARC_CAP);
    expect(result!.segments).toHaveLength(NETWORK_ARC_CAP);
    expect(result!.drawnRoutes).toBe(result!.segments.length);
  });

  it("does not disclose a cap on a view that fits under it", async () => {
    // DL x 622 is 335 drawable with nothing quarantined, so drawn == total and #104's
    // disclosure line correctly renders nothing. 8V x 035 is deliberately NOT the fixture here:
    // its total legitimately exceeds its drawn count because 14 pairs are quarantined, which is
    // a disclosure about data quality rather than about the cap.
    const result = await fetchCarrierTypeNetwork(DL, "622", FROM, TO);
    expect(result!.quarantinedRoutes).toBe(0);
    expect(result!.drawnRoutes).toBe(result!.totalRoutes);
    expect(result!.drawnRoutes).toBe(result!.segments.length);
  });

  it("draws the largest routes BY SEATS, in seats order, not by departures", async () => {
    // ORDERING, not a set or a count: ranking on departures returns 400 rows too, and 400 of
    // them overlap heavily, so any set-shaped assertion passes under the bug. Measured on
    // DL x 614, 243 of the 519 pairs sit at a different rank under a departures sort.
    const result = await fetchCarrierTypeNetwork(DL, TYPE_614, FROM, TO);
    const seats = result!.segments.map((s) => s.seats);
    for (let i = 1; i < seats.length; i++) expect(seats[i]).toBeLessThanOrEqual(seats[i - 1]);

    // The named witness for that divergence. ATL-STL (187,649 seats) and ATL-MKE (187,631)
    // performed an IDENTICAL 1,173 departures, so a departures sort puts MKE first and a
    // seats sort puts STL first. Positions, not membership -- both are present either way.
    const codes = result!.segments.map((s) => `${s.from.code}-${s.to.code}`);
    // Membership FIRST. `indexOf` returns -1 for a missing element and -1 is less than every
    // real index, so a bare `toBeLessThan` would pass -- reporting nothing -- the moment either
    // pair fell out of the drawn set.
    expect(codes).toContain("ATL-STL");
    expect(codes).toContain("ATL-MKE");
    expect(codes.indexOf("ATL-STL")).toBeLessThan(codes.indexOf("ATL-MKE"));
  });

  it("computes each segment's load factor as a ratio of sums, never a mean of ratios", async () => {
    // ANC-SEA on DL x 614: SUM(passengers)/SUM(seats) = 0.7648575746, while the mean of its
    // twelve monthly load factors is 0.7324017696 -- 3.2 percentage points apart, far outside
    // any float tolerance. A tolerance-shaped assertion on a route whose gauge is steady all
    // year cannot tell the two apart; this one can.
    const result = await fetchCarrierTypeNetwork(DL, TYPE_614, FROM, TO);
    const ancSea = result!.segments.find(
      (s) => `${s.from.code}-${s.to.code}` === "ANC-SEA" || `${s.to.code}-${s.from.code}` === "ANC-SEA",
    );
    expect(ancSea).toBeDefined();
    expect(ancSea!.loadFactor).toBeCloseTo(0.7648575746, 8);
  });

  it("resolves BOTH endpoints' coordinates, not one end", async () => {
    // ArcDatum carried a single endpoint because the near end was always the hub. A segment
    // has no hub, so an unresolved second end would project every arc to [0, 0].
    const result = await fetchCarrierTypeNetwork(DL, TYPE_614, FROM, TO);
    const top = result!.segments[0];
    expect(top.from.code).toBe("LAX");
    expect(top.to.code).toBe("SFO");
    expect(top.from.lat).toBeCloseTo(33.94, 1);
    expect(top.to.lat).toBeCloseTo(37.62, 1);
    expect(top.seats).toBe(525495);
    expect(top.departures).toBe(3285);
  });

  it("states the window it was asked for", async () => {
    const result = await fetchCarrierTypeNetwork(DL, TYPE_614, FROM, TO);
    expect(result!.window).toBe("2025-06 → 2026-05");
  });

  it("refuses a non-positive cap rather than returning an empty panel", async () => {
    // Mirrors render.ts:141-143. A zero cap sliced to nothing and returned a map with no arcs
    // and a totalRoutes insisting the routes were there -- the empty panel this module refuses.
    await expect(fetchCarrierTypeNetwork(DL, TYPE_614, FROM, TO, 0)).rejects.toThrow(
      /limit must be a positive integer/,
    );
    await expect(fetchCarrierTypeNetwork(DL, TYPE_614, FROM, TO, -1)).rejects.toThrow(
      /limit must be a positive integer/,
    );
  });

  it("honours a caller-supplied cap below the shared one", async () => {
    const result = await fetchCarrierTypeNetwork(DL, TYPE_614, FROM, TO, 12);
    expect(result!.segments).toHaveLength(12);
    expect(result!.drawnRoutes).toBe(12);
    expect(result!.totalRoutes).toBe(DL_614_TOTAL);
  });
});
