import { describe, expect, it } from "vitest";
import { EARLIEST_YEAR, parseYear, yearTrack, yearWindow } from "@/lib/year";

describe("parseYear", () => {
  it("treats a missing y as the default trailing-12 view", () => {
    expect(parseYear(null)).toEqual({ kind: "default" });
  });

  it("rejects a year outside the data window", () => {
    // Catches: accepting any 4-digit string, which makes ?y=<random> an unbounded
    // shared-cache key -- /search's cache-fill vector arriving on a page route.
    expect(parseYear("1999").kind).toBe("invalid");
    expect(parseYear("nonsense").kind).toBe("invalid");
    expect(parseYear("2019")).toEqual({ kind: "year", year: 2019 });
  });

  it("rejects a year one before EARLIEST_YEAR, exactly at the boundary", () => {
    // A test built on 1999 alone would also pass an implementation that merely rejects
    // "obviously old" years by magnitude rather than checking the real boundary -- this pins
    // the boundary itself, at EARLIEST_YEAR - 1, and confirms EARLIEST_YEAR itself is valid.
    expect(parseYear(String(EARLIEST_YEAR - 1)).kind).toBe("invalid");
    expect(parseYear(String(EARLIEST_YEAR))).toEqual({ kind: "year", year: EARLIEST_YEAR });
  });

  it("rejects a year far in the future, not just years before 2015", () => {
    // A mutant that widens the accepted set to "any 4-digit string >= EARLIEST_YEAR" (dropping
    // only the lower bound's counterpart) would still pass every test above. This is the
    // other half: BTS cannot have filed data for a year past the real calendar.
    expect(parseYear("9999").kind).toBe("invalid");
  });

  it("rejects malformed input that is not a bare four-digit numeral", () => {
    expect(parseYear("").kind).toBe("invalid");
    expect(parseYear("20").kind).toBe("invalid");
    expect(parseYear("20199").kind).toBe("invalid");
    expect(parseYear("2019.5").kind).toBe("invalid");
    expect(parseYear("-2019").kind).toBe("invalid");
    expect(parseYear("2019 ").kind).toBe("invalid");
  });

  it("echoes the raw string back on an invalid year, for the named error", () => {
    expect(parseYear("1999")).toEqual({ kind: "invalid", raw: "1999" });
  });
});

describe("yearWindow", () => {
  it("maps a year to its bare calendar-year window", () => {
    expect(yearWindow(2019)).toEqual({ from: "2019-01", to: "2019-12" });
  });

  it("is not clamped to any asOf -- that is the caller's job", () => {
    // yearWindow takes no asOf parameter at all (this file's own contract); a future year's
    // window still comes back as Jan-Dec, and a query run over it simply returns no rows past
    // whatever the warehouse actually has -- the same "no filing yet" shape every other query
    // here already handles.
    expect(yearWindow(2026)).toEqual({ from: "2026-01", to: "2026-12" });
  });
});

describe("yearTrack", () => {
  it("marks 2026 partial and 2025 complete", () => {
    // Catches: presenting a 4-month year identically to a 12-month one. The data window ends
    // 2026-04. A 2026 tick that looks like a 2025 tick claims a full year that does not exist
    // -- the same class of false claim as M6's "First appearance since 2015".
    const track = yearTrack("2026-04");
    expect(track.find((t) => t.year === 2026)!.partial).toBe(true);
    expect(track.find((t) => t.year === 2025)!.partial).toBe(false);
  });

  it("spans EARLIEST_YEAR through asOf's own year, inclusive", () => {
    const track = yearTrack("2026-04");
    expect(track.map((t) => t.year)).toEqual(
      Array.from({ length: 2026 - EARLIEST_YEAR + 1 }, (_, i) => EARLIEST_YEAR + i),
    );
  });

  it("marks EARLIEST_YEAR itself complete, not partial", () => {
    // A mutant that marks every year partial (or marks the FIRST year partial by an
    // off-by-one on the loop) would still pass the 2026-vs-2025 test above.
    const track = yearTrack("2026-04");
    expect(track.find((t) => t.year === EARLIEST_YEAR)!.partial).toBe(false);
  });

  it("marks the current year complete when asOf falls in December", () => {
    // The partial flag is about the MONTH, not "is this the last year in the track" -- a
    // December asOf means a genuinely complete calendar year, and the track must say so.
    const track = yearTrack("2025-12");
    expect(track.find((t) => t.year === 2025)!.partial).toBe(false);
  });
});
