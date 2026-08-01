import { describe, expect, it } from "vitest";
import { presetBySlug, PRESETS, rawRowsPermalink, routeCellHref } from "./watch";

describe("presetBySlug", () => {
  it("resolves all four slugs", () => {
    for (const slug of PRESETS) expect(presetBySlug(slug)?.slug).toBe(slug);
  });
  it("returns null for an unknown slug rather than a default preset", () => {
    // The bug this catches: falling back to the first preset. /watch/nope would then render
    // Gauge Watch under the wrong name -- a silent wrong answer, which this project treats as
    // worse than an error (the permalink totality rule, features.md).
    expect(presetBySlug("nope")).toBeNull();
  });
  it("gives Gauge Watch two directions and every other preset one", () => {
    expect(presetBySlug("gauge")!.directions).toHaveLength(2);
    expect(presetBySlug("death-watch")!.directions).toHaveLength(1);
  });
  it("orders Gauge Watch's two tables oppositely", () => {
    // Asserting 'there are two tables' passes when both sort the same way, and the page still
    // renders two plausible leaderboards. Assert the DIRECTIONS differ.
    const [a, b] = presetBySlug("gauge")!.directions;
    expect(a.direction).not.toBe(b.direction);
  });
});

describe("rawRowsPermalink", () => {
  it("filters to BOTH the carrier and the route, by month", () => {
    // CLAUDE.md: every insight row is one click from the raw rows that produced it. A link
    // filtered to only the carrier shows 1,873 routes; only the route shows every carrier.
    const link = rawRowsPermalink(
      { op_airline_id: 19790, route_key_low: 12478, route_key_high: 12892 },
      "2025-05",
      "2026-04",
    );
    expect(link).toContain("op_airline_id");
    expect(link).toContain("route");
    expect(link).toContain("d=year_month");
  });
});

describe("routeCellHref", () => {
  it("links to the CODE-alphabetical canonical URL, not the displayed id order", () => {
    // THE trap. A watch row carries route_key_low/high in AIRPORT-ID order, but /route/<pair>
    // is canonicalised alphabetically BY CODE, and the two disagree for 22 of 8,009
    // cross-airport mart rows. XP USA-LAL is the measured fixture: USA holds the lower
    // airport_id but sorts AFTER LAL alphabetically.
    //
    // A JFK-LAX-shaped fixture CANNOT fail this way, which is why this test names USA/LAL. No
    // preset's top 25 contains a disagreeing pair (the earliest is rank 82), so smoke cannot
    // cover this -- only this unit test can.
    expect(routeCellHref("USA", "LAL")).toBe("/route/LAL-USA");
    expect(routeCellHref("JFK", "LAX")).toBe("/route/JFK-LAX");
  });
});
