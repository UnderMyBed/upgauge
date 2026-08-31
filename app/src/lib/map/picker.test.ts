import { describe, expect, it } from "vitest";
import { pickerOptions } from "@/lib/map/picker";
import { dataAsOf, runPivot } from "@/lib/db";
import { resolutionKey, type Resolved } from "@/lib/resolve";
import { slugFor } from "@/lib/aircraftSlug";
import { rawFilterValue, resolveCarrierFilter, resolveTypeFilter } from "@/lib/map/mapFilter";
import { CARRIER_TYPE_LIMIT, trailing12Query } from "@/lib/entityFacts";

/** A `filterValueOf` that echoes the raw id -- for the tests whose subject is NOT the filter
 *  vocabulary (ordering, tiebreaks, null seats, encoding). The vocabulary itself is covered by
 *  the round-trip tests at the bottom of this file, which use the REAL transforms the two pages
 *  pass and feed the result to the REAL resolvers. */
const ECHO_ID = (rawId: string) => rawId;

/** What `/carrier` passes. The slug, never the BTS id, and never the bare label either: 
 *  `slugFor` maps `/` and ` ` onto `-`, and `CRJ-2/4` is a live short name whose bare form
 *  `resolveTypeFilter` refuses (the `%2F` its encoding produces fails the no-percent bound). */
const CARRIER_FILTER_VALUE_OF = (_rawId: string, label: string) => slugFor(label);

/** What `/aircraft` passes: the carrier CODE, which is what `resolveCarrierFilter` admits. */
const AIRCRAFT_FILTER_VALUE_OF = (_rawId: string, label: string) => label;

/**
 * PRODUCER-SHAPED, and that is the whole point of this helper rather than an object literal.
 * `PivotResult.resolved` is a `Map<string, Resolved>` keyed by `resolutionKey()` (`db.ts:259`,
 * `resolve.ts:402`) -- NOT a nested `{ [dim]: { [id]: label } }` object. A fixture in the
 * nested shape cannot express the bug: an implementation that indexes it as an object gets
 * `undefined` from a real Map, falls back to the raw id for EVERY row, and renders "673"
 * where the reader should see "CRJ-700" -- on both pages that mount a picker -- while every
 * assertion written against the object-shaped fixture stays green.
 */
function resolvedMap(dimKey: string, entries: Record<string, Resolved>): Map<string, Resolved> {
  return new Map(Object.entries(entries).map(([id, r]) => [resolutionKey(dimKey, id), r]));
}

const ROWS = [
  { aircraft_type: "631", seats: 10_000 },
  { aircraft_type: "673", seats: 90_000 },
  { aircraft_type: "629", seats: 50_000 },
];

// `code` is dim_aircraft_type.short_name, `name` the full designation -- resolve_aircraft_type.sql
// inverts the usual direction on purpose, and `displayValue` returns the code.
const RESOLVED = resolvedMap("aircraft_type", {
  "631": { code: "CRJ-200", name: "CANADAIR RJ-200ER /RJ-440" },
  "673": { code: "CRJ-700", name: "CANADAIR RJ-700" },
  "629": { code: "EMB-120", name: "EMBRAER-120 BRASILIA" },
});

/** Look one option up BY VALUE, never by position. Three assertions below are about a single
 *  option's fields, not about where it sits, and indexing `[0]` would make them fail under the
 *  dropped-sort mutant too -- collateral reds that make a mutant table say less than it looks
 *  like it says. */
function byValue(value: string, over: Partial<Parameters<typeof pickerOptions>[0]> = {}) {
  const hit = opts(over).find((o) => o.value === value);
  if (hit === undefined) throw new Error(`no option for ${value}`);
  return hit;
}

function opts(over: Partial<Parameters<typeof pickerOptions>[0]> = {}) {
  return pickerOptions({
    rows: ROWS,
    resolved: RESOLVED,
    dimKey: "aircraft_type",
    basePath: "/carrier/OO",
    filterKey: "type",
    filterValueOf: ECHO_ID,
    selected: null,
    ...over,
  });
}

