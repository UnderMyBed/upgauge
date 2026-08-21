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
  gaps: 0,
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
