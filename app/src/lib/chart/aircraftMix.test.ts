import { describe, expect, it } from "vitest";
import {
  fetchAircraftMix,
  aircraftMixQuery,
  toBands,
  type MixRow,
} from "@/lib/chart/aircraftMix";

// The composite `route` dimension filters on an id-ordered pair (M4b): JFK is AIRPORT_ID
// 12478, LAX is 12892. Every measured figure below was re-verified against the built
// upgauge.duckdb while writing this file, not copied from the spec on trust.
const JFK_LAX: [string, string[]][] = [["route", ["12478-12892"]]];
const FULL_FROM = "2015-01";
const FULL_TO = "2026-04";

describe("fetchAircraftMix", () => {
  it("returns one row per month per type, with a resolved short_name", async () => {
    const rows = await fetchAircraftMix(JFK_LAX, FULL_FROM, FULL_TO);
    // Measured: JFK-LAX carries 20 distinct aircraft types over the full window, and all 136
    // months of that window are present on the route. A query that dropped the type dimension
    // returns 1 distinct code; one that dropped the month dimension returns 1 distinct month;
    // a wrong window narrows the month count. `toBe(136)`, not `> 100`: the window is pinned
    // by this test's own arguments, so the exact figure is the assertion the loose bound was
    // standing in for, and only the exact figure fails on an off-by-one window.
    expect(new Set(rows.map((r) => r.code)).size).toBe(20);
    expect(new Set(rows.map((r) => r.month)).size).toBe(136);
    // The raw BTS code is useless for display -- CLAUDE.md's M4a finding, `612` is the 737-700,
    // not the A321. Falsifiable: a `label` left as the raw id reads '699' here, and a resolver
    // pointed at dim_aircraft_type.name reads 'AIRBUS INDUSTRIE A321'.
    const a321 = rows.find((r) => r.code === "699");
    // The key is a zero-padded VARCHAR ('079') -- int-parsing it breaks the resolver join
    // silently (CLAUDE.md), and the failure is exactly this: the label falls back to the raw
    // id because the lookup missed. No separate `typeof code === "string"` assertion here;
    // MixRow.code is typed `string`, so TypeScript already makes that one unfalsifiable.
    expect(a321?.label).toBe("A321/LR");
  });

  it("is not truncated by the row limit", async () => {
    const rows = await fetchAircraftMix(JFK_LAX, FULL_FROM, FULL_TO);
    // Measured: 996 (month, type) groups exist for JFK-LAX over the full window. Pinning the
    // exact count is what makes "not truncated" mean something -- `< limit` alone also passes
    // for a query that returned three rows. Falsifiable in both directions: a limit below 996
    // caps the count and fails, and a query that lost the month or type dimension collapses it.
    expect(rows.length).toBe(996);
    expect(rows.length).toBeLessThan(aircraftMixQuery(JFK_LAX, FULL_FROM, FULL_TO).limit);
  });

  it("carries departures, which shade assignment depends on", async () => {
    const rows = await fetchAircraftMix(JFK_LAX, FULL_FROM, FULL_TO);
    const a321 = rows.filter((r) => r.code === "699");
    const seats = a321.reduce((a, r) => a + r.seats, 0);
    const departures = a321.reduce((a, r) => a + r.departures, 0);
    // Measured totals for the A321/LR on JFK-LAX over the full window, which the spec's
    // gauge of 128.1 is computed from. Falsifiable: dropping `departures_performed` from the
    // measures makes `departures` NaN (Number(undefined)); reading the wrong column, or
    // failing to exclude quarantined rows, moves either figure off its measured value.
    expect(seats).toBe(17_485_274);
    expect(departures).toBe(136_462);
    expect(seats / departures).toBeCloseTo(128.1, 1);
  });

  it("asks the catalog for exactly the pivot the chart needs", () => {
    const q = aircraftMixQuery(JFK_LAX, FULL_FROM, FULL_TO);
    // Falsifiable line by line: `aircraft_type` is segment-grain only in
    // meta_pivot_dimensions, so a `route` grain here throws inside renderPivot; dropping
    // `departures_performed` removes the shade input; `mainline` grouping would roll
    // Endeavor into Delta, which changes nothing about the metal but is not the grain
    // CLAUDE.md says is the truth.
    expect(q.grain).toBe("segment");
    expect(q.dimensions).toEqual(["year_month", "aircraft_type"]);
    expect(q.measures).toEqual(["seats", "departures_performed"]);
    expect(q.grouping).toBe("operating");
    expect(q.filters).toEqual(JFK_LAX);
    expect(q.timeFrom).toBe(FULL_FROM);
    expect(q.timeTo).toBe(FULL_TO);
  });
});