describe("pickerOptions", () => {
  it("orders by seats descending, not by the row order it was given", () => {
    // ORDERING is the property. Asserting the SET of values passes under a dropped sort -- the
    // same shape that let M4c's stack-order mutant survive.
    expect(opts().map((o) => o.value)).toEqual(["673", "629", "631"]);
  });

  it("breaks a seats tie on the value, so two loads of tied rows agree", () => {
    // This comparator must not depend on how its rows were produced (segmentMap.ts states the
    // same rule for node emission order); #136 gave the pivot a tiebreak of its own, and this
    // one has to hold for any caller regardless. Fed in DESCENDING value order, a dropped tiebreak leaves
    // them there -- V8's sort is stable -- so only the SEQUENCE distinguishes correct here.
    const tied = pickerOptions({
      rows: [
        { aircraft_type: "673", seats: 1_000 },
        { aircraft_type: "631", seats: 1_000 },
        { aircraft_type: "629", seats: 1_000 },
      ],
      resolved: RESOLVED,
      dimKey: "aircraft_type",
      basePath: "/carrier/OO",
      filterKey: "type",
      filterValueOf: ECHO_ID,
      selected: null,
    });
    expect(tied.map((o) => o.value)).toEqual(["629", "631", "673"]);
  });

  it("builds an href on the base path with the filter key, carrying the FILTER value", () => {
    // CORRECTED. This read `expect(byValue("673").href).toBe("/carrier/OO?type=673")` -- the BTS
    // id -- and was not merely failing to catch the defect below, it was ARGUING FOR IT.
    // `proxy.ts:442` declares the vocabulary as `?type=<aircraft slug>` and `resolveTypeFilter`
    // refuses `673` outright, so every href this module emitted was dead on arrival. The round-
    // trip tests at the bottom of this file are what actually hold the vocabulary; this one
    // holds only the href's SHAPE.
    expect(byValue("CRJ-700", { filterValueOf: CARRIER_FILTER_VALUE_OF }).href).toBe(
      "/carrier/OO?type=CRJ-700",
    );
  });

  it("marks exactly the option whose FILTER value the URL names", () => {
    // The page reads `selected` off the query string, so it is in the filter vocabulary. Under
    // the id-valued `value` this module used to emit, a slug-valued selection matched NOTHING --
    // so no picker on either page ever marked the view its reader was actually looking at.
    const out = opts({ filterValueOf: CARRIER_FILTER_VALUE_OF, selected: "EMB-120" });
    expect(out.filter((o) => o.selected).map((o) => o.label)).toEqual(["EMB-120"]);
  });

  it("marks nothing when the URL names the BTS id instead of the filter value", () => {
    // REPLACES a test that asserted the exact opposite and called it correct ("matching on
    // `label` would make `?type=EMB-120` ... select a row, and `?type=629` select nothing").
    // `?type=629` is not a value any href here emits and not one `resolveTypeFilter` admits, so
    // marking it current would have the picker claim to show a view the server refused.
    expect(
      opts({ filterValueOf: CARRIER_FILTER_VALUE_OF, selected: "629" }).some((o) => o.selected),
    ).toBe(false);
  });

  it("keeps a zero-padded code a string", () => {
    // AIRCRAFT_TYPE `079` becomes `79` if int-parsed and the join breaks silently (CLAUDE.md).
    const out = pickerOptions({
      rows: [{ aircraft_type: "079", seats: 1 }],
      resolved: resolvedMap("aircraft_type", { "079": { code: "C208", name: "CESSNA 208 CARAVAN" } }),
      dimKey: "aircraft_type",
      basePath: "/carrier/OO",
      filterKey: "type",
      filterValueOf: ECHO_ID,
      selected: null,
    });
    expect(out[0].value).toBe("079");
    expect(out[0].href).toBe("/carrier/OO?type=079");
  });

  it("reads the resolved Map by resolutionKey, so real labels reach the reader", () => {
    // THE STALE-CONTRACT MUTANT. An implementation indexing `resolved` as a nested object gets
    // `undefined` from a real Map and renders the raw BTS code on every option, on both pages.
    expect(opts().map((o) => [o.value, o.label])).toEqual(
      expect.arrayContaining([
        ["673", "CRJ-700"],
        ["629", "EMB-120"],
        ["631", "CRJ-200"],
      ]),
    );
  });

  it("renders the NAME when the dimension resolves with no code", () => {
    // `displayValue`'s three-way contract, which resolve.ts:38-52 forbids re-deriving locally:
    // absent -> raw id; resolved with `code: null` (dim_city_market) -> the NAME; otherwise the
    // code. A local `hit?.code ?? raw` collapses the first two and renders "30559" for Chicago.
    const out = pickerOptions({
      rows: [{ origin_city_market_id: 30559, seats: 5 }],
      resolved: resolvedMap("origin_city_market_id", {
        "30559": { code: null, name: "Chicago, IL" },
      }),
      dimKey: "origin_city_market_id",
      basePath: "/carrier/OO",
      filterKey: "market",
      filterValueOf: ECHO_ID,
      selected: null,
    });
    expect(out[0].label).toBe("Chicago, IL");
  });

  it("falls back to the raw value when the dimension resolves no label", () => {
    const out = pickerOptions({
      rows: [{ aircraft_type: "999", seats: 1 }],
      resolved: new Map(),
      dimKey: "aircraft_type",
      basePath: "/carrier/OO",
      filterKey: "type",
      filterValueOf: ECHO_ID,
      selected: null,
    });
    expect(out[0].label).toBe("999");
    expect(out[0].title).toBeNull();
  });

  it("carries the full name as `title`, the <abbr> DataTable already gives a resolved id", () => {
    expect(byValue("673").title).toBe("CANADAIR RJ-700");
  });

  it("drops a row whose dimension value is absent rather than linking to an empty filter", () => {
    const out = pickerOptions({
      rows: [{ aircraft_type: null, seats: 9 }, { aircraft_type: "673", seats: 1 }],
      resolved: RESOLVED,
      dimKey: "aircraft_type",
      basePath: "/carrier/OO",
      filterKey: "type",
      filterValueOf: ECHO_ID,
      selected: null,
    });
    expect(out.map((o) => o.value)).toEqual(["673"]);
  });

  it("percent-encodes a value that carries a reserved character", () => {
    // `CE-206/7` is a real short_name; an unencoded `/` in the query string would be a
    // different filter value on the way back in.
    const out = pickerOptions({
      rows: [{ op_airline_id: "A/B", seats: 1 }],
      resolved: new Map(),
      dimKey: "op_airline_id",
      basePath: "/aircraft/CRJ-700",
      filterKey: "carrier",
      filterValueOf: ECHO_ID,
      selected: null,
    });
    expect(out[0].href).toBe("/aircraft/CRJ-700?carrier=A%2FB");
  });
});

