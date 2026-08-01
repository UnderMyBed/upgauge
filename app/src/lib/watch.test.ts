import { describe, expect, it } from "vitest";
import { presetBySlug, PRESETS, rawRowsPermalink, routeCellHref, runPreset } from "./watch";

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

// No skip guard, same as db.test.ts -- vitest.config.ts sets UPGAUGE_ROOT for exactly this,
// and runPreset resolves its .sql directory the same way db.ts/sitemap.ts do.
//
// This is what closes the gap the Python real-data test
// (test_the_gauge_floor_excludes_the_bush_and_sightseeing_operators in
// pipeline/tests/test_route_health_real_data.py) cannot: that test runs its OWN hardcoded SQL
// against mart_route_health, never reads watch_empty_planes.sql, and stays green even if that
// file's `AND gauge_t12 >= 50` clause is deleted (confirmed by running the mutant --
// task-5-report.md). These two tests go through runPreset(), so they exercise the real .sql
// file on disk.
describe("runPreset (real database)", () => {
  it("Empty Planes' gauge floor excludes sub-CRJ-200 aircraft", async () => {
    const p = presetBySlug("empty-planes")!;
    const rows = await runPreset(p, "asc", 1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].gauge_t12 as number).toBeGreaterThanOrEqual(50);
  });

  // Task 6 finding: watch_gauge.sql's own header comment mentions the `{{DIRECTION}}` token
  // by name to explain it, which is a second textual occurrence of that literal string --
  // substituteDirection()'s naive occurrence count previously treated it as a candidate
  // substitution site and threw "expected at most one {{DIRECTION}} token, found 2" on EVERY
  // call for this preset, in either direction. Gauge Watch is the only preset with two
  // directions and the only one whose SQL carries the token at all, so no other test in this
  // file exercises this path -- these two are what would have caught the bug before it shipped.
  it("Gauge Watch's runPreset() succeeds in both directions, not just when SQL has no token", async () => {
    const p = presetBySlug("gauge")!;
    const desc = await runPreset(p, "desc", 5);
    const asc = await runPreset(p, "asc", 5);
    expect(desc.length).toBeGreaterThan(0);
    expect(asc.length).toBeGreaterThan(0);
  });

  it("Gauge Watch's two directions actually sort oppositely, not the same way twice", async () => {
    // Passing the test above with a DIRECTION_SQL bug that maps both "asc" and "desc" to the
    // same keyword would still return non-empty rows -- this is the test that catches THAT
    // failure mode specifically, by comparing the two result sets' leading gauge_delta.
    const p = presetBySlug("gauge")!;
    const desc = await runPreset(p, "desc", 1);
    const asc = await runPreset(p, "asc", 1);
    expect(desc[0].gauge_delta as number).toBeGreaterThan(asc[0].gauge_delta as number);
  });

  it("Death Watch's gauge floor excludes sub-CRJ-200 aircraft", async () => {
    // Same clause (`gauge_t12 >= 50`), same reason, in watch_death_watch.sql -- equally cheap
    // to cover through the same mechanism, so it gets the same test rather than resting on
    // the Empty Planes coverage alone.
    //
    // limit 5, not 1: unlike Empty Planes (sorted BY the measure the floor bounds), Death
    // Watch sorts by health_score, which is only weakly correlated with gauge size -- on this
    // warehouse the single worst-health_score row already happens to clear 50 seats, so a
    // limit-1 version of this test does not go red when the floor is deleted (verified by
    // running that exact mutant; task-5-report.md). The THIRD-worst row without the floor
    // carries gauge_t12 ~= 10.65 and would appear inside a top-5, which is what makes this
    // limit red for the right reason.
    const p = presetBySlug("death-watch")!;
    const rows = await runPreset(p, "asc", 5);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.gauge_t12 as number).toBeGreaterThanOrEqual(50);
    }
  });
});
