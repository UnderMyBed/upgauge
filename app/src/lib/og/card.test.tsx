import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardFrame, CARD_SIZE, type CardInput } from "./card";

const BASE: CardInput = {
  title: "JFK–LAX",
  subtitle: "Domestic segment · 2015-01 to 2026-05",
  stats: [
    { label: "Seats", value: "12.4M" },
    { label: "Load factor", value: "0.847", derived: true },
    { label: "Avg gauge", value: "168.2", derived: true },
    { label: "Departures", value: "73,914" },
  ],
  chartSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#21514A"/></svg>',
  chartNote: null,
  gaps: 0,
  unknowable: 0,
  understated: 0,
  asOf: "2026-05",
};

describe("CardFrame", () => {
  it("is 1200x630", () => {
    expect(CARD_SIZE).toEqual({ width: 1200, height: 630 });
  });

  it("states DATA AS OF", () => {
    expect(renderToStaticMarkup(CardFrame(BASE))).toContain("DATA AS OF: 2026-05");
  });

  // THE BUG THIS CATCHES: the derived flag dropped, so load factor and avg gauge read as
  // filed figures. CLAUDE.md requires derived measures LABELLED as computed, and a card is
  // a data view, not a marketing asset.
  it("marks derived measures as computed", () => {
    const html = renderToStaticMarkup(CardFrame(BASE));
    const derived = html.slice(html.indexOf("Load factor"));
    expect(derived).toMatch(/computed/i);
  });

  it("does not mark a filed measure as computed", () => {
    const html = renderToStaticMarkup(CardFrame(BASE));
    const seats = html.slice(html.indexOf("Seats"), html.indexOf("Load factor"));
    expect(seats).not.toMatch(/computed/i);
  });

  // THE BUG THIS CATCHES: gaps silently omitted. The page states the count in the chart and
  // in its aria-label; a card has NO aria-label, so the visible statement is the only carrier.
  it("states the gap count when there are gaps", () => {
    const html = renderToStaticMarkup(CardFrame({ ...BASE, gaps: 6 }));
    expect(html).toMatch(/6 unfiled months/);
  });

  it("says nothing about gaps when there are none", () => {
    expect(renderToStaticMarkup(CardFrame(BASE))).not.toMatch(/unfiled/);
  });

  it("renders without a chart rather than throwing", () => {
    expect(() => renderToStaticMarkup(CardFrame({ ...BASE, chartSvg: null }))).not.toThrow();
  });

  it("embeds the chart as a data URI, not a remote reference", () => {
    const html = renderToStaticMarkup(CardFrame(BASE));
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toMatch(/src="https?:/);
  });
});

// ---------------------------------------------------------------------------------------
// The last hop of the "say WHY there is no chart" fix, which nothing else reaches.
//
// `entityCard.test.ts` pins what `cardChart` RETURNS. Nothing pinned that `CardFrame` renders
// it, and `app-smoke` structurally cannot: the card is a PNG stream, so a served build sees
// bytes no grep can read. `<Chart chartSvg={chartSvg} note={null} />` therefore left the whole
// suite green while producing a state WORSE than the bug it replaced -- an empty grey panel
// instead of a wrong sentence.
describe("CardFrame's no-chart panel", () => {
  it("renders the note it was given", () => {
    // MUTANT: `note={null}` at the <Chart> call site in card.tsx -> red.
    const html = renderToStaticMarkup(
      CardFrame({
        ...BASE,
        chartSvg: null,
        chartNote: "Only one month of filings in this window (2025-06) — a stacked area needs at least two.",
      }),
    );
    expect(html).toContain("Only one month of filings in this window (2025-06)");
  });

  it("renders the OTHER note when that is the finding", () => {
    // Two findings, one panel: a component that hardcoded either sentence would pass the test
    // above. This is the pair that makes the assertion about wiring rather than about a string.
    const html = renderToStaticMarkup(
      CardFrame({ ...BASE, chartSvg: null, chartNote: "No aircraft-type filings in this window." }),
    );
    expect(html).toContain("No aircraft-type filings in this window.");
    expect(html).not.toContain("Only one month");
  });
});