/**
 * REAL, and named so it resists the drift this repo has already paid for (a BTS refresh renamed
 * aircraft type 699 out from under a whole fixture set). `/carrier/F4` -- Air Charter, Inc d/b/a
 * Air Flamenco, airline_id 21615 -- over the trailing 12 to 2026-05 returns exactly these three
 * rows from the page's own pivot, verified against `upgauge.duckdb`:
 *
 *     type=131  seats=24289  deps=2987  quarantined_rows=2
 *     type=489  seats=NULL   deps=NULL  quarantined_rows=5
 *     type=201  seats=NULL   deps=NULL  quarantined_rows=2
 *
 * `seats` is `SUM(seats) FILTER (WHERE NOT is_quarantined)`, so a group whose every filing was
 * quarantined sums to NULL. `render.ts` emits no `HAVING` and no `IS NOT NULL`, so they arrive.
 */
const F4_ROWS = [
  { aircraft_type: "131", seats: 24_289 },
  { aircraft_type: "489", seats: null },
  { aircraft_type: "201", seats: null },
];

describe("pickerOptions with an absent seat total", () => {
  it("keeps a NULL seat sum null instead of calling it zero", () => {
    // `format.ts:1`: null is absence, zero is a measurement, never render one as the other.
    // `?? 0` makes /carrier/F4 state a seat total of 0 for two types whose total is unknowable.
    const out = pickerOptions({
      rows: F4_ROWS, resolved: new Map(), dimKey: "aircraft_type",
      basePath: "/carrier/F4", filterKey: "type", filterValueOf: ECHO_ID, selected: null,
    });
    expect(out.map((o) => [o.value, o.seats])).toEqual([
      ["131", 24_289],
      ["201", null],
      ["489", null],
    ]);
  });

  it("sorts an absent total AFTER a genuine zero, not alongside it", () => {
    // THE MUTANT-KILLING FIXTURE, and both halves are real cases this codebase documents:
    //   `650` -- DL x 650 over 2015, five pairs, every one zero seats on zero performed
    //            departures. FILED AND GENUINELY NOT FLOWN: 0 is a measurement.
    //   `489` -- F4 x 489, five filings, every one quarantined. UNKNOWABLE: null is absence.
    //
    // The order is what distinguishes them, and the values are chosen so it MOVES: under
    // `?? 0` both are 0, the tiebreak runs, and "489".localeCompare("650") puts the absent one
    // FIRST. A fixture using seats: 0 for both, or values sorting the other way, would produce
    // the identical array under the bug and prove nothing.
    const out = pickerOptions({
      rows: [
        { aircraft_type: "489", seats: null },
        { aircraft_type: "650", seats: 0 },
      ],
      resolved: new Map(), dimKey: "aircraft_type",
      basePath: "/carrier/F4", filterKey: "type", filterValueOf: ECHO_ID, selected: null,
    });
    expect(out.map((o) => o.value)).toEqual(["650", "489"]);
    expect(out.map((o) => o.seats)).toEqual([0, null]);
  });

  it("orders two absent totals deterministically, so two loads agree", () => {
    // A NaN comparator is not merely wrong, it is INCONSISTENT -- the result can depend on the
    // engine's sort and on input order, against the byte-stability this repo rests on. Fed in
    // both orders, the output must be identical.
    const rows = [
      { aircraft_type: "489", seats: null },
      { aircraft_type: "201", seats: null },
    ];
    const args = { resolved: new Map(), dimKey: "aircraft_type", basePath: "/carrier/F4", filterKey: "type", filterValueOf: ECHO_ID, selected: null };
    const forward = pickerOptions({ rows, ...args }).map((o) => o.value);
    const reversed = pickerOptions({ rows: [...rows].reverse(), ...args }).map((o) => o.value);
    expect(forward).toEqual(["201", "489"]);
    expect(reversed).toEqual(forward);
  });

  it("throws when the page's pivot never selected `seats`", () => {
    // `undefined` is a WIRING bug, not absence. Reading it as null would mark every option on
    // the page quarantined -- a louder lie than the one this guard exists to stop. Both page
    // pivots go through `trailing12Query`, whose measures always include `seats`.
    expect(() =>
      pickerOptions({
        rows: [{ aircraft_type: "673" }], resolved: new Map(), dimKey: "aircraft_type",
        basePath: "/carrier/OO", filterKey: "type", filterValueOf: ECHO_ID, selected: null,
      }),
    ).toThrow(/no `seats` column/);
  });
});

