import { describe, expect, it } from "vitest";
import { sumTotals, trailing12From } from "@/lib/entityFacts";

/** THE DEFECT THIS FILE EXISTS FOR (issue #121): `sumTotals` restated an unknowable sum as the
 * number 0, on the stat strip of /route, /carrier and /aircraft and on all four cards.
 *
 * Every assertion is on the VALUE. "The strip rendered something" and "the total is a number"
 * both pass under the bug -- the buggy fold returns 0, which is a perfectly good number, and
 * that is precisely why it shipped. The two coercions are also separate mutants: restoring
 * `?? 0` and removing the `??` while folding on `+` produce the identical wrong answer by
 * different routes, so a fix that kills only one is not a fix. */

/** A pivot row for a group whose every filing was quarantined: the three measures come back
 * NULL from `SUM(x) FILTER (WHERE NOT is_quarantined)`, while `quarantined_rows` -- a
 * `count(*) FILTER` -- cannot be NULL and counts the rows that were excluded. This is the
 * literal shape of `/route/A18-LMA` and `/aircraft/TRISLNDR` on the 2026-05 warehouse. */
const quarantinedOnly = {
  op_airline_id: 20333,
  seats: null,
  passengers: null,
  departures_performed: null,
  quarantined_rows: 1,
};

const realTraffic = {
  op_airline_id: 19790,
  seats: 1000,
  passengers: 850,
  departures_performed: 5,
  quarantined_rows: 0,
};

describe("sumTotals refuses to state a total it cannot state", () => {
  // MUTANT A: `const sum = (k) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0)` -- the
  //   original line. Every measure below becomes 0 -> red.
  // MUTANT B: `rows.reduce((a, r) => a + Number(r[k]), 0)` -- the `??` deleted but the fold
  //   left on `+`. `Number(null)` is 0, so this ALSO returns 0 -> red. Half a fix is the bug.
  it("is NULL for every measure when every filing was quarantined", () => {
    const t = sumTotals([quarantinedOnly]);
    expect(t.seats).toBeNull();
    expect(t.passengers).toBeNull();
    expect(t.departures).toBeNull();
  });

  // MUTANT: `loadFactor: seats === 0 ? null : passengers / seats` and
  //   `avgGauge: departures === 0 ? null : seats / departures` -- the guards this function
  //   carried before. With null inputs `null === 0` is false, so both evaluate `null / null`
  //   and return NaN, which `formatGauge` renders as the string "NaN". `toBeNull()` reddens on
  //   NaN; an assertion like `not.toBe(0)` would NOT, since NaN is not 0 either.
  it("does not divide its way to NaN when the inputs are unknowable", () => {
    const t = sumTotals([quarantinedOnly]);
    expect(t.loadFactor).toBeNull();
    expect(t.avgGauge).toBeNull();
    expect(Number.isNaN(t.loadFactor as unknown as number)).toBe(false);
    expect(Number.isNaN(t.avgGauge as unknown as number)).toBe(false);
  });

  // THE SEED. 12,115 route pairs, 45 carriers and 37 aircraft types are fact-present and filed
  // nothing inside the trailing 12, so this is the widest branch of the fix -- and the /airport
  // equivalent (`airportTotals([])`) has answered `null` here since #118.
  // MUTANT: seed `sumColumn`'s reduce at `0` -> three zeroes -> red.
  it("is NULL for every measure when the window holds no rows at all", () => {
    const t = sumTotals([]);
    expect(t.seats).toBeNull();
    expect(t.passengers).toBeNull();
    expect(t.departures).toBeNull();
    expect(t.loadFactor).toBeNull();
    expect(t.avgGauge).toBeNull();
  });

  // MUTANT: NULL-poisoning -- `addSum` returning null if EITHER operand is null. Every measure
  // goes null -> red. This is the opposite error and would erase the honest figures of every
  // entity carrying one quarantined group beside real traffic.
  it("reports the rows it can state and ignores the ones it cannot", () => {
    const t = sumTotals([realTraffic, quarantinedOnly]);
    expect(t.seats).toBe(1000);
    expect(t.passengers).toBe(850);
    expect(t.departures).toBe(5);
    expect(t.loadFactor).toBe(0.85);
    expect(t.avgGauge).toBe(200);
  });

  // A MEASURED ZERO IS NOT AN ABSENCE. A carrier that filed a real 0 seats on a performed
  // departure has told us something; the em dash would be the wrong answer here.
  // MUTANT: `numOrNull` guarding on truthiness (`v ? Number(v) : null`) -> seats becomes null
  // -> red. That mutant leaves every other test in this file green.
  it("keeps a filed zero as a measurement", () => {
    const t = sumTotals([
      { seats: 0, passengers: 0, departures_performed: 2, quarantined_rows: 0 },
    ]);
    expect(t.seats).toBe(0);
    expect(t.passengers).toBe(0);
    expect(t.departures).toBe(2);
    // Zero seats over two performed departures: the gauge is a real 0.0, not an absence.
    expect(t.avgGauge).toBe(0);
    // Zero passengers over zero seats has no quotient, and never had one.
    expect(t.loadFactor).toBeNull();
  });

  // The ratio guard that predates this change and must survive it: both operands known, the
  // denominator a measured zero.
  // MUTANT: drop `denominator === 0` from `ratio` -> Infinity -> red.
  it("is NULL for a ratio over a measured zero denominator", () => {
    const t = sumTotals([
      { seats: 500, passengers: 400, departures_performed: 0, quarantined_rows: 0 },
    ]);
    expect(t.seats).toBe(500);
    expect(t.avgGauge).toBeNull();
    expect(t.loadFactor).toBe(0.8);
  });
});

describe("trailing12From is 11 months back, inclusive", () => {
  // Pinned here because `sumTotals`'s footprint above is stated for one specific window, and a
  // window that silently moved would re-derive every figure in this file against a different
  // one. Mirrors mart_route_health's own `end_m - INTERVAL 11 MONTH`.
  it("spans twelve months ending at asOf", () => {
    expect(trailing12From("2026-05")).toBe("2025-06");
  });

  // MUTANT: `Date.UTC(y, m - 1 - 12, 1)` -> 2025-05 -> red. And the year boundary is the case
  // a same-year fixture cannot see.
  it("crosses the year boundary", () => {
    expect(trailing12From("2026-01")).toBe("2025-02");
    expect(trailing12From("2015-12")).toBe("2015-01");
  });
});
