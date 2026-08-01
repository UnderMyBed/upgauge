// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import WatchIndexPage from "@/app/watch/page";
import { PRESETS, presetBySlug } from "@/lib/watch";

describe("/watch", () => {
  it("shows DATA AS OF", async () => {
    render(await WatchIndexPage());
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("links to all four presets with their editorial frames", async () => {
    const { container } = render(await WatchIndexPage());
    for (const slug of PRESETS) {
      const preset = presetBySlug(slug)!;
      const link = container.querySelector(`a[href="/watch/${slug}"]`);
      expect(link).not.toBeNull();
      expect(link?.textContent).toContain(preset.title);
      expect(container.textContent).toContain(preset.frame);
    }
  });

  // Final whole-branch review (M6), Important #3. M6's headline correction -- the presets are
  // NOT saved Explorer queries, because no `meta_pivot_measures` row expresses a delta and
  // these rank on year-over-year deltas only `mart_route_health` computes -- landed in six
  // places (CLAUDE.md x2, features.md, system.md, pipeline.md x2, topn.ts) and missed the one
  // copy a visitor actually reads: this page's own frame said "Four saved Explorer queries,
  // editorially framed." The claim is checkable by any reader who tries to reproduce Gauge
  // Watch in /explore and cannot.
  //
  // The pair is the point, again: asserting only that the accurate sentence is present would
  // still pass on a page that printed both.
  it("does not call the presets saved Explorer queries", async () => {
    const { container } = render(await WatchIndexPage());
    const text = container.textContent ?? "";
    // Lookbehind, not `not.toContain("saved Explorer queries")` -- the accurate sentence
    // ("Not saved Explorer queries") contains that substring, so the naive negative would be
    // unsatisfiable alongside the positive below. This one goes red on ANY reintroduction of
    // the claim, not just on the exact sentence M6 shipped.
    expect(text).not.toMatch(/(?<!Not )saved Explorer queries/);
    expect(text).toContain("Not saved Explorer queries");
    expect(text).toMatch(/deltas, which no Explorer measure computes/);
  });
});
