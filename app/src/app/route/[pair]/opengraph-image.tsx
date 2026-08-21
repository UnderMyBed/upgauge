import { notFound, permanentRedirect } from "next/navigation";
import { resolveRoutePair } from "@/lib/routePair";
import { dataAsOf, runPivot } from "@/lib/db";
import { fetchAircraftMix } from "@/lib/chart/aircraftMix";
import {
  EARLIEST_MONTH,
  ROUTE_CARRIER_LIMIT,
  routeEndpoints,
  routeTitle,
  sumTotals,
  trailing12Query,
} from "@/lib/entityFacts";
import { CARD_SIZE, renderEntityCard } from "@/lib/og/card";
import { cardChart, cardStats, cardSubtitle } from "@/lib/og/entityCard";
import { formatCount } from "@/lib/format";

// FORCE-DYNAMIC, for the same reason page.tsx carries the same line: Next's own convention doc
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/
// opengraph-image.md) states that generated images are "statically optimized (generated at
// build time and cached) unless they use Request-time APIs or uncached data", and that
// `opengraph-image.js` is a Route Handler "cached by default". A DuckDB read is neither a
// request-time API nor an uncached `fetch`, so without this the card is rasterized ONCE at
// build and every share of this route serves a frozen DATA AS OF badge and frozen totals --
// the exact failure page.tsx's own comment says a statically-cached entity page would cause.
export const dynamic = "force-dynamic";

export const size = CARD_SIZE;
export const contentType = "image/png";

/** `og:image:alt`, and it has to be a MODULE CONSTANT: Next reads the named exports of this
 * file once (build/webpack/loaders/next-metadata-image-loader.js reads `imageMetadata.alt` off
 * the static export object), so it cannot carry this route's own seats or window -- only
 * `generateImageMetadata` can, and that would move the served URL under an `/[id]` segment for
 * one sentence. So it states what the image CONTAINS, which is true of every route's card,
 * rather than a per-route figure it cannot reach. Omitting it entirely is the alternative, and
 * an image with no alt text is an accessibility regression on a site whose charts all carry a
 * real `aria-label`. */
export const alt =
  "Upgauge data card: a route's trailing-12-month seats, passengers, load factor, average " +
  "gauge, departures and operating carriers, above a stacked area of its monthly seats by " +
  "aircraft type.";

export default async function Image({ params }: { params: Promise<{ pair: string }> }) {
  const { pair: slug } = await params;
  const resolved = await resolveRoutePair(slug);

  // 308 to the canonical card, mirroring what page.tsx does with the same outcome -- the image
  // for /route/lax-jfk is the image for /route/JFK-LAX, and one URL per card is one CDN entry
  // per card.
  if (resolved.kind === "redirect") {
    permanentRedirect(`/route/${resolved.canonical}/opengraph-image`);
  }
  // ALLOW-LIST: only `ok` renders. Never `!== "notFound"` -- that form treats every future
  // outcome as renderable by default, and on /aircraft it already would (`ambiguous`). An
  // unknown slug that rendered a card of zeroes would be an invented data view, and a cached
  // one: the proxy resolves cacheability from this same slug.
  if (resolved.kind !== "ok") {
    notFound();
  }

  const asOf = await dataAsOf();
  const filters: [string, string[]][] = [["route", [resolved.filterValue]]];
  // The page's own query object, from the page's own module (lib/entityFacts.ts) -- same
  // window, same measures, same limit. The card's stat row is the page's stat strip or it is a
  // second set of numbers free to disagree with it.
  const query = trailing12Query({
    dimensions: ["op_airline_id"],
    filters,
    asOf,
    limit: ROUTE_CARRIER_LIMIT,
  });

  // CONCURRENT, and the mix takes the FULL window while the stats take the trailing 12 --
  // exactly as the page fetches them (route/[pair]/page.tsx's `RouteView`), because the card
  // shows exactly what the page shows.
  const [result, mix] = await Promise.all([
    runPivot(query),
    fetchAircraftMix(filters, EARLIEST_MONTH, asOf),
  ]);

  const title = routeTitle(resolved.canonical);
  const [a, b] = routeEndpoints(resolved.low, resolved.high, resolved.canonical);
  const chart = cardChart(mix, title);

  return renderEntityCard({
    title,
    subtitle: cardSubtitle(`${a.name} – ${b.name}`, query.timeFrom, query.timeTo),
    stats: cardStats(sumTotals(result.rows), {
      label: "Carriers",
      value: formatCount(result.rows.length),
    }),
    chartSvg: chart.svg,
    gaps: chart.gaps,
    asOf,
  });
}