describe("toBands", () => {
  // Every fixture below is built so a SINGLE sort cannot pass: membership order (total seats,
  // descending) and shade order (gauge, ascending) are exact reverses of one another. An
  // implementation that sorts once and reuses the order looks entirely plausible, renders a
  // chart nobody would question, and encodes nothing -- the spec's § Encoding names this as
  // the single most important detail in the milestone.

  it("assigns shade by gauge, not by seats", () => {
    // The fixture is the whole test, and getting it right is subtle enough that the task
    // brief's version got it backwards -- verified by mutation, not by reading: with the
    // brief's numbers (Small 10000 seats / gauge 100, Big 1000 seats / gauge 250) an
    // implementation that reuses the seats ordering for shade PASSES. Seats-descending puts
    // Small first, gauge-ascending puts Small first: the two orderings coincide, so the test
    // cannot fail for the reason it exists.
    //
    // To reverse them across only two types, the type with the MOST seats must also have the
    // LARGEST gauge -- then seats-descending and gauge-ascending are exact opposites. Hence:
    // Big has 10x the seats AND the bigger metal.
    const rows: MixRow[] = [
      { month: "2020-01", code: "A", label: "Small", seats: 1000, departures: 10 }, // gauge 100
      { month: "2020-01", code: "B", label: "Big", seats: 10000, departures: 40 }, // gauge 250
    ];
    const { bands } = toBands(rows);
    const small = bands.find((b) => b.code === "A")!;
    const big = bands.find((b) => b.code === "B")!;
    // Falsifiable, and confirmed so by mutation: replacing the shade sort with the membership
    // ordering gives Big --g1 and Small --g2, and this test goes red. This is the exact bug
    // the spec warns about -- a chart that looks entirely plausible and encodes nothing.
    expect(small.token).toBe("--g1");
    expect(big.token).toBe("--g2");
  });

  it("keeps the top 5 by seats and buckets the rest into Other", () => {
    const rows: MixRow[] = Array.from({ length: 8 }, (_, i) => ({
      month: "2020-01",
      code: `T${i}`,
      label: `T${i}`,
      seats: (8 - i) * 1000,
      departures: 10,
    }));
    const { bands, other } = toBands(rows);
    expect(bands.map((b) => b.code).sort()).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    expect(other.typeCount).toBe(3);
    // Falsifiable: 3 dropped types carry 3000+2000+1000 of 36000 total.
    expect(other.seatShare).toBeCloseTo(6000 / 36000, 5);
    // Uniform departures here, so gauge order is seats order -- and the returned array is in
    // SHADE order, which is therefore the exact reverse of membership order. Falsifiable: an
    // implementation returning membership order gives T0..T4, and one that sorted once gives
    // T0 the lightest token despite T0 being the largest metal in the fixture.
    expect(bands.map((b) => b.code)).toEqual(["T4", "T3", "T2", "T1", "T0"]);
    expect(bands.map((b) => b.token)).toEqual(["--g1", "--g2", "--g3", "--g4", "--g5"]);
    // The Other bucket carries the three dropped types' seats for the one month present, not
    // just a share. Falsifiable: an implementation that computes seatShare but leaves the
    // series empty renders a chart whose stack does not sum to the route's total seats.
    expect(other.series).toEqual([{ month: "2020-01", seats: 6000 }]);
  });

  it("emits zero, not a gap, for a month a type did not fly", () => {
    const rows: MixRow[] = [
      { month: "2020-01", code: "A", label: "A", seats: 100, departures: 1 },
      { month: "2020-02", code: "B", label: "B", seats: 100, departures: 1 },
    ];
    const { bands } = toBands(rows);
    // Falsifiable: a sparse implementation gives each band 1 point; stacking then misaligns.
    for (const b of bands) expect(b.series.map((p) => p.month)).toEqual(["2020-01", "2020-02"]);
    // ...and the filled point must be zero, not a carried-forward or repeated value. The month
    // assertion above passes for an implementation that fills with the type's own seats in
    // every month, which would double the route's total seats on screen.
    expect(bands.find((b) => b.code === "A")!.series).toEqual([
      { month: "2020-01", seats: 100 },
      { month: "2020-02", seats: 0 },
    ]);
    expect(bands.find((b) => b.code === "B")!.series).toEqual([
      { month: "2020-01", seats: 0 },
      { month: "2020-02", seats: 100 },
    ]);
  });

  it("leaves a month the SUBJECT never filed out of every series, and names it a gap", () => {
    // The distinction the shipped M4c missed. The test above ("emits zero, not a gap") covers
    // a month present for SOME type -- which the code always handled -- so a month absent from
    // EVERY type slipped through, and the renderer joined the two surrounding samples with a
    // straight edge across it. 2020-02 and 2020-03 below are filed by nobody.
    //
    // Falsifiable against both wrong answers, which is why the fixture has a two-month hole
    // rather than a one-month one:
    //   - the shipped behaviour (drop absent months from the axis entirely) leaves `span` at
    //     the two filed months and `gaps` empty, and gives both months the same run id;
    //   - zero-filling the window puts 2020-02/2020-03 into every series with seats 0, which
    //     the per-series month assertions below reject.
    const rows: MixRow[] = [
      { month: "2020-01", code: "A", label: "A", seats: 100, departures: 1 },
      { month: "2020-04", code: "A", label: "A", seats: 200, departures: 2 },
      { month: "2020-05", code: "A", label: "A", seats: 300, departures: 3 },
    ];
    const { bands, axis } = toBands(rows);
    expect(axis.span).toEqual(["2020-01", "2020-02", "2020-03", "2020-04", "2020-05"]);
    expect(axis.gaps).toEqual(["2020-02", "2020-03"]);
    expect(bands[0].series.map((p) => p.month)).toEqual(["2020-01", "2020-04", "2020-05"]);
    // Two contiguous runs, and 2020-01 is alone in its own -- an area needs two points, so
    // the renderer has to know to draw that one differently rather than emit nothing.
    expect(axis.run.get("2020-01")).toBe(1);
    expect(axis.run.get("2020-04")).toBe(2);
    expect(axis.run.get("2020-05")).toBe(2);
    expect(axis.run.has("2020-02")).toBe(false);
    expect([...axis.solo]).toEqual([1]);
  });

  it("reports no gaps and one run when every month in the span filed", () => {
    // Paired with the test above on purpose: alone, that one passes for an implementation that
    // reports EVERY month as a gap, or that starts a new run at every month (which would
    // shatter the area into 136 invisible one-month pieces).
    const rows: MixRow[] = ["2020-01", "2020-02", "2020-03"].map((month) => ({
      month,
      code: "A",
      label: "A",
      seats: 100,
      departures: 1,
    }));
    const { axis } = toBands(rows);
    expect(axis.gaps).toEqual([]);
    expect(new Set(axis.run.values())).toEqual(new Set([1]));
    expect([...axis.solo]).toEqual([]);
  });

  it("spans a year boundary without skipping or repeating a month", () => {
    // The span is walked on month integers, not Dates. Falsifiable: a `new Date(y, m+1)` walk
    // that forgets to normalize gives "2020-13", and one that resets the month without carrying
    // the year loops. Neither produces this list.
    const rows: MixRow[] = [
      { month: "2019-11", code: "A", label: "A", seats: 1, departures: 1 },
      { month: "2020-02", code: "A", label: "A", seats: 1, departures: 1 },
    ];
    expect(toBands(rows).axis.span).toEqual(["2019-11", "2019-12", "2020-01", "2020-02"]);
  });

  it("does not create an Other band when there are 5 or fewer types", () => {
    const rows: MixRow[] = Array.from({ length: 4 }, (_, i) => ({
      month: "2020-01",
      code: `T${i}`,
      label: `T${i}`,
      seats: 1000,
      departures: 10,
    }));
    const { bands, other } = toBands(rows);
    expect(other.typeCount).toBe(0);
    // `typeCount === 0` alone is weak -- a `.slice(5)` on 4 types gives 0 either way. These
    // three together are what the renderer's `if (other.typeCount > 0)` gate actually rests
    // on. Falsifiable: an implementation that pads to five bands gives bands.length 5; one
    // that always zero-fills Other's series gives it length 1, so an empty band is drawn.
    expect(bands.length).toBe(4);
    expect(other.seatShare).toBe(0);
    expect(other.series).toEqual([]);
  });

  it("sorts a type with no performed departures last, its gauge being unknown rather than zero", () => {
    // The case is real, not hypothetical: aircraft type 650 (DC-9-50) appears on JFK-LAX with
    // 0 seats and 0 performed departures, so seats/departures is 0/0.
    //
    // Honest about this test's reach: JS's Array.prototype.sort treats a NaN comparator result
    // as "equal", so a naive seats/departures implementation degenerates to a stable sort that
    // leaves the type where membership order put it -- and a 0-seat type is always LAST by
    // seats, so NaN happens to land in the same place. What this test does discriminate is the
    // other plausible reading, `departures === 0 ? 0 : seats / departures`, which makes an
    // aircraft that flew nothing the lightest band on the chart -- a claim about metal size
    // drawn from no evidence at all. Unknown sorts last, matching DuckDB's own NULLS LAST
    // default for ORDER BY ASC.
    const rows: MixRow[] = [
      { month: "2020-01", code: "A", label: "A", seats: 5000, departures: 50 }, // gauge 100
      { month: "2020-01", code: "B", label: "B", seats: 4000, departures: 20 }, // gauge 200
      { month: "2020-01", code: "C", label: "C", seats: 3000, departures: 10 }, // gauge 300
      { month: "2020-01", code: "D", label: "D", seats: 2000, departures: 5 }, // gauge 400
      { month: "2020-01", code: "Z", label: "Z", seats: 0, departures: 0 }, // gauge unknown
    ];
    const { bands } = toBands(rows);
    expect(bands.map((b) => b.code)).toEqual(["A", "B", "C", "D", "Z"]);
    expect(bands.find((b) => b.code === "Z")!.token).toBe("--g5");
  });
});

