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
  // 688 rows has a NULL health_score (measured against the real warehouse -- 688 of 688, 100%),
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

  it("states the same-airport exclusion (71 of 8,080) on every preset", async () => {
    for (const slug of PRESETS) {
      const { container } = await renderPreset(slug);
      expect(content(container)).toContain("71 of 8,080");
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
    expect(content(container)).toContain("813 of 8,080");
  });

  // The brief's own Step 2 test, verbatim intent.
  it("says 'since 2015', never 'first ever'", async () => {
    const { container } = await renderPreset("new-routes");
    expect(content(container)).toContain("since 2015");
    expect(content(container)).not.toContain("first ever");
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
    // features.md's standing UI requirement: all 813 NULL routes are NULL for
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
