import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EARLIEST_MONTH,
  monthsBack,
  sumTotals,
  trailing12From,
  windowStart,
} from "@/lib/entityFacts";
import { EARLIEST_YEAR } from "@/lib/year";

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

/** THE DATASET'S LOWER BOUND HAS ONE OWNER (#145).
 *
 * It was written out three times -- `lib/entityFacts.ts` exported it, and `explore/page.tsx` and
 * `aircraft/[name]/not-found.tsx` each re-declared the same `"2015-01"` locally, each with a
 * comment saying it matched the others. Three copies of a constant is how they stop matching.
 *
 * TWO DIFFERENT PROPERTIES, and neither substitutes for the other: the first pins that the two
 * legitimate holders of this bound AGREE; the second pins that a fourth holder cannot appear. */
describe("EARLIEST_MONTH is declared once", () => {
  // `lib/year.ts` states this agreement in PROSE ("Matches the `EARLIEST_MONTH = \"2015-01\"`
  // constant") and nothing enforced it -- while `bounds.test.ts` quietly re-derives one from the
  // other, so a drift would make that file's fixtures describe a window `/explore` does not have.
  // The two are one fact spelled at two grains: `y` on /airport and `t` on /explore are the same
  // question (bounds.ts's own note), so they cannot be allowed to disagree.
  it("agrees with year.ts's EARLIEST_YEAR, which states the same bound at year grain", () => {
    expect(EARLIEST_MONTH).toBe(`${EARLIEST_YEAR}-01`);
  });

  // The scan half. A fourth LOCAL re-declaration is the exact mechanism that produced the three
  // this issue removed, and it is invisible to every other test in this repo: a local
  // `const EARLIEST_MONTH = "2015-01"` renders identically until the day the two disagree.
  //
  // Matches a DECLARATION (`const|let|var EARLIEST_MONTH`), never a mention -- `builder.ts`,
  // the four entity pages and `WindowControl` all read the imported constant and must not be
  // caught. `.test.` files are excluded: `bounds.test.ts` deliberately re-derives it from
  // EARLIEST_YEAR as its own fixture, which is the assertion above, not a drifting copy.
  //
  // BOTH HALVES ARE LOAD-BEARING. Without the `toEqual([...])` on the path, a scan finding zero
  // declarations -- because the real one was deleted or renamed -- would pass the "no extras"
  // reading vacuously.
  it("has exactly one declaration in app/src, and it is entityFacts's", () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) files(full, out);
        else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(full);
      }
      return out;
    };
    const declaring = files(SRC)
      .filter((f) => /\b(?:const|let|var)\s+EARLIEST_MONTH\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f))
      .sort();
    expect(declaring).toEqual(["lib/entityFacts.ts"]);
  });
});

/** THE DEFECT THIS BLOCK EXISTS FOR (issue #155): two functions named `monthsBefore`, same
 * arity, different meaning. `watch/[preset]/page.tsx` read `n` as an OFFSET (n months back);
 * `components/builder/WindowControl.tsx` read it as a WINDOW LENGTH (n - 1 back). Both were
 * correct in place -- `watch` called it with 11, `WindowControl` with 12, and both landed on
 * 2025-05 -- so nothing was ever red. Moving a call between the two files, or folding them into
 * one helper, silently shifts the window by a month.
 *
 * THE FIXTURE HAS TO DISCRIMINATE. A window-length call and an offset call agree whenever the
 * caller compensates, which is exactly the state the codebase was already in, so asserting "the
 * window is twelve months" passes under BOTH conventions and proves nothing. Every assertion
 * below is on the month a SINGLE convention produces, and `the two conventions disagree` pins
 * the gap itself -- if a refactor ever makes them synonyms, that test goes red before a call
 * site silently moves. */
describe("month arithmetic spells offset and window-length differently (#155)", () => {
  // MUTANT: `monthsBack` implemented as `n - 1` back (WindowControl's old convention) -> 2025-05
  // -> red. The 12 here is deliberate: it is the argument that made the two old functions
  // disagree, so a fixture using 11 would pass under both.
  it("monthsBack counts an offset: twelve back from 2026-04 is 2025-04", () => {
    expect(monthsBack("2026-04", 12)).toBe("2025-04");
  });

  // MUTANT: `windowStart` implemented as `months` back (watch's old convention) -> 2025-04 ->
  // red.
  it("windowStart counts a length: a twelve-month window ending 2026-04 starts 2025-05", () => {
    expect(windowStart("2026-04", 12)).toBe("2025-05");
  });

  /** The property the two old names destroyed. Asserted directly rather than left implicit in
   * the two cases above, because those two could both be satisfied by one function the day
   * someone decides the names are synonyms. */
  it("the two conventions disagree on the same argument", () => {
    expect(monthsBack("2026-04", 12)).not.toBe(windowStart("2026-04", 12));
  });

  // The year boundary is the case a same-year fixture cannot see -- and the two conventions
  // straddle it differently, which is the whole point.
  it("crosses the year boundary under both spellings", () => {
    expect(monthsBack("2026-01", 1)).toBe("2025-12");
    expect(windowStart("2026-01", 12)).toBe("2025-02");
  });

  /** `trailing12From` is the name the six existing call sites use; it must stay expressible as
   * BOTH spellings, or the consolidation moved a window it claimed to preserve. */
  it("trailing12From is the twelve-month window, which is eleven back", () => {
    expect(trailing12From("2026-04")).toBe(windowStart("2026-04", 12));
    expect(trailing12From("2026-04")).toBe(monthsBack("2026-04", 11));
  });
});

/** ONE OWNER FOR THE DERIVATION (#155).
 *
 * Mirrors the EARLIEST_MONTH sweep above and for the same reason: pinning the two helpers'
 * behaviour does not stop a third file declaring its own month subtraction, which is how this
 * defect arrived. Both halves are load-bearing -- without the `toEqual([...])`, a scan finding
 * zero declarations because the real ones were renamed would pass vacuously. */
describe("month subtraction is declared once", () => {
  it("has exactly one declaring file in app/src, and it is entityFacts's", () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) files(full, out);
        else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(full);
      }
      return out;
    };
    // The two shapes both old copies used: `Date.UTC(y, m - 1 - n, ...)` and the integer-month
    // `y * 12 + (m - 1) - ...` form. A new copy in either idiom is caught.
    const declaring = files(SRC)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return /Date\.UTC\(\s*y\s*,\s*m\s*-\s*1\s*-/.test(src) || /y\s*\*\s*12\s*\+\s*\(\s*m\s*-\s*1\s*\)/.test(src);
      })
      .map((f) => path.relative(SRC, f))
      .sort();
    expect(declaring).toEqual(["lib/entityFacts.ts"]);
  });
});
