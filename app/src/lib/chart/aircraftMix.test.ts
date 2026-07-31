import { describe, expect, it } from "vitest";
import { fetchAircraftMix, aircraftMixQuery } from "@/lib/chart/aircraftMix";

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
