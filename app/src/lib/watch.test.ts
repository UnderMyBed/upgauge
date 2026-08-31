import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  maskComments,
  presetBySlug,
  PRESETS,
  rawRowsPermalink,
  routeCellHref,
  runPreset,
  type WatchRow,
} from "./watch";

// Review finding (Task 6): the fix for the {{DIRECTION}}-in-a-comment bug below originally
// stripped only "--" line comments. Block comments and a "--"/"/*" embedded inside a
// single-quoted string literal are the same failure shape, one syntax variant away -- no
// watch_*.sql file uses either today, so neither was a live bug, but both are now closed
// (maskComments) rather than merely documented, and pinned here against synthetic fixtures
// since no real .sql file needs to exercise them yet.
describe("maskComments", () => {
  it("masks a line comment, leaving real code before it untouched", () => {
    const masked = maskComments("ORDER BY x {{DIRECTION}} -- explains {{DIRECTION}} here");
    expect(masked.split("{{DIRECTION}}").length - 1).toBe(1);
    expect(masked).toContain("ORDER BY x {{DIRECTION}}");
  });

  it("masks a block comment too, not just a line comment", () => {
    // The exact shape of the bug this whole function exists to fix, just with /* */ instead of
    // -- : a comment that mentions the token by name, ahead of the token's real use.
    const sql = "/* {{DIRECTION}} is explained here */\nORDER BY x {{DIRECTION}}";
    const masked = maskComments(sql);
    expect(masked.split("{{DIRECTION}}").length - 1).toBe(1);
    expect(masked).toContain("ORDER BY x {{DIRECTION}}");
  });

  it("masks a MULTI-LINE block comment, preserving newlines so indices stay valid", () => {
    const sql = "/* line one\n   {{DIRECTION}} mentioned mid-comment\n   line three */\nORDER BY x {{DIRECTION}}";
    const masked = maskComments(sql);
    expect(masked.split("{{DIRECTION}}").length - 1).toBe(1);
    expect(masked.split("\n").length).toBe(sql.split("\n").length);
  });

  it("does not mistake a '--' inside a single-quoted string literal for a comment", () => {
    // Without string-awareness, a naive `indexOf("--")` finds the one INSIDE the string first
    // and masks from there to end of line -- hiding the real token that follows on the same
    // line, and returning `statement` UNCHANGED (occurrences === 0), which is a silent no-op,
    // not even a thrown error.
    const sql = "SELECT '--not a comment' AS marker, x ORDER BY x {{DIRECTION}}";
    const masked = maskComments(sql);
    expect(masked.split("{{DIRECTION}}").length - 1).toBe(1);
    expect(masked).toContain("SELECT '--not a comment' AS marker");
  });

  it("does not mistake a doubled '' escape for leaving the string early", () => {
    const sql = "SELECT 'it''s -- not a comment' AS marker, x ORDER BY x {{DIRECTION}}";
    const masked = maskComments(sql);
    expect(masked.split("{{DIRECTION}}").length - 1).toBe(1);
  });

  it("is length-preserving, so a located index stays valid against the original text", () => {
    const sql = "-- header\nSELECT 1 -- trailing\nORDER BY x {{DIRECTION}}";
    expect(maskComments(sql).length).toBe(sql.length);
  });
});

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

// ---------------------------------------------------------------------------------------
// Deterministic preset ordering (#144) -- the same class of gap #136 closed for the pivot
// templates, reaching the four /watch presets through their own query files.
//
// Each preset ranked on ONE column and stopped. Rows tying on it AT THE LIMIT BOUNDARY were
// therefore returned in DuckDB's merge order rather than by the query, so which of a tied set
// renders was unspecified -- on a permalinked surface with a rank column. The fix appends
// mart_route_health's whole grain, (op_airline_id, route_key_low, route_key_high), which is
// unique per row of that table and which these queries neither join nor aggregate away.
//
// THE GRAIN IS A CARRIER-ROUTE PAIR, NEVER A ROUTE, and the tiebreak has to carry both halves:
// gauge_delta = 0.0 is a single tie run of 887 rows spanning 39 carriers and 800 distinct route
// pairs, inside which 87 pairs repeat under a DIFFERENT carrier. A fixture keyed on route alone
// passes against the very bug these tests exist to catch.

const QUERIES_DIR = path.join(process.env.UPGAUGE_ROOT ?? process.cwd(), "sql", "03_queries");

const GRAIN = ["op_airline_id", "route_key_low", "route_key_high"] as const;

/** The ORDER BY terms of a preset's .sql, direction keywords stripped.
 *
 * Read off the MASKED text, not the raw file: watch_gauge.sql's header explains the direction
 * token by name, and a scan that counted comment lines would be reading prose. The direction
 * token itself is stripped as a keyword rather than substituted, so this helper never hand-rolls
 * the first-vs-all replace() that substituteDirection() exists to get right -- what the
 * SUBSTITUTED text does is covered by the real-database tests below, which go through
 * runPreset(). */
