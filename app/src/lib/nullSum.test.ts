import { describe, expect, it } from "vitest";
import { addSum, numOrNull, ratio, sumColumn } from "@/lib/nullSum";

/** THE RULE THESE PIN: a FILTERed SUM that came back NULL must still be NULL after TypeScript
 * has folded it. Every assertion below is on the VALUE, never on "a value is present" -- the
 * buggy form produces a number at every one of these call sites, so an existence assertion
 * passes under the bug it was written to catch. */

describe("addSum has SUM() semantics, not `+` semantics", () => {
  // MUTANT: `return (a ?? 0) + (b ?? 0)` -> red on the first two.
  it("treats a NULL as contributing nothing, on either side", () => {
    expect(addSum(null, 5)).toBe(5);
    expect(addSum(5, null)).toBe(5);
  });

  // MUTANT: `if (a === null || b === null) return null` (NULL-poisoning) -> red.
  // Poisoning is the opposite error: it would erase the honest figures of every entity that
  // carries one quarantined group beside real traffic.
  it("sums the known values when only some are absent", () => {
    expect(addSum(3, 4)).toBe(7);
  });

  // MUTANT: seed/short-circuit returning 0 for the both-absent case -> red.
  it("is NULL only when nothing known was added", () => {
    expect(addSum(null, null)).toBeNull();
  });

  // A real filed zero is a measurement and must survive as one.
  // MUTANT: `if (!a) return b` -> red (0 is falsy, so the left operand would vanish).
  it("keeps a filed zero, which is a measurement and not an absence", () => {
    expect(addSum(0, null)).toBe(0);
    expect(addSum(null, 0)).toBe(0);
    expect(addSum(0, 5)).toBe(5);
  });
});

describe("ratio refuses to invent a quotient", () => {
  it("divides when both inputs are known", () => {
    expect(ratio(90, 100)).toBe(0.9);
  });

  // MUTANT: drop the two null guards and type the params `number` -> `null / null` is NaN,
  // which formatGauge renders as the literal string "NaN" under a DATA AS OF badge. Asserting
  // `toBeNull()` reddens; asserting "is not a number" would NOT, since NaN is a number.
  it("is NULL when the numerator is unknowable", () => {
    expect(ratio(null, 100)).toBeNull();
  });

  it("is NULL when the denominator is unknowable", () => {
    expect(ratio(100, null)).toBeNull();
    expect(ratio(null, null)).toBeNull();
  });

  // MUTANT: drop `denominator === 0` -> returns Infinity -> red.
  it("is NULL when the denominator is a measured zero", () => {
    expect(ratio(100, 0)).toBeNull();
  });

  // A zero numerator over a real denominator flew and carried nobody. That is a fact.
  // MUTANT: guarding on `!numerator` -> red.
  it("states a measured zero rather than erasing it", () => {
    expect(ratio(0, 100)).toBe(0);
  });
});

describe("numOrNull tests the absence before the conversion", () => {
  // MUTANT: `Number(v ?? 0)` or `Number(v)` -> Number(null) is 0 -> red.
  it("keeps null and undefined absent", () => {
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
  });

  // MUTANT: `v ? Number(v) : null` -> a filed zero becomes an absence -> red. This is the same
  // error in the other direction and is just as wrong.
  it("keeps a filed zero as zero", () => {
    expect(numOrNull(0)).toBe(0);
  });

  it("converts what the DuckDB driver hands back", () => {
    expect(numOrNull(1234)).toBe(1234);
    expect(numOrNull("1234")).toBe(1234);
  });
});

describe("sumColumn folds a pivot column with SUM semantics end to end", () => {
  // THE SEED, which is the half with the widest footprint: 12,115 route pairs are fact-present
  // and filed nothing inside the trailing 12, and this is the branch they take.
  // MUTANT: seed the reduce at `0` instead of `null` -> red.
  it("is NULL over no rows at all", () => {
    expect(sumColumn([], "seats")).toBeNull();
  });

  // MUTANT A: `numOrNull(r[key] ?? 0)` (the `?? 0` restored) -> 0 -> red.
  // MUTANT B: `rows.reduce((a, r) => a + Number(r[key]), 0)` (the `??` removed but the fold
  // left on `+`) -> also 0 -> red. Two different mutants, both killed by this one assertion,
  // and issue #121 exists because fixing only the first leaves the second.
  it("is NULL when every contributing row was quarantined", () => {
    const rows = [{ seats: null }, { seats: null }];
    expect(sumColumn(rows, "seats")).toBeNull();
  });

  // MUTANT: NULL-poisoning in addSum -> red. A row that could not be stated must not erase the
  // rows that could.
  it("sums the known rows and ignores the unknowable ones", () => {
    const rows = [{ seats: 100 }, { seats: null }, { seats: 25 }];
    expect(sumColumn(rows, "seats")).toBe(125);
  });

  // A column the pivot did not select is absent, not zero.
  it("is NULL for a key no row carries", () => {
    expect(sumColumn([{ seats: 100 }], "passengers")).toBeNull();
  });

  // MUTANT: `numOrNull` guarding on truthiness -> red. Every row filing a real 0 is a
  // measurement of zero, which is what the 10 wholly-quarantined route pairs are NOT.
  it("keeps a column of measured zeroes as zero", () => {
    expect(sumColumn([{ seats: 0 }, { seats: 0 }], "seats")).toBe(0);
  });
});