describe("pickerOptions against a real pivot result", () => {
  it("resolves labels from the Map runPivot actually returns", async () => {
    // The shape assertion the hand-built fixture above cannot make: this takes `rows` and
    // `resolved` from the PRODUCER, unmodified. `/aircraft`'s picker is exactly this pivot
    // (page.tsx:139), so a shape drift in `PivotResult.resolved` fails here rather than
    // silently rendering airline ids to every reader.
    const asOf = await dataAsOf();
    const result = await runPivot({
      grain: "segment",
      dimensions: ["op_airline_id"],
      measures: ["seats"],
      timeFrom: "2025-01",
      timeTo: asOf,
      filters: [],
      sort: "seats",
      sortDesc: true,
      limit: 20,
      grouping: "operating",
    });
    const out = pickerOptions({
      rows: result.rows,
      resolved: result.resolved,
      dimKey: "op_airline_id",
      basePath: "/aircraft/B737-8",
      filterKey: "carrier",
      filterValueOf: AIRCRAFT_FILTER_VALUE_OF,
      selected: null,
    });

    expect(out.length).toBeGreaterThan(0);
    // Every LABEL is the carrier CODE, resolved out of the producer's own Map -- and /aircraft
    // derives its filter value FROM that label, so under a nested-object read of `resolved` the
    // label falls back to the raw 5-digit AIRLINE_ID and `value` fails this on the first row.
    // That is the stale-contract mutant (A10) and the vocabulary defect caught by one assertion.
    for (const o of out) {
      expect(o.value).toMatch(/^[A-Z0-9]{2,3}$/);
      expect(o.label).toBe(o.value);
      expect(o.title).not.toBeNull();
    }
  });
});