function orderByTerms(file: string): string[] {
  const masked = maskComments(readFileSync(path.join(QUERIES_DIR, `${file}.sql`), "utf8"));
  const lines = masked.split("\n").filter((l) => l.startsWith("ORDER BY "));
  if (lines.length !== 1) {
    throw new Error(`${file}.sql: expected exactly one ORDER BY line, found ${lines.length}`);
  }
  const clause = lines[0].slice("ORDER BY ".length);

  // Top-level commas only. No preset carries a parenthesised ORDER BY term today; splitting
  // depth-aware anyway means a future coalesce(a, b) term is one term, not two, rather than
  // quietly turning every assertion below into a comparison against nonsense.
  const terms: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of clause) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      terms.push(buf.trim());
      buf = "";
    } else buf += ch;
  }
  if (buf.trim()) terms.push(buf.trim());

  return terms.map((t) => {
    let out = t;
    for (const suffix of [" NULLS LAST", " NULLS FIRST", " DESC", " ASC", " {{DIRECTION}}"]) {
      if (out.endsWith(suffix)) out = out.slice(0, -suffix.length);
    }
    return out.trim();
  });
}

const PRESET_FILES = [
  { file: "watch_new_routes", ranked: "t12_seats" },
  { file: "watch_death_watch", ranked: "health_score" },
  { file: "watch_empty_planes", ranked: "lf_t12" },
  { file: "watch_gauge", ranked: "gauge_delta" },
] as const;

describe("preset ORDER BY", () => {
  // PROPERTY ONE: totality. Dies to dropping the tiebreak from any one file, and -- the case
  // that matters -- to keeping only the route pair and dropping op_airline_id.
  it.each(PRESET_FILES)(
    "$file carries every grain column, so the ordering is total",
    ({ file }) => {
      const terms = orderByTerms(file);
      const missing = GRAIN.filter((c) => !terms.includes(c));
      expect(
        missing,
        `${file}.sql: grain columns ${missing.join(", ")} never reach ORDER BY, so rows tying ` +
          `on ${terms[0]} at the LIMIT boundary are ordered by DuckDB merge order. ` +
          `ORDER BY = ${terms.join(", ")}`,
      ).toEqual([]);
    },
  );

  // PROPERTY TWO, and a SEPARATE test because it is a separate property: the tiebreak is a
  // SUFFIX. Sorting the grain first would make every preset rank by carrier id, and the
  // containment test above would stay green while it did. Neither test covers for the other.
  it.each(PRESET_FILES)("$file still ranks on $ranked, the tiebreak only breaking ties", ({
    file,
    ranked,
  }) => {
    expect(orderByTerms(file)[0]).toBe(ranked);
  });
});

// Any limit above mart_route_health's 8,065 rows returns a preset's whole qualifying set, so
// this is not a window a warehouse refresh can slide a tie group out of.
const WHOLE_QUALIFYING_SET = 100_000;

/** Runs of CONSECUTIVE rows sharing a ranked value -- DuckDB's own tie semantics, since the
 * value arrives as a double and String() round-trips a double exactly. */
function tieRuns(rows: WatchRow[], ranked: string): WatchRow[][] {
  const runs: WatchRow[][] = [];
  let current: WatchRow[] = [];
  let key: string | null = null;
  for (const row of rows) {
    const k = String(row[ranked]);
    if (k === key) current.push(row);
    else {
      if (current.length > 1) runs.push(current);
      current = [row];
      key = k;
    }
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

// The executed counterpart of the two text properties above: this runs the real .sql through
// runPreset() against the real database, so it covers the SUBSTITUTED bytes watch_gauge.sql
// sends to DuckDB, which no text assertion can reach.
//
// NOT parameterized over empty-planes, deliberately. That preset has ZERO tie runs in its 4,452
// qualifying rows on this warehouse, so a case for it would assert over an empty list -- the
// vacuous fixture, passing against the bug. Its cover is the ORDER BY property tests above. A
// future warehouse that gives it a tie is a reason to ADD a case here, never evidence one was
// wrongly missing.
describe("runPreset ties (real database)", () => {
  it.each([
    { name: "gauge upgauging", slug: "gauge", direction: "desc", ranked: "gauge_delta" },
    { name: "gauge downgauging", slug: "gauge", direction: "asc", ranked: "gauge_delta" },
    { name: "new-routes", slug: "new-routes", direction: "desc", ranked: "t12_seats" },
    { name: "death-watch", slug: "death-watch", direction: "asc", ranked: "health_score" },
  ] as const)("$name: tied rows come back in ascending grain order", async ({
    slug,
    direction,
    ranked,
  }) => {
    const rows = await runPreset(presetBySlug(slug)!, direction, WHOLE_QUALIFYING_SET);
    const runs = tieRuns(rows, ranked);

    // Fail LOUD rather than pass over an empty list: a fixture that no longer exercises a tie
    // is not evidence the ordering is total, it is evidence this test stopped testing.
    expect(
      runs.length,
      `${slug}/${direction}: no two rows tie on ${ranked} in ${rows.length} rows, so this ` +
        "test no longer exercises the tiebreak at all -- find a preset that does before " +
        "trusting this case.",
    ).toBeGreaterThan(0);

    for (const run of runs) {
      const grain = run.map((r) => GRAIN.map((c) => r[c] as number));
      const sorted = [...grain].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      expect(
        grain,
        `${slug}/${direction}: ${run.length} rows tie at ${ranked} = ${String(run[0][ranked])} ` +
          "and did not come back in ascending (op_airline_id, route_key_low, route_key_high) " +
          "order, so which of them a LIMIT keeps is decided by DuckDB, not by the query.",
      ).toEqual(sorted);
    }
  });
});
