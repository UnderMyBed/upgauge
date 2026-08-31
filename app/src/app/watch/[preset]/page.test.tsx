// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import WatchPresetPage, { WatchPresetView, formatHealthScore } from "@/app/watch/[preset]/page";
import { presetBySlug, PRESETS } from "@/lib/watch";

/** `permanentRedirect`/`notFound` throw rather than return -- same helper, same reasoning, as
 * carrier/[code]/page.test.tsx's `catchDigest`. */
async function catchDigest(preset: string): Promise<string> {
  try {
    await WatchPresetPage({ params: Promise.resolve({ preset }) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`WatchPresetPage(${JSON.stringify(preset)}) did not throw`);
}

/** Renders a preset against the REAL database -- this codebase's usual integration-test style
 * (db.test.ts, carrier/[code]/page.test.tsx, etc. all query real data rather than mock it;
 * ExploreView's PivotError test is the one deliberate, documented exception).
 *
 * The task brief's own Step 2 example passed this a synthetic ROW list, including one with
 * `health_score: null` -- but watch_death_watch.sql filters `health_score IS NOT NULL` before
 * a row ever reaches runPreset(), so no real query can hand this page a NULL score, and a
 * mocked-row test for that case would be exercising a path production can never take. Per
 * task-6-brief.md's own resolution of this exact ambiguity: the NULL case is covered directly
 * against `formatHealthScore()` below instead, and this harness renders the real preset. */
async function renderPreset(slug: string) {
  const preset = presetBySlug(slug);
  if (preset === null) throw new Error(`no such preset: ${slug}`);
  return render(await WatchPresetView({ preset }));
}

/** The CONTENT column's text, excluding the legend rail -- same scoping, same reason, as
 * carrier/[code]/page.test.tsx's `content()`: LegendRail already carries generic prose on
 * every data view, so a test that searched the whole page could pass on a page that said
 * nothing about ITS OWN subject. */
function content(container: HTMLElement): string {
  return container.querySelector(".body > div")?.textContent ?? "";
}

describe("/watch/<preset>", () => {
  it.each(PRESETS)("renders the title and editorial frame for '%s'", async (slug) => {
    const { container } = await renderPreset(slug);
    const preset = presetBySlug(slug)!;
    expect(screen.getByText(preset.title)).toBeDefined();
    expect(content(container)).toContain(preset.frame);
  });

  // THE PRESETS ABSTAIN FROM THE DEPARTURE FLOOR, AND THAT IS THE SETTLED RULE (#134).
  //
  // #148 MADE THIS TEST REAL. It used to pass because `displayRows` did not alias the departure
  // sum, so `belowFloor` got no month count, abstained, and marked nothing -- i.e. it could not
  // fail for the reason its name claimed. `mart_route_health` now carries `t12_months_flown`,
  // the presets alias it as `active_months` beside `departures_performed`, and `belowFloor`
  // performs a real division on every row here.
  //
  // It still finds nothing below the floor, and THAT is the assertion: the mart's own admission
  // gate IS the floor (`t12_departures_performed >= 30 * t12_months_flown`), so a sub-floor
  // carrier-route pair is not in the table to be marked.
  //
  // MUTANT, and its SHAPE matters: revert the mart's gate to `t12_departures_performed >= 30`
  // (sql/02_marts/200_mart_route_health.sql) and rebuild. 2,454 sub-floor pairs come back and
  // this test reddens on 'gauge', 'empty-planes' and 'death-watch' while staying GREEN on
  // 'new-routes' -- measured by running exactly that mutant. The green one is not a gap: Route
  // Birth Tracker ranks by `t12_seats` DESC, so its top 25 are the largest rows in the
  // qualifying set and sit far above any departure floor. A UNIFORM red across all four would
  // mean something other than the floor broke, and is the result to distrust.
  //
  // BOTH HALVES ARE ASSERTED, because they fail independently: no row takes the below-floor
  // TREATMENT, and every rank is a NUMBER (a withheld rank renders an em dash). A mark without
  // a partition, or a partition without a mark, satisfies exactly one of them.
  it.each(PRESETS)("marks no row below the departure floor on '%s'", async (slug) => {
    const { container } = await renderPreset(slug);
    const rows = [...container.querySelectorAll("table.data-table tbody tr")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((tr) => tr.getAttribute("data-below-floor") === "true")).toHaveLength(0);
    const ranks = [...container.querySelectorAll('[data-testid="rank-cell"]')].map(
      (n) => n.textContent,
    );
    expect(ranks.length).toBe(rows.length);
    expect(ranks.filter((r) => r === "\u2014")).toHaveLength(0);
  });

  it("shows DATA AS OF", async () => {
    await renderPreset("gauge");
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("shows the legend rail", async () => {
    await renderPreset("gauge");
    expect(screen.getByText("Chart legend")).toBeDefined();
  });

  it("renders one ranked table per declared direction -- two for Gauge Watch, one for the rest", async () => {
    const { container: gaugeContainer } = await renderPreset("gauge");
    expect(gaugeContainer.querySelectorAll("table").length).toBe(2);
    expect(screen.getByText("Upgauging")).toBeDefined();
    expect(screen.getByText("Downgauging")).toBeDefined();
    const rankCells = gaugeContainer.querySelectorAll('[data-testid="rank-cell"]');
    expect(rankCells.length).toBeGreaterThan(0);
    expect(rankCells[0]?.textContent).toBe("1");

    const { container: deathContainer } = await renderPreset("death-watch");
    expect(deathContainer.querySelectorAll("table").length).toBe(1);
  });

  it("shows the health-score components, not just the composite", async () => {
    // system.md's "/watch leaderboard": "the components are the insight, the score is a sort
    // key" -- a table that showed health_score alone would satisfy "shows a score" while
    // hiding the thing the docs call the actual insight.
    const { container } = await renderPreset("death-watch");
    const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers.some((h) => /health score/i.test(h ?? ""))).toBe(true);
    expect(headers.some((h) => /load factor/i.test(h ?? ""))).toBe(true);
    expect(headers.some((h) => /gauge/i.test(h ?? ""))).toBe(true);
    expect(headers.some((h) => /capacity/i.test(h ?? ""))).toBe(true);
    expect(headers.some((h) => /frequency/i.test(h ?? ""))).toBe(true);
    expect(headers.some((h) => /completion/i.test(h ?? ""))).toBe(true);
  });

  it("labels the score plainly as a heuristic", async () => {
    const { container } = await renderPreset("death-watch");
    expect(content(container)).toMatch(/heuristic/i);
  });

  // Review finding (Task 6): formatHealthScore()'s own unit tests below cover the NULL branch
  // in isolation, and the brief's Step 2 test would have covered it through a synthetic
  // Death Watch row that watch_death_watch.sql can never actually produce (its own `WHERE
  // health_score IS NOT NULL` excludes it). Neither proves the path that actually fires in
  // production: Route Birth Tracker's `p12_months_present = 0` filter means EVERY one of its
  // 297 rows has a NULL health_score (measured against the real warehouse -- 297 of 297, 100%),
  // so "insufficient data" is not an edge case on this preset, it is the entire page, reached
  // through the REAL column-building path (buildColumns -> displayRows -> DataTable), not a
  // direct call to the helper. A regression here -- an accidental dimKey or href on the
  // __health_score column, or the column reading the raw `health_score` field instead of the
  // pre-formatted `__health_score` one -- would leak `null`, an em-dash, or a bare "null" string
  // into shipped HTML on every Birth Tracker request, and nothing else in this suite would
  // notice.
  it("renders 'insufficient data' end-to-end on Birth Tracker, whose rows are ALL null-scored", async () => {
    const { container } = await renderPreset("new-routes");
    const table = container.querySelector("table");
    expect(table).not.toBeNull();

    const headers = [...table!.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
    const scoreIndex = headers.findIndex((h) => /health score/i.test(h));
    expect(scoreIndex).toBeGreaterThan(-1);

    const rows = [...table!.querySelectorAll("tbody tr")];
    // Not just "some rows" -- Birth Tracker's whole premise (p12_months_present = 0) means
    // every row qualifies, so anything less than 100% would itself be a finding.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cell = row.querySelectorAll("td")[scoreIndex];
      const text = cell?.textContent ?? "";
      expect(text).toBe("insufficient data");
      expect(text).not.toContain("null");
      expect(text).not.toContain("—");
    }
  });

  it("links every row to its raw rows in the Explorer", async () => {
    await renderPreset("gauge");
    const links = screen.getAllByRole("link", { name: "Explorer" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      expect(href.startsWith("/explore?")).toBe(true);
      expect(href).toContain("op_airline_id");
      expect(href).toContain("d=year_month");
    }
  });

  it("renders a route cell as two codes joined by an en dash, linked into /route/", async () => {
    const { container } = await renderPreset("gauge");
    expect(screen.getAllByText(/^[A-Z0-9]{3}–[A-Z0-9]{3}$/).length).toBeGreaterThan(0);
    expect(container.querySelector('a[href^="/route/"]')).not.toBeNull();
  });

  it("states the same-airport exclusion (6 of 5,611) on every preset", async () => {
    for (const slug of PRESETS) {
      const { container } = await renderPreset(slug);
      expect(content(container)).toContain("6 of 5,611");
    }
  });

  // The brief's own Step 2 test asserted `toContain("50")` against the WHOLE page. Run as a
  // mutant (task-6-report.md): deleting the floor sentence entirely left this test GREEN,
  // because the table itself renders 25 rows of real gauge/seat/percentage figures, and at
  // least one of them contains the substring "50" by coincidence (e.g. a gauge value like
  // "150.3" or a load factor like "50.97%") on every real render. That is exactly the failure
  // mode CLAUDE.md's "Run the mutant" section names: an assertion that passes for a reason
  // other than the one it claims to test. Anchored here to the note's own distinguishing text
  // instead, which the coincidental "50" cannot satisfy.
  it("states the gauge floor rather than hiding it", async () => {
    const { container } = await renderPreset("empty-planes");
    const text = content(container);
    expect(text).toMatch(/excluded from this leaderboard/i);
    expect(text).toContain("50");
  });

  it("also states the gauge floor on Death Watch", async () => {
    const { container } = await renderPreset("death-watch");
    const text = content(container);
    expect(text).toMatch(/excluded from this leaderboard/i);
    expect(text).toContain("50");
  });

  it("does not claim a gauge floor on presets that have none", async () => {
    // The pair the test above needs: a preset that DOES declare the floor is not proof of
    // anything if every preset prints the same sentence regardless of its own SQL.
    const { container: gaugeContainer } = await renderPreset("gauge");
    const { container: newRoutesContainer } = await renderPreset("new-routes");
    expect(content(gaugeContainer)).not.toMatch(/excluded from this leaderboard/i);
    expect(content(newRoutesContainer)).not.toMatch(/excluded from this leaderboard/i);
  });

  it("states that unscored routes are excluded from Death Watch, not silently ranked worst", async () => {
    const { container } = await renderPreset("death-watch");
    expect(content(container)).toContain("373 of 5,611");
  });

  // Final whole-branch review (M6), CRITICAL. This test previously read:
  //
  //     it("says 'since 2015', never 'first ever'", ...)
  //       expect(content(container)).toContain("since 2015");
  //
  // -- and it PINNED A FALSE CLAIM. The Task-6 brief asked for "first appearance since 2015"
  // and this test enforced it, so the eighth test in this milestone unable to fail for the
  // reason it names: it asserted a phrase, not a fact, and the phrase was wrong.
  // watch_new_routes.sql selects `p12_months_present = 0` -- nothing filed in the PRIOR 12
  // months -- which is a re-entry, not a first appearance. Measured on the 2026-05 warehouse:
  // 174 of 297 qualifying rows (58.6%) filed before that window, 19 of the 25 the page renders,
  // worst case B6 AUS-FLL at 106 distinct months back to 2015-01.
  //
  // The replacement asserts the accurate claim AND the absence of the false one -- the pair is
  // the point. `toContain("...first appearance")` alone would still pass against the old
  // wording ("First appearance since 2015"), which is exactly how the original slipped through.
  it("states re-entry, not first appearance, and never claims 'since 2015'", async () => {
    const { container } = await renderPreset("new-routes");
    const text = content(container);
    expect(text).toContain("not necessarily a first appearance");
    expect(text).toContain("Re-entry, not first appearance");
    expect(text).toContain("174 of the 297");
    expect(text).not.toContain("since 2015");
    expect(text).not.toContain("first ever");
  });

  // Re-review of the fix wave above: that wave introduced a NEW false claim of the same class
  // it was closing. `mart_route_health`'s grain is (op_airline_id, route) -- a carrier-route
  // pair -- so `p12_months_present = 0` is silent about every OTHER carrier on the same airport
  // pair. Two strings described it at ROUTE grain: the frame's "nobody flew last year" (carried
  // over from the original sentence unexamined, because it read as its accurate half) and
  // ReEntryNote's "A route qualifies by...". Measured: 245 of the 297 qualifying rows (82.5%),
  // and 25 of the 25 the page renders, had a different carrier flying that pair inside the p12
  // window -- the #1 row AS HNL-ITO while HA, UA and WN filed 1,786,963 seats on it, 3.7x the
  // subject's own trailing 12. So the claim was false about EVERY row on the page.
  //
  // Both directions, as always: the carrier-grain phrasing present AND the two route-grain
  // phrasings that actually shipped absent. `not.toContain("nobody flew")` is the sharper of
  // the two negatives -- it is the exact string, and nothing else on this page can produce it.
  it("states the carrier-route grain, never route grain", async () => {
    const { container } = await renderPreset("new-routes");
    const text = content(container);
    expect(text).toContain("this carrier flew nothing on");
    expect(text).toContain("this carrier filed nothing at all on this route");
    expect(text).toContain("245 of the 297");
    expect(text).not.toContain("nobody flew");
    expect(text).not.toMatch(/\bA route qualifies\b/);
  });

  it("states the prior-12 window it actually tests, derived from asOf rather than written out", async () => {
    // The window moves every monthly rebuild. A hardcoded "2024-05 to 2025-04" would be a
    // second false claim on the same page one rebuild later, so ReEntryNote computes it --
    // this pins that it is computed AND consistent with the DATA AS OF badge the page shows.
    const { container } = await renderPreset("new-routes");
    const asOf = screen.getByText(/DATA AS OF/).textContent!.replace("DATA AS OF ", "").trim();
    const [y, m] = asOf.split("-").map(Number);
    const fmt = (n: number) => {
      const d = new Date(Date.UTC(y, m - 1 - n, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    expect(content(container)).toContain(`prior 12 months (${fmt(23)} to ${fmt(12)})`);
  });

  it("does not claim re-entry framing on the three presets that do not select for it", async () => {
    // The pair the two tests above need: a note that appears on every preset proves nothing
    // about the one preset whose SQL it describes.
    for (const slug of ["gauge", "empty-planes", "death-watch"] as const) {
      const { container } = await renderPreset(slug);
      expect(content(container)).not.toContain("Re-entry, not first appearance");
    }
  });

  // #148 INVERTED THIS TEST'S SUBJECT, so read the name before the assertions. Empty Planes
  // used to carry a SECOND floor of its own -- `t12_departures_performed >= 360`, a flat annual
  // total -- and this test pinned that it appeared there and nowhere else. That predicate is
  // deleted: it was the flat-total reading #134 ruled wrong, and it was a strict subset of
  // mart_route_health's own gate, so restating it as a rate would have removed no row.
  //
  // The departure floor is now the MART's, so it holds on all four presets and the note says so
  // on all four. The gauge floor is what stays per-preset, and Route Birth Tracker is the
  // falsifying half -- its SQL carries no gauge floor, so a note printed on every preset would
  // be as wrong as printing none.
  //
  // The needles are anchored on each note's OWN distinguishing words, never on bare digits:
  // this suite already learned (the "50" mutant, task-6-report.md) that a 25-row table of real
  // seat counts contains any three-digit substring by coincidence -- "360" appeared inside a
  // rendered `t12_seats` of 360,442 on its own, which is also why the check that the 360 claim
  // is GONE is written against its sentence and not against the number.
  it("states the mart's departure floor on every preset, and the gauge floor only where it applies", async () => {
    for (const slug of ["gauge", "empty-planes", "death-watch", "new-routes"] as const) {
      const text = content((await renderPreset(slug)).container);
      expect(text).toContain("30 performed departures per month flown");
      expect(text).not.toContain("360 performed departures");
      expect(text).not.toContain("t12_departures_performed >= 360");
    }

    const empty = content((await renderPreset("empty-planes")).container);
    expect(empty).toMatch(/excluded from this leaderboard/i);
    expect(empty).toContain("gauge_t12 >= 50");

    const born = content((await renderPreset("new-routes")).container);
    expect(born).not.toContain("gauge_t12 >= 50");
  });

  it("404s an unknown preset rather than falling back to a default one", async () => {
    expect(await catchDigest("nope")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

// The ambiguity resolution: NULL handling lives in the score-rendering helper, tested directly
// -- watch_death_watch.sql's `health_score IS NOT NULL` filter means no real query can ever
// hand a page a NULL score, so this is the only place the null branch is reachable at all.
describe("formatHealthScore", () => {
  it("renders NULL as insufficient data, never an em-dash and never 'unhealthy'", () => {
    // features.md's standing UI requirement: all 373 NULL carrier-route pairs are NULL for
    // data-availability reasons, not low-score reasons, and an em-dash in a column sorted
    // ascending reads as 'worst'.
    expect(formatHealthScore(null)).toBe("insufficient data");
  });

  it("renders undefined the same way as null", () => {
    expect(formatHealthScore(undefined)).toBe("insufficient data");
  });

  it("renders a real score to two fixed decimals", () => {
    expect(formatHealthScore(-1.234567)).toBe("-1.23");
    expect(formatHealthScore(0.5)).toBe("0.50");
  });

  it("renders exactly zero as a real score, never as insufficient data", () => {
    // 0 is a legitimate (if unlikely) composite value -- `v === null` must not be written as
    // `!v`, which would swallow it.
    expect(formatHealthScore(0)).toBe("0.00");
  });
});
