import { describe, expect, it } from "vitest";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { decodeRequest } from "@/lib/pivot/bounds";
import { encode } from "@/lib/pivot/urlstate";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";
import {
  addFilter, groupableDimensions, filterableDimensions, removeFilterValue,
  setGrain, setGrouping, setLimit, setSort, setWindow, toggleDimension, toggleMeasure,
} from "@/lib/pivot/builder";

const ASOF = "2026-04";

function q(over: Partial<PivotQuery> = {}): PivotQuery {
  return normalizeQuery({
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats"],
    timeFrom: "2015-01",
    timeTo: "2015-12",
    filters: [],
    sort: null,
    sortDesc: true,
    limit: 100,
    grouping: "operating",
    ...over,
  });
}

/** Seeds chosen so every repair has something to repair: a segment-only dimension, a sort key
 *  that a toggle can orphan, a composite `route` filter, and both groupings. */
const SEEDS: PivotQuery[] = [
  q(),
  q({ grain: "route", dimensions: ["route"], measures: ["seats", "load_factor"], sort: "seats" }),
  q({ dimensions: ["aircraft_type"], measures: ["avg_gauge"], sort: "avg_gauge" }),
  q({ grouping: "mainline", filters: [["op_airline_id", ["19790"]]] }),
  q({ grain: "route", filters: [["route", ["12478-12892"]]], dimensions: ["route", "year"] }),
  q({ dimensions: ["origin_state", "dest_state"], measures: ["seats"], limit: 1000 }),
];

/** Every mutation the builder can emit, as (name, fn) so a failure names the culprit. */
function mutations(seed: PivotQuery): [string, PivotQuery][] {
  const out: [string, PivotQuery][] = [];
  for (const g of ["segment", "route"] as const) out.push([`setGrain:${g}`, setGrain(seed, g, FIXTURE)]);
  for (const g of ["operating", "mainline"] as const) out.push([`setGrouping:${g}`, setGrouping(seed, g)]);
  for (const d of FIXTURE.dims.keys()) out.push([`toggleDimension:${d}`, toggleDimension(seed, d, FIXTURE)]);
  for (const m of FIXTURE.meas.keys()) out.push([`toggleMeasure:${m}`, toggleMeasure(seed, m)]);
  for (const s of [...seed.dimensions, ...seed.measures]) out.push([`setSort:${s}`, setSort(seed, s, FIXTURE)]);
  for (const n of [1, 25, 50, 100, 1000, 5000, 0, -1]) out.push([`setLimit:${n}`, setLimit(seed, n)]);
  for (const [f, t] of [["2015-01", "2026-04"], ["2025-05", "2026-04"], ["2030-01", "2030-12"], ["2026-04", "2015-01"]]) {
    out.push([`setWindow:${f}:${t}`, setWindow(seed, f, t, ASOF)]);
  }
  out.push(["addFilter", addFilter(seed, "op_airline_id", "19790")]);
  out.push(["addFilter:either", addFilter(seed, "endpoint_airport_id", "12892")]);
  for (const [k, vs] of seed.filters) for (const v of vs) out.push([`removeFilterValue:${k}`, removeFilterValue(seed, k, v)]);
  return out;
}

describe("the builder emits only queries the server accepts", () => {
  it("round-trips every mutation of every seed through decodeRequest", () => {
    const failures: string[] = [];
    for (const [i, seed] of SEEDS.entries()) {
      for (const [name, mutated] of mutations(seed)) {
        try {
          decodeRequest(encode(mutated), FIXTURE);
        } catch (e) {
          failures.push(`seed ${i} / ${name}: ${(e as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("each repair, named", () => {
  it("setGrain to route drops the segment-only dimensions", () => {
    const before = q({ dimensions: ["aircraft_type", "op_airline_id"] });
    expect(setGrain(before, "route", FIXTURE).dimensions).toEqual(["op_airline_id"]);
  });

  it("setGrain to route drops a filter resting on a segment-only dimension", () => {
    const before = q({ filters: [["aircraft_type", ["612"]], ["op_airline_id", ["19790"]]] });
    expect(setGrain(before, "route", FIXTURE).filters).toEqual([["op_airline_id", ["19790"]]]);
  });

  it("setGrain never empties d, even when every dimension was segment-only", () => {
    const after = setGrain(q({ dimensions: ["aircraft_type"] }), "route", FIXTURE);
    expect(after.dimensions.length).toBeGreaterThan(0);
  });

  it("toggling off the measure the sort names re-points the sort", () => {
    const before = q({ measures: ["seats", "passengers"], sort: "seats" });
    expect(toggleMeasure(before, "seats").sort).toBe("passengers");
  });

  it("toggleDimension refuses endpoint_airport_id, which is filter_only", () => {
    const after = toggleDimension(q(), "endpoint_airport_id", FIXTURE);
    expect(after.dimensions).toEqual(["op_airline_id"]);
  });

  it("addFilter accepts endpoint_airport_id, which toggleDimension refused", () => {
    expect(addFilter(q(), "endpoint_airport_id", "12892").filters).toEqual([
      ["endpoint_airport_id", ["12892"]],
    ]);
  });

  it("the last dimension and the last measure are not removable", () => {
    expect(toggleDimension(q(), "op_airline_id", FIXTURE).dimensions).toEqual(["op_airline_id"]);
    expect(toggleMeasure(q(), "seats").measures).toEqual(["seats"]);
  });

  it("setLimit clamps to MAX_LIMIT and to 1, never to 0", () => {
    expect(setLimit(q(), 5000).limit).toBe(1000);
    expect(setLimit(q(), 0).limit).toBe(1);
    expect(setLimit(q(), -1).limit).toBe(1);
  });

  it("setWindow clamps to the dataset window and corrects a reversed pair", () => {
    expect(setWindow(q(), "2030-01", "2030-12", ASOF)).toMatchObject({
      timeFrom: "2026-04", timeTo: "2026-04",
    });
    expect(setWindow(q(), "2026-04", "2015-01", ASOF)).toMatchObject({
      timeFrom: "2015-01", timeTo: "2026-04",
    });
  });

  it("removing a filter's last value drops the filter, not just the value", () => {
    const before = q({ filters: [["op_airline_id", ["19790"]]] });
    expect(removeFilterValue(before, "op_airline_id", "19790").filters).toEqual([]);
  });

  it("setSort flips direction only when re-sorting on the same key", () => {
    const desc = setSort(q({ measures: ["seats"] }), "seats", FIXTURE);
    expect(desc).toMatchObject({ sort: "seats", sortDesc: true });
    expect(setSort(desc, "seats", FIXTURE)).toMatchObject({ sort: "seats", sortDesc: false });
  });

  it("setSort refuses a composite dimension, which render.ts cannot sort on", () => {
    // `route` spans route_key_low and route_key_high. render.ts:286 excludes multi-column
    // dimensions from its sortable map, so `s=route` throws `unknown sort key`.
    const before = q({ grain: "route", dimensions: ["route", "year"], sort: "year" });
    expect(setSort(before, "route", FIXTURE).sort).toBe("year");
    expect(setSort(before, "year", FIXTURE).sort).toBe("year");
  });

  it("groupable and filterable differ by exactly endpoint_airport_id", () => {
    const g = groupableDimensions(FIXTURE, "segment").map((e) => e.key);
    const f = filterableDimensions(FIXTURE, "segment").map((e) => e.key);
    expect(f.filter((k) => !g.includes(k))).toEqual(["endpoint_airport_id"]);
  });
});