describe("toBands against the real JFK-LAX mix", () => {
  // Step 5 of the task brief: the two orderings pinned against live data, where they genuinely
  // disagree. Measured against the built upgauge.duckdb over the full window.
  it("orders membership by seats and shade by gauge, which disagree on this route", async () => {
    const rows = await fetchAircraftMix(JFK_LAX, FULL_FROM, FULL_TO);
    const { bands, other, axis } = toBands(rows);

    // Membership -- top 5 by TOTAL seats: A321/LR 17,485,274 · B767-3/R 7,852,109 ·
    // B767-4 3,119,079 · B757-2 2,900,388 · A320-1/2 2,132,256. The 6th, A321NEO at
    // 1,668,757, is the nearest miss and belongs in Other.
    //
    // Order-insensitive on purpose, and kept even though the ordered assertion below implies
    // it: the two are separate claims, and asserting them separately is what makes a failure
    // legible -- this one red means MEMBERSHIP broke, this one green and the next red means
    // SHADE broke. One combined assertion cannot tell you which.
    expect([...bands].map((b) => b.label).sort()).toEqual(
      ["A320-1/2", "A321/LR", "B757-2", "B767-3/R", "B767-4"].sort(),
    );

    // Shade -- the returned order, by gauge ASCENDING: A321/LR 128.1 · A320-1/2 148.4 ·
    // B757-2 164.2 · B767-3/R 216.6 · B767-4 239.2.
    //
    // THIS is the assertion the milestone turns on. A single sort by seats produces
    // ["A321/LR", "B767-3/R", "B767-4", "B757-2", "A320-1/2"] -- superficially identical
    // membership, a completely different encoding. The A321/LR is first by seats AND the
    // lightest by gauge, so it alone cannot tell the two apart; positions 2-5 can.
    expect(bands.map((b) => b.label)).toEqual([
      "A321/LR",
      "A320-1/2",
      "B757-2",
      "B767-3/R",
      "B767-4",
    ]);
    expect(bands.map((b) => b.token)).toEqual(["--g1", "--g2", "--g3", "--g4", "--g5"]);

    // 20 types on the route, 5 banded, 15 in Other -- carrying 4,057,675 of 37,546,781 seats.
    // Measured, and a number the legend rail is required to state out loud: at 10.8% this
    // route sits in the band the spec calls out, where Other is not a rounding error.
    expect(other.typeCount).toBe(15);
    expect(other.seatShare).toBeCloseTo(4_057_675 / 37_546_781, 6);

    // Every band spans the full 136-month x-domain, so the areas stack without holes.
    for (const b of bands) expect(b.series.length).toBe(136);
    expect(other.series.length).toBe(136);
    // The stack must sum to the route's total seats -- nothing dropped between the query and
    // the bands. Falsifiable: losing the 6th-through-20th types entirely (no Other band) leaves
    // this 4,057,675 short.
    const stacked =
      bands.reduce((a, b) => a + b.series.reduce((s, p) => s + p.seats, 0), 0) +
      other.series.reduce((s, p) => s + p.seats, 0);
    expect(stacked).toBe(37_546_781);

    // No gaps on THIS route, which is what makes the HNL-LAS test below a pair rather than a
    // lone positive: an implementation that reported every month as a gap would satisfy that
    // one and fail this.
    expect(axis.gaps).toEqual([]);
  });
});