/**
 * THE VALUE-SPACE CONTRACT, AND THE ONLY TESTS IN THIS FILE THAT CAN HOLD IT.
 *
 * `pickerOptions` returns `value: string` and `resolveTypeFilter` takes `raw: string`, so the
 * two signatures line up perfectly -- a seam trace of the producer against the consumer passes
 * while every link the picker emits is refused at the far end. The contract that was violated is
 * that the string must be a SLUG rather than an ID, and TypeScript has no way to say that. So
 * these tests do not check a shape: they take the href the module emits, pull the value back out
 * of its RAW query bytes exactly as the server does, hand it to the REAL resolver, and require
 * the id it started from to come back.
 *
 * RAW BYTES, via `rawFilterValue`, NOT `new URLSearchParams(...).get()` -- the second one
 * percent-decodes, which is precisely the divergence that lets a page admit a value the proxy
 * refused (`mapFilter.ts:105-145`). It also makes this test able to fail for the right reason:
 * passing the bare label instead of `slugFor(label)` encodes `CRJ-2/4` to `CRJ-2%2F4`, whose `%`
 * the no-percent bound rejects -- so the "just use the label" mutant dies here too.
 */
describe("the values pickerOptions emits are values the filter resolvers admit", () => {
  it("round-trips every /carrier option: href -> raw query -> resolveTypeFilter -> the same id", async () => {
    const asOf = await dataAsOf();
    // SkyWest, airline_id 20304 -- six types over the trailing 12, including `CRJ-2/4`, whose
    // short name carries a `/`. A single-type fixture could not fail on the separator.
    const result = await runPivot(
      trailing12Query({
        dimensions: ["aircraft_type"],
        filters: [["op_airline_id", ["20304"]]],
        asOf,
        limit: CARRIER_TYPE_LIMIT,
      }),
    );
    expect(result.rows.length).toBeGreaterThan(1);

    for (const row of result.rows) {
      // One row at a time, so the id this option came from is known rather than recovered from
      // a sorted list whose `value` deliberately no longer carries it.
      const rawId = String(row.aircraft_type);
      const [option] = pickerOptions({
        rows: [row],
        resolved: result.resolved,
        dimKey: "aircraft_type",
        basePath: "/carrier/OO",
        filterKey: "type",
        filterValueOf: CARRIER_FILTER_VALUE_OF,
        selected: null,
      });
      const sent = rawFilterValue(option.href.slice(option.href.indexOf("?") + 1), "type");
      expect(sent).not.toBeNull();
      const back = await resolveTypeFilter(sent);
      expect({ id: rawId, kind: back.kind }).toEqual({ id: rawId, kind: "ok" });
      if (back.kind === "ok") expect(back.id).toBe(rawId);
    }
  }, 60_000);

  it("round-trips every /aircraft option: href -> raw query -> resolveCarrierFilter -> the same id", async () => {
    const asOf = await dataAsOf();
    // Type 673 (ERJ-175) is flown by several carriers, so this exercises more than one row.
    const result = await runPivot(
      trailing12Query({
        dimensions: ["op_airline_id"],
        filters: [["aircraft_type", ["673"]]],
        asOf,
        limit: 10,
      }),
    );
    expect(result.rows.length).toBeGreaterThan(1);

    for (const row of result.rows) {
      const rawId = String(row.op_airline_id);
      const [option] = pickerOptions({
        rows: [row],
        resolved: result.resolved,
        dimKey: "op_airline_id",
        basePath: "/aircraft/ERJ-175",
        filterKey: "carrier",
        filterValueOf: AIRCRAFT_FILTER_VALUE_OF,
        selected: null,
      });
      const sent = rawFilterValue(option.href.slice(option.href.indexOf("?") + 1), "carrier");
      expect(sent).not.toBeNull();
      const back = await resolveCarrierFilter(sent);
      expect({ id: rawId, kind: back.kind }).toEqual({ id: rawId, kind: "ok" });
      if (back.kind === "ok") expect(String(back.id)).toBe(rawId);
    }
  }, 60_000);

  it("no carrier flies two BTS codes sharing one short name, so no picker lists a value twice", async () => {
    // `slugFor` IS many-to-one, and one collision is live: CE-180 is BTS codes 030 (CESSNA 180)
    // and 031 (CESSNA 180A/B), both fact-present. If one carrier ever filed both in one window,
    // its picker would render two options with the same value, the same label and the same href
    // -- duplicate React keys, and a link to a `?type=CE-180` that correctly refuses as
    // AMBIGUOUS. That is unreachable on today's data (measured: zero carriers, over the whole
    // 2015-2026 window, not merely the trailing 12), and it is a property of the DATA, not of
    // the scheme -- exactly what `aircraftSlug.ts:38-45` says about its own injectivity.
    //
    // So this is pinned rather than engineered around: a BTS refresh that makes it reachable
    // fails HERE, with the reason attached, instead of surfacing as a duplicate-key warning on
    // a served page. `MAX_SLUG_SEPARATORS` gets the identical treatment for the identical
    // reason. If it ever goes red, `pickerOptions` needs a decision, not a patch.
    const clashes = await runPivot({
      grain: "segment",
      dimensions: ["op_airline_id"],
      measures: ["seats"],
      timeFrom: "2015-01",
      timeTo: await dataAsOf(),
      filters: [["aircraft_type", ["030", "031"]]],
      sort: "seats",
      sortDesc: true,
      limit: 50,
      grouping: "operating",
    });
    // Every carrier here flies 030 or 031; the failure is one flying BOTH. Re-derived per
    // carrier rather than trusted from the group, because that is the clause that matters.
    const perCarrier = new Map<string, Set<string>>();
    for (const row of clashes.rows) perCarrier.set(String(row.op_airline_id), new Set());
    for (const code of ["030", "031"]) {
      const one = await runPivot({
        grain: "segment",
        dimensions: ["op_airline_id"],
        measures: ["seats"],
        timeFrom: "2015-01",
        timeTo: await dataAsOf(),
        filters: [["aircraft_type", [code]]],
        sort: "seats",
        sortDesc: true,
        limit: 50,
        grouping: "operating",
      });
      for (const row of one.rows) perCarrier.get(String(row.op_airline_id))?.add(code);
    }
    const both = [...perCarrier].filter(([, codes]) => codes.size > 1).map(([id]) => id);
    expect(both).toEqual([]);
  }, 60_000);
});
