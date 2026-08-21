import { notFound, permanentRedirect } from "next/navigation";
import { resolveAirportCode } from "./resolveAirport";
import { airportTotals, fetchAirportMix, fetchAirportTraffic } from "./endpoints";
import { dataAsOf } from "@/lib/db";
import { EARLIEST_MONTH, trailing12From } from "@/lib/entityFacts";
import { CARD_SIZE, renderEntityCard } from "@/lib/og/card";
import { cardChart, cardStats, cardSubtitle } from "@/lib/og/entityCard";
import { formatCount } from "@/lib/format";

// FORCE-DYNAMIC, same line and same reason as page.tsx's: Next's convention doc states a
// generated image is "statically optimized (generated at build time and cached) unless [it uses]
// Request-time APIs or uncached data", and a DuckDB read is neither -- without this every share
// of this airport serves a frozen DATA AS OF badge and frozen totals.
export const dynamic = "force-dynamic";

export const size = CARD_SIZE;
export const contentType = "image/png";

/** `og:image:alt`. A module constant, not a per-airport sentence -- see the route card's own
 * copy of this note for why Next can only read a static export here. It names the both-endpoint
 * rule, because that is the one thing about this page's figures a reader could otherwise get
 * wrong: an origin-only reading is silently about half the airport (measured at SEA: 53,372,100
 * seats both ways against 26,710,000 departing only). */
export const alt =
  "Upgauge data card: an airport's trailing-12-month seats, passengers, load factor, average " +
  "gauge, departures and operating carriers, counted at both endpoints, above a stacked area " +
  "of its monthly seats by aircraft type.";

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const { code: slug } = await params;
  const resolved = await resolveAirportCode(slug);

  // 308 to the canonical card, mirroring page.tsx. No query string is carried across (page.tsx
  // carries `?y=<year>` through its own redirect): a card has no year track, and this route
  // reads no query key at all.
  if (resolved.kind === "redirect") {
    permanentRedirect(`/airport/${resolved.canonical}/opengraph-image`);
  }
  // ALLOW-LIST: only `ok` renders. Never `!== "notFound"` -- see the route card's copy of this
  // note; the negated form treats every future outcome as renderable by default.
  if (resolved.kind !== "ok") {
    notFound();
  }

  const airport = resolved.airport;
  const asOf = await dataAsOf();
  const trailing12 = trailing12From(asOf);

  // The page's own two fetches, from the page's own module (endpoints.ts) -- the either-endpoint
  // pivot for the stats and the full-window mix for the chart, at their default limits, exactly
  // as `AirportView` calls them. The page's third fetch, the network map, has no place on a card
  // that already carries the chart.
  const [traffic, mix] = await Promise.all([
    fetchAirportTraffic(airport.id, trailing12, asOf),
    fetchAirportMix(airport.id, EARLIEST_MONTH, asOf),
  ]);

  const totals = airportTotals(traffic.rows, airport.id);
  const chart = cardChart(mix.rows, airport.code);

  return renderEntityCard({
    title: airport.code,
    subtitle: cardSubtitle(airport.name, trailing12, asOf),
    stats: cardStats(totals, { label: "Carriers", value: formatCount(totals.carriers) }),
    chartSvg: chart.svg,
    gaps: chart.gaps,
    asOf,
  });
}
