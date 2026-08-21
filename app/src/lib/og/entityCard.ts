import { BY_AIRCRAFT_TYPE, type MixDimension, type MixRow } from "@/lib/chart/aircraftMix";
import { buildMixPlotConfig, prepareMixPlot } from "@/lib/chart/mixPlotConfig";
import { renderPlotToSvg } from "@/lib/chart/svg";
import { resolveSvgTokens } from "@/lib/og/resolveSvgTokens";
import { formatCount, formatGauge, formatLoadFactor, formatSeats } from "@/lib/format";
import type { EntityTotals } from "@/lib/entityFacts";
import type { CardStat } from "@/lib/og/card";

/** The three things all four entity cards assemble the same way, so that "the card says what
 * the page says" is one implementation rather than four that agree today.
 *
 * Nothing here queries. Each route fetches through the same module its page fetches through
 * (`lib/entityFacts.ts`, or `app/airport/[code]/endpoints.ts` for the either-endpoint page) and
 * hands the results in, so a divergence between a card and its page would have to be a
 * divergence inside a function they both call. */

/** A standalone SVG document, which Plot's output is not.
 *
 * `renderPlotToSvg` returns `node.outerHTML` from jsdom, and the HTML fragment serialization
 * algorithm does not write namespace declarations -- measured: the emitted root is
 * `<svg class="plot" fill="currentColor" ...>` with no `xmlns` anywhere in 28,873 bytes. That is
 * correct for the page, where the markup is spliced into an HTML document that supplies the SVG
 * namespace by parsing context. A `data:image/svg+xml` URI has no such context: the bytes ARE
 * the document, and resvg (next/og's rasterizer) parses them as XML. Injected here rather than
 * in `renderPlotToSvg` so the page's inline markup keeps the exact bytes it has today. */
function asStandaloneSvg(svg: string): string {
  return svg.replace(/^<svg /, '<svg xmlns="http://www.w3.org/2000/svg" ');
}

export interface CardChart {
  /** Token-resolved, standalone SVG, or null when there is nothing honest to draw -- fewer than
   * two filed months. `CardFrame` states that in words instead of drawing an empty frame. */
  svg: string | null;
  /** Unfiled months inside the drawn window. The page states this on the chart AND in the
   * chart's `aria-label`; a rasterized card has neither, so the card's visible line is the only
   * thing left to carry it. */
  gaps: number;
}

/** The card's chart: the SAME stacked area the page mounts, from the same rows through the same
 * `prepareMixPlot` + `buildMixPlotConfig` + `renderPlotToSvg` chain `AircraftMixChart` uses --
 * never a second, card-shaped drawing of the same data. The gap rules and the two orderings
 * (band membership by seats, band shade by gauge) therefore cannot differ between a card and
 * the page it previews.
 *
 * The one card-only step is `resolveSvgTokens`: the chart emits colour as `var(--g3)` and its
 * font as `var(--font-mono)`, which a browser resolves against `globals.css` and a rasterizer
 * cannot. It THROWS on a token with no literal rather than letting resvg fall back to black. */
export function cardChart(
  rows: MixRow[],
  title: string,
  dimension: MixDimension = BY_AIRCRAFT_TYPE,
): CardChart {
  const { plot } = prepareMixPlot(rows, title, dimension);
  if (plot === null) return { svg: null, gaps: 0 };
  return {
    svg: asStandaloneSvg(resolveSvgTokens(renderPlotToSvg(buildMixPlotConfig(plot.args)))),
    gaps: plot.gaps,
  };
}

/** The card's stat row: the FIRST SIX of the page's own stat strip, in the page's own order,
 * through the page's own formatters.
 *
 * Six and not all of them because the row is one line 1,112px wide and a seventh stat overflows
 * it -- so the rule for which ones is mechanical (page order, take six) rather than a per-page
 * judgement about what matters, which is how a card starts making claims its page does not.
 * The five shared measures are the first five on all four pages; `last` is the page's
 * entity-specific count (carriers on /route, /airport and /aircraft, aircraft types on
 * /carrier). The page's remaining stats -- quarantined rows everywhere, destinations on
 * /airport -- stay on the page, one click away.
 *
 * `derived` is set on load factor and average gauge and nowhere else: CLAUDE.md requires a
 * derived measure to be LABELLED as computed, and a card is a data view, not a marketing
 * asset. */
export function cardStats(totals: EntityTotals, last: CardStat): CardStat[] {
  return [
    { label: "Seats", value: formatSeats(totals.seats) },
    { label: "Passengers", value: formatSeats(totals.passengers) },
    { label: "Load factor", value: formatLoadFactor(totals.loadFactor), derived: true },
    { label: "Avg gauge", value: formatGauge(totals.avgGauge), derived: true },
    { label: "Departures", value: formatCount(totals.departures) },
    last,
  ];
}

/** The card's subtitle: what the page's entity header carries under the big code, then the
 * window the STATS above it were summed over -- the trailing 12 months, never the chart's full
 * window. The card shows both at once, so it has to name the one the numbers came from; the
 * chart's own x axis is labelled with its own years.
 *
 * Plain `·` and `→` only. Satori substitutes a colour emoji for any character in Unicode's
 * emoji set, and `↔` (U+2194) is in it -- measured: `/aircraft`-style rendering of
 * "JFK ↔ LAX" put a blue double-arrow EMOJI in the middle of the subtitle. U+2192 `→` and
 * U+2013 `–` both rasterize as text from the loaded Plex faces. */
export function cardSubtitle(descriptor: string, from: string, to: string): string {
  return `${descriptor} · trailing 12 months · ${from} → ${to}`;
}
