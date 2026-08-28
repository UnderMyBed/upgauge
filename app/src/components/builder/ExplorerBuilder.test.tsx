// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ExplorerBuilder } from "@/components/builder/ExplorerBuilder";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";
import { resolutionKey, type Resolved } from "@/lib/resolve";

function q(over: Partial<PivotQuery> = {}): PivotQuery {
  return normalizeQuery({
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats"],
    timeFrom: "2025-05",
    timeTo: "2026-04",
    filters: [],
    sort: null,
    sortDesc: true,
    limit: 100,
    grouping: "operating",
    ...over,
  });
}

function build(over: Partial<PivotQuery> = {}, resolved = new Map<string, Resolved>()) {
  return render(
    <ExplorerBuilder query={q(over)} allowlist={FIXTURE} asOf="2026-04" resolved={resolved} />,
  );
}

describe("ExplorerBuilder", () => {
  it("renders a row per URL key, each labelled with that key", () => {
    const { container } = build();
    const keys = [...container.querySelectorAll(".chip-key")].map((n) => n.textContent);
    expect(new Set(keys)).toEqual(new Set(["k", "g", "d", "m", "t", "s", "n", "f"]));
  });

  // THE SET ABOVE IS SATISFIED BY ANY PERMUTATION, and the order is the actual product claim:
  // system.md § The Explorer says a reader learns the permalink format from the interface, which
  // only holds if the rows run in the order the permalink writes them. Reordering the seven
  // children of `ExplorerBuilder` leaves the set test green and turns this one red. `t` and `f`
  // each own two rows (presets/years, active/add) -- asserted as they are emitted rather than
  // de-duplicated, so moving the year track above the presets is caught too.
  it("runs the rows in URL-key order, not merely containing every key", () => {
    const { container } = build();
    const keys = [...container.querySelectorAll(".chip-key")].map((n) => n.textContent);
    expect(keys).toEqual(["k", "g", "d", "m", "t", "t", "f", "f", "s", "n"]);
  });

  it("emits only real anchors and inert spans -- no button anywhere", () => {
    const { container } = build();
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelectorAll("a").length).toBeGreaterThan(30);
  });

  // THE PROP IS THREADED, NOT DECORATIVE. Every other test here passes an empty map, so a mutant
  // that drops `resolved={resolved}` from the `FilterChips` line -- or hardcodes `new Map()`
  // there -- survives all of them: the chip still renders, just with the raw BTS id in it. The
  // map is keyed by FACT COLUMN, which is how `resolveRows` keys its own (lib/resolve.ts); a
  // dimension-key-shaped fixture would pass while the real page rendered 19790.
  it("hands `resolved` to the filter chips, so a filter shows its display value", () => {
    const resolved = new Map<string, Resolved>([
      [resolutionKey("op_airline_id", "19790"), { code: "DL", name: "Delta Air Lines Inc." }],
    ]);
    const { container } = build({ filters: [["op_airline_id", ["19790"]]] }, resolved);
    const chip = [...container.querySelectorAll(".builder .chip")].find((n) =>
      n.textContent?.startsWith("Carrier ="),
    );
    expect(chip).toBeDefined();
    expect(chip!.textContent).toContain("DL");
    expect(chip!.textContent).not.toContain("19790");
  });

  // `/explore/filter/:dim` was an ISLAND: nothing in the app linked to it, and CLAUDE.md's rule
  // is that neither `sitemap.ts` nor `proxy.ts`'s matcher counts as an inbound link. Composing
  // `FilterChips` into the builder is what closes that, so the anchor is asserted here at the
  // composition and again on the served page (page.test.tsx, app/smoke.sh).
  it("links to the value-list route, which nothing else in the app reaches", () => {
    const { container } = build();
    const links = [...container.querySelectorAll("a")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.startsWith("/explore/filter/"));
    expect(links.length).toBeGreaterThan(0);
    // A real href, not a bare prefix: `Chip` renders `href=""` as a live, clickable, empty
    // anchor (Chips.tsx), so "an anchor exists" is weaker than it looks.
    expect(links.every((h) => /^\/explore\/filter\/[a-z_]+\?v=1&/.test(h))).toBe(true);
  });

  it("no file in components/builder carries a client directive", () => {
    // TopBar.test.tsx makes this claim for the top bar. The builder is the surface most likely
    // to attract a "use client", so the assertion follows it here.
    const dir = path.join(__dirname);
    const files = readdirSync(dir).filter((n) => n.endsWith(".tsx") && !n.endsWith(".test.tsx"));
    // Guard the sweep itself: a glob that matched nothing would pass vacuously, and this
    // directory is exactly where a new control gets added without anyone re-reading this test.
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const source = readFileSync(path.join(dir, f), "utf8");
      expect(source, f).not.toMatch(/^\s*["']use client["']/m);
      expect(source, f).not.toMatch(/\bonClick=/);
      expect(source, f).not.toMatch(/\buseState\(/);
    }
  });
});
