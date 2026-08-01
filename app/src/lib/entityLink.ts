import { AIRPORT_PREFIX } from "@/lib/airport";
import { AIRCRAFT_PREFIX, slugFor } from "@/lib/aircraftSlug";
import { CARRIER_PREFIX } from "@/lib/carrier";
import { ROUTE_PREFIX } from "@/lib/rawPath";
import type { Resolved } from "@/lib/resolve";

/** Dimension key -> entity page prefix.
 *
 * Keyed on the dimension's OWN key, never on `join_dim`. Read from meta_pivot_dimensions:
 * `route`, `origin_airport_id` and `dest_airport_id` all carry join_dim = dim_airport, so a
 * join_dim-keyed map sends route cells to /airport/. And both city-market dimensions carry a
 * join_dim with no page behind it, so "has a join_dim" is not the predicate either.
 *
 * This map lives in TypeScript rather than in meta_pivot_dimensions on purpose. system.md's
 * rule that the Explorer's vocabulary is rendered from the catalog governs WHICH DIMENSIONS
 * EXIST, and that is untouched here. A Next.js URL prefix is not a data fact; putting it in a
 * view pipeline/ also reads would make `make goldens` answerable to a routing decision. A
 * dimension added to the catalog still appears without a front-end change -- it appears
 * unlinked, which is correct until someone builds it a page.
 *
 * `route` is absent: its cell is not a DimensionCell (see explore/page.tsx's `__route`), and
 * its URL is not built from one id. Use routeHrefFromCodes for it. */
const ENTITY_PREFIX: ReadonlyMap<string, string> = new Map([
  ["origin_airport_id", AIRPORT_PREFIX],
  ["dest_airport_id", AIRPORT_PREFIX],
  ["op_airline_id", CARRIER_PREFIX],
  ["aircraft_type", AIRCRAFT_PREFIX],
]);

/** The href for a resolved dimension cell, or null when the cell must render as plain text.
 *
 * Null for: a dimension with no entity page; an id that did not resolve (the cell shows the
 * bare id, and there is no code to build a URL from); and a resolution with no code -- city
 * markets, whose name IS the display value. */
export function entityHref(dimKey: string, hit: Resolved | undefined): string | null {
  const prefix = ENTITY_PREFIX.get(dimKey);
  if (prefix === undefined) return null;
  if (hit === undefined || hit.code === null) return null;
  // aircraft_type resolves short_name AS code, and 16 of 112 fact-present short names carry a
  // `/` or a space -- `A321/LR` is two path segments. slugFor is what makes it one.
  const slug = dimKey === "aircraft_type" ? slugFor(hit.code) : hit.code;
  return prefix + encodeURIComponent(slug);
}

/** The canonical /route/ URL for two airport codes: alphabetical by CODE.
 *
 * Not the order the caller happens to hold them in. /explore renders a route cell from
 * `route_key_low, route_key_high`, which is airport-ID order, and the two orderings disagree
 * for 154 of 22,420 pairs (CLAUDE.md; routePair.ts computes them as two separate values for
 * exactly this reason). Building an href from the displayed order is right 99.3% of the time,
 * which is precisely why it survives review. */
export function routeHrefFromCodes(a: string, b: string): string {
  const [low, high] = a <= b ? [a, b] : [b, a];
  return `${ROUTE_PREFIX}${encodeURIComponent(low)}-${encodeURIComponent(high)}`;
}
