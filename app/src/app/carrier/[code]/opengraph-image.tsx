import { notFound, permanentRedirect } from "next/navigation";
import { resolveCarrier } from "@/lib/carrier";
import { dataAsOf, runPivot } from "@/lib/db";
import { fetchAircraftMix } from "@/lib/chart/aircraftMix";
import {
  CARRIER_TYPE_LIMIT,
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
// of this carrier serves a frozen DATA AS OF badge and frozen totals.
export const dynamic = "force-dynamic";

export const size = CARD_SIZE;
export const contentType = "image/png";

/** `og:image:alt`. A module constant, not a per-carrier sentence -- see the route card's own
 * copy of this note for why Next can only read a static export here. It says "operated",
 * because that is CLAUDE.md's hard rule about what every figure on this card means: a
 * DL-branded flight operated by Endeavor files under 9E and is counted there, not here. */
export const alt =
  "Upgauge data card: what one carrier operated over the trailing twelve months — seats, " +
  "passengers, load factor, average gauge, departures and aircraft types — above a stacked " +
  "area of its monthly seats by aircraft type.";

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const { code: slug } = await params;
  const resolved = await resolveCarrier(slug);

  // 308 to the canonical card, mirroring page.tsx: /carrier/dl's card is /carrier/DL's card.
  if (resolved.kind === "redirect") {
    permanentRedirect(`/carrier/${resolved.canonical}/opengraph-image`);
  }
  // ALLOW-LIST: only `ok` renders. Never `!== "notFound"` -- see the route card's copy of this
  // note; the negated form treats every future outcome as renderable by default.
  if (resolved.kind !== "ok") {
    notFound();
  }

  const carrier = resolved.carrier;
  const asOf = await dataAsOf();
  // FILTERED ON THE AIRLINE ID, never the letter code (CLAUDE.md) -- `filterValue` is
  // `String(airline_id)`, and lib/carrier.ts owns that conversion.
  const filters: [string, string[]][] = [["op_airline_id", [resolved.filterValue]]];
  // The page's own query object, from the page's own module (lib/entityFacts.ts) -- same
  // window, same measures, same limit, so the card's stat row IS the page's stat strip.
  const query = trailing12Query({
    dimensions: ["aircraft_type"],
    filters,
    asOf,
    limit: CARRIER_TYPE_LIMIT,
  });

  // CONCURRENT, and the mix takes the FULL window while the stats take the trailing 12 --
  // exactly as `CarrierView` fetches them. The page's two Top-N pivots are tables, not stats,
  // and have no place on the card.
  const [result, mix] = await Promise.all([
    runPivot(query),
    fetchAircraftMix(filters, EARLIEST_MONTH, asOf),
  ]);

  const chart = cardChart(mix, carrier.code);
  const totals = sumTotals(result.rows);

  return renderEntityCard({
    title: carrier.code,
    subtitle: cardSubtitle(carrier.name, query.timeFrom, query.timeTo),
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
        label: "Aircraft types",
        value: formatCount(result.rows.length),
      }),
    ),
    chartSvg: chart.svg,
    chartNote: chart.note,
    gaps: chart.gaps,
    asOf,
  });
}
