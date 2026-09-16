import { ogSlugFromPath } from "@/lib/entitySlug";
import { routeSlugFromPath, ROUTE_PREFIX } from "@/lib/rawPath";
import { airportSlugFromPath, AIRPORT_PREFIX } from "@/lib/airport";
import { carrierSlugFromPath, CARRIER_PREFIX } from "@/lib/carrier";
import { aircraftSlugFromPath, AIRCRAFT_PREFIX } from "@/lib/aircraftSlug";
import { presetSlugFromPath } from "@/lib/watch";
import { filterDimFromPath } from "@/lib/pivot/builder";

export type NotFoundFamily = "route" | "airport" | "carrier" | "aircraft" | "watch" | "filter";

// The same four prefixes proxy.ts's OG_ROUTES table carries, not four re-typed string literals
// -- ROUTE_PREFIX/AIRPORT_PREFIX/CARRIER_PREFIX/AIRCRAFT_PREFIX are each already exported
// beside the slug reader they belong to (see those files' own headers), and a private copy
// here is exactly the drift CLAUDE.md's "one owner" rule exists to prevent. `/watch` has no
// opengraph-image route (absent from proxy.ts's OG_ROUTES), so it is not in this list.
const OG_PREFIXES: readonly string[] = [ROUTE_PREFIX, AIRPORT_PREFIX, CARRIER_PREFIX, AIRCRAFT_PREFIX];

/** Which 404 view owns this pathname, or null if this project does not route it at all.
 *
 * Second encoding of the ordering `proxy.ts`'s `OG_ROUTES` loop already carries -- read that
 * loop's own comment (immediately above it, "THIS BRANCH MUST STAY ABOVE THE `/airport`
 * BRANCH") for the full argument; it is not restated here beyond the one line that matters for
 * THIS function: an OG card path (`/carrier/DL/opengraph-image`) is itself exactly one raw
 * segment past `/carrier/`'s prefix, so `carrierSlugFromPath` alone cannot tell it apart from a
 * real carrier code -- the OG check has to run first, or a card URL dispatches to an entity's
 * 404 view instead of being recognized as not-an-entity-page at all.
 *
 * Null is also the answer for any path carrying more than one raw segment past an entity
 * prefix (`/carrier/DL/x`) -- every reader below refuses that shape, matching what a `:param`
 * matcher entry and its `[param]` folder actually route.
 *
 * Null is not a failure -- it is the answer for a URL this app never routes (`/wp-login.php`
 * and every other scanner probe, plus the four `opengraph-image` card paths), and the root
 * `not-found.tsx` renders its database-free generic view for exactly that case. */
export function notFoundFamilyFromPath(pathname: string): NotFoundFamily | null {
  if (OG_PREFIXES.some((prefix) => ogSlugFromPath(pathname, prefix) !== null)) return null;
  if (routeSlugFromPath(pathname) !== null) return "route";
  if (airportSlugFromPath(pathname) !== null) return "airport";
  if (carrierSlugFromPath(pathname) !== null) return "carrier";
  if (aircraftSlugFromPath(pathname) !== null) return "aircraft";
  if (presetSlugFromPath(pathname) !== null) return "watch";
  if (filterDimFromPath(pathname) !== null) return "filter";
  return null;
}
