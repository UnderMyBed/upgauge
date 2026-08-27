import { BY_AIRCRAFT_TYPE, type MixDimension, type MixRow } from "@/lib/chart/aircraftMix";
import { buildMixPlotConfig, mixAbsenceNote, prepareMixPlot } from "@/lib/chart/mixPlotConfig";
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
   * two filed months. `CardFrame` states `note` in words instead of drawing an empty frame. */
  svg: string | null;
  /** WHY there is no chart, when `svg` is null -- the page's own sentence, from
   * `mixAbsenceNote`, never a second wording of it. The card used to carry a flat "No filings
   * in this window." for BOTH of that function's two findings, which on an entity whose window
   * holds one quarantined filing was a card asserting nothing had ever been filed. Null
   * whenever `svg` is not. */
  note: string | null;
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
  const { months, plot } = prepareMixPlot(rows, title, dimension);
  if (plot === null) return { svg: null, note: mixAbsenceNote(months, dimension), gaps: 0 };
  return {
    svg: asStandaloneSvg(resolveSvgTokens(renderPlotToSvg(buildMixPlotConfig(plot.args)))),
    note: null,
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
 * THAT LAST SENTENCE ASSUMES THE FIRST FIVE CAN BE STATED. Where every filing in the window was
 * quarantined they are all `—`, and a card showing five dashes with no count is five unexplained
 * holes -- the one number that explains them is precisely the one this rule leaves behind, and
 * docs/design/system.md requires a quarantined count to be surfaced with its reason. A card has
 * no `aria-label` and no second line to put it on, which is the argument this card already
 * accepted for the unfiled-month count (rendered as visible type for exactly that reason). So
 * the CALLER chooses `last`: /airport's route passes Quarantined instead of Carriers when its
 * totals are unknowable. Six stats either way; no change to the rule, only to which sixth.
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

/** THE SIXTH STAT EXPLAINS THE OTHER FIVE, OR COUNTS THEM.
 *
 * `cardStats` above shows five measures and a caller-chosen sixth. Where every filing in the
 * window was quarantined those five are all `—`, and a card is the surface with no escape hatch
 * -- no empty state, no foot, no `aria-label` -- so the stat row is the only place a reader can
 * be told why. This displaces the entity count with the quarantined one for exactly that case.
 *
 * BOTH CLAUSES, and neither is redundant. `quarantinedRows > 0` alone is wrong on every page
 * that carries a quarantined row beside real totals -- 24 of the 29 on `/airport` -- which must
 * keep their entity count. `totals.seats === null` alone is wrong on the pages that filed
 * NOTHING, whose measures are absent for a reason quarantine had no part in: answering five
 * dashes with "Quarantined 0" names the one cause it is not, and withholds the count that does
 * explain them. `airport/[code]/page.tsx`'s `quarantineClause` splits the same two absences the
 * same way, and docs/data/invariants.md states the rule they share.
 *
 * `seats` stands for all five: the measures carry an identical FILTER, so they go NULL together
 * or not at all (invariants.md, "zero partially-NULL groups"). NOTHING ON THIS PATH ASSERTS THAT.
 * The one runtime check lives in `lib/map/airportNetwork.ts`, at route grain on the map path,
 * which a card never fetches -- and no pipeline test or SQL constraint forbids a NULL measure on
 * a non-quarantined `fct_segment_month` row. It is a warehouse invariant this code relies on and
 * no gate enforces; `airport/[code]/page.tsx` records the same debt where it infers "every filing
 * is quarantined" from the same property.
 *
 * HERE RATHER THAN IN A ROUTE. `/airport` is the only caller today because it is the only page
 * whose totals can be null; the other three still coerce (issue #121), and the moment that lands
 * their cards reach this exact state on 10 route pages. The rule is written in `cardStats`'s
 * docstring and in docs/design/system.md, so the mechanism belongs beside it and not in one
 * caller -- a shared rule with a single route-local implementation is how the same defect gets
 * re-derived per surface. */
export function cardSixthStat(
  totals: EntityTotals,
  quarantinedRows: number,
  fallback: CardStat,
): CardStat {
  return totals.seats === null && quarantinedRows > 0
    ? { label: "Quarantined", value: formatCount(quarantinedRows) }
    : fallback;
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