describe("toBands against a real route that stopped filing mid-window", () => {
  // HNL is AIRPORT_ID 12173, LAS is 12889. Measured against the built upgauge.duckdb: the pair
  // filed in 130 of the window's 136 months and nothing at all for 2020-04..2020-09 -- six
  // months inside the --panel-2 band the chart itself labels "COVID -- in window on purpose."
  // 7.07 M seats over the window, so this is a page someone loads, not a corner case; 14,198 of
  // 22,950 route pairs (62%) have at least one interior gap.
  const HNL_LAS: [string, string[]][] = [["route", ["12173-12889"]]];

  it("names the six months HNL-LAS filed nothing in, and puts them in no series", async () => {
    const rows = await fetchAircraftMix(HNL_LAS, FULL_FROM, FULL_TO);
    const { bands, axis } = toBands(rows);
    expect(axis.span.length).toBe(136);
    expect(axis.gaps).toEqual([
      "2020-04",
      "2020-05",
      "2020-06",
      "2020-07",
      "2020-08",
      "2020-09",
    ]);
    // The claim that matters: no band carries a point for those months, so nothing downstream
    // can draw them. Falsifiable against the shipped behaviour (130 points and no `axis` at
    // all) and against zero-filling (136 points, six of them 0).
    for (const b of bands) {
      expect(b.series.length).toBe(130);
      expect(b.series.some((p) => axis.gaps.includes(p.month))).toBe(false);
    }
    // Two runs, either side of the hole -- 2015-01..2020-03 and 2020-10..2026-04.
    expect(new Set(axis.run.values())).toEqual(new Set([1, 2]));
    expect(axis.run.get("2020-03")).toBe(1);
    expect(axis.run.get("2020-10")).toBe(2);
    expect([...axis.solo]).toEqual([]);
  });
});
