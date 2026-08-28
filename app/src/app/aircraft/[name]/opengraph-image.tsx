import { notFound, permanentRedirect } from "next/navigation";
import { resolveAircraftSlug } from "@/lib/aircraftSlug";
import { dataAsOf, runPivot } from "@/lib/db";
import { BY_CARRIER, fetchAircraftMix } from "@/lib/chart/aircraftMix";
import {
  AIRCRAFT_CARRIER_LIMIT,
  EARLIEST_MONTH,
  sumTotals,
  trailing12Query,
} from "@/lib/entityFacts";
import { CARD_SIZE, renderEntityCard } from "@/lib/og/card";
import { cardChart, cardSixthStat, cardStats, cardSubtitle } from "@/lib/og/entityCard";
import { formatCount } from "@/lib/format";

// FORCE-DYNAMIC, same line and same reason as page.tsx's: Next's convention doc states a
// generated image is "statically optimized (generated at build time and cached) unless [it uses]
// Request-time APIs or uncached data", and a DuckDB read is neither -- without this every share
// of this aircraft type serves a frozen DATA AS OF badge and frozen totals.
export const dynamic = "force-dynamic";

export const size = CARD_SIZE;
export const contentType = "image/png";

/** `og:image:alt`. A module constant, not a per-type sentence -- see the route card's own copy
 * of this note for why Next can only read a static export here. It names the CARRIER stack,
 * because this card's chart is the one that differs: a page that IS one aircraft type would
 * draw a single band stacked by type, so the bands here are the operators. */
export const alt =
  "Upgauge data card: an aircraft type's trailing-12-month seats, passengers, load factor, " +
  "average gauge, departures and operating carriers, above a stacked area of its monthly " +
  "seats by operating carrier.";

export default async function Image({ params }: { params: Promise<{ name: string }> }) {
  const { name: slug } = await params;
  const resolved = await resolveAircraftSlug(slug);

  // 308 to the canonical card, mirroring page.tsx: the uppercased slug IS the canonical URL.
  if (resolved.kind === "redirect") {
    permanentRedirect(`/aircraft/${resolved.canonical}/opengraph-image`);
  }
  // ALLOW-LIST, and THIS is the route where the difference bites. `AircraftSlugResult` has FOUR
  // outcomes, and `ambiguous` is the fourth: /aircraft/CE-180 names two fact-present airframes
  // (BTS codes 030 CESSNA 180 and 031 CESSNA 180A/B), so there is no entity at this URL and the
  // page refuses to pick one. Written `!== "notFound"` -- the shape that reads as equivalent --
  // this route would silently pick one type's card for a URL its own page 404s, and the proxy
  // would cache it. Only `ok` renders.
  if (resolved.kind !== "ok") {
    notFound();
  }

  const type = resolved.type;
  const asOf = await dataAsOf();
  // The BTS `code` as a STRING -- CLAUDE.md's zero-padding rule. 13 fact-present types have a
  // leading zero ('036'), and Number()-ing it would match nothing and card a type that flies
  // every day as all zeroes.
  const filters: [string, string[]][] = [["aircraft_type", [type.id]]];
  // The page's own query object, from the page's own module (lib/entityFacts.ts) -- same
  // window, same measures, same limit, so the card's stat row IS the page's stat strip.
  const query = trailing12Query({
    dimensions: ["op_airline_id"],
    filters,
    asOf,
    limit: AIRCRAFT_CARRIER_LIMIT,
  });

  // BY_CARRIER, and it is the point of this page: stacking by aircraft type here would draw ONE
  // band, since the subject IS one aircraft type. `AircraftView` passes the same dimension for
  // the same reason.
  const [result, mix] = await Promise.all([
    runPivot(query),
    fetchAircraftMix(filters, EARLIEST_MONTH, asOf, BY_CARRIER),
  ]);

  const chart = cardChart(mix, resolved.canonical, BY_CARRIER);
  const totals = sumTotals(result.rows);

  return renderEntityCard({
    title: type.code,
    subtitle: cardSubtitle(type.name, query.timeFrom, query.timeTo),
  // THE SIXTH STAT, chosen by the SHARED rule (`cardSixthStat`), not by this route. When every
  // filing in the window was quarantined the five measures above are all `—`, and a card has no
  // foot, no empty state and no `aria-label` -- so the stat row is the only place left to say
  // why, and the entity count gives way to the quarantined one. Gated on BOTH operands: keyed on
  // the null alone it would answer "Quarantined 0" on every page that simply filed nothing,
  // naming the one cause it is not. `quarantinedRowsOnPage` is a `count(*) FILTER` (lib/db.ts)
  // and cannot be NULL, which is why it keeps its own `?? 0` there and is the right operand here.
    stats: cardStats(
      totals,
      cardSixthStat(totals, result.quarantinedRowsOnPage, {
        label: "Carriers",
        value: formatCount(result.rows.length),
      }),
    ),
    chartSvg: chart.svg,
    chartNote: chart.note,
    gaps: chart.gaps,
    // The other two absence causes, each carried as its own count and rendered as its own
    // phrase (#121). A card has no aria-label and no foot, so a merged count here would be the
    // wrong word with nothing to correct it.
    unknowable: chart.unknowable,
    understated: chart.understated,
    asOf,
  });
}
