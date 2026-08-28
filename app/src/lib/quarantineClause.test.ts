import { describe, expect, it } from "vitest";
import { quarantineClause } from "@/lib/quarantineClause";

/** FOUR CELLS, and the reason they are tested HERE rather than through four page renders: the
 * wholly-quarantined branch is unreachable on `/carrier` with today's data -- no carrier's every
 * trailing-12 filing is quarantined -- so its copy of this string could be replaced with garbage
 * while all 1,516 tests and all 663 served checks stayed green. Review found exactly that. One
 * implementation, asserted at its cells, is the only shape that closes it.
 *
 * The assertions are on the WHOLE sentence, not on its opening clause. #121's own page tests
 * asserted the opening and the row count and stopped, so the half that makes the claim honest --
 * what the counts above the sentence actually mean -- was the half nothing checked. */
const ROUTE = { subject: "on A18–LMA", counts: "The carrier count is" };

describe("quarantineClause states what the quarantined rows did to THESE numbers", () => {
  // MUTANT: return the ordinary clause here -> the page claims an exclusion from totals that do
  // not exist, under five em dashes -> red.
  it("refuses the exclusion claim when no measure can be stated", () => {
    const s = quarantineClause({ ...ROUTE, seatsAreNull: true, quarantinedRows: 1 });
    expect(s).toBe(
      "Every filing on A18–LMA in this window is quarantined — 1 row, each having failed an " +
        "invariant — so no measure above can be summed. The carrier count is counted from " +
        "those rows, not net of them.",
    );
    expect(s).not.toContain("excluded from these totals");
  });

  // THE TAIL, which is the half that says what the surviving numbers mean. The page renders
  // "Carriers 1 · Quarantined 2" on /aircraft/TRISLNDR, so "the carrier count is a count of
  // those rows" -- #121's original wording -- was false on the first grain that separated the
  // two: 1 is not 2. It is DERIVED from those rows, not a count of them.
  // MUTANT: restore "is a count of those rows, never clamped." -> red.
  it("says the counts are derived from the quarantined rows, not equal to them", () => {
    const s = quarantineClause({
      subject: "on the TRISLNDR",
      counts: "The carrier count is",
      seatsAreNull: true,
      quarantinedRows: 2,
    });
    expect(s).toContain("counted from those rows, not net of them");
    expect(s).not.toContain("is a count of those rows");
  });

  // MUTANT: drop the `quarantinedRows === 0` guard -> "Every filing ... is quarantined — 0 rows"
  // on the 11,939 route pages, 44 carriers and 36 aircraft types that simply filed nothing,
  // naming the one cause it is not -> red.
  it("says nothing when the absence has nothing to do with quarantine", () => {
    expect(quarantineClause({ ...ROUTE, seatsAreNull: true, quarantinedRows: 0 })).toBe("");
  });

  // MUTANT: gate the wholly-quarantined branch on `quarantinedRows > 0` alone -> every page
  // carrying a quarantined row beside honest traffic claims its measures cannot be summed -> red.
  it("keeps the ordinary exclusion where the totals ARE stateable", () => {
    expect(quarantineClause({ ...ROUTE, seatsAreNull: false, quarantinedRows: 118 })).toBe(
      "118 quarantined rows excluded from these totals, never clamped.",
    );
  });

  it("agrees with its own count on the plural, in both branches", () => {
    expect(quarantineClause({ ...ROUTE, seatsAreNull: true, quarantinedRows: 1 })).toContain(
      "1 row, each having",
    );
    expect(quarantineClause({ ...ROUTE, seatsAreNull: true, quarantinedRows: 5 })).toContain(
      "5 rows, each having",
    );
    expect(quarantineClause({ ...ROUTE, seatsAreNull: false, quarantinedRows: 1 })).toContain(
      "1 quarantined row excluded",
    );
  });

  // /airport is the page that states TWO counts, and the plural has to follow.
  it("carries the caller's own count line verbatim", () => {
    expect(
      quarantineClause({
        subject: "at A18",
        counts: "The carrier and destination counts are",
        seatsAreNull: true,
        quarantinedRows: 1,
      }),
    ).toContain("The carrier and destination counts are counted from those rows");
  });
});
