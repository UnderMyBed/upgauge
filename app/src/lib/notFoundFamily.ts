import { routeSlugFromPath } from "@/lib/rawPath";
import { airportSlugFromPath } from "@/lib/airport";
import { carrierSlugFromPath } from "@/lib/carrier";
import { aircraftSlugFromPath } from "@/lib/aircraftSlug";
import { presetSlugFromPath } from "@/lib/watch";
import { filterDimFromPath } from "@/lib/pivot/builder";

export type NotFoundFamily = "route" | "airport" | "carrier" | "aircraft" | "watch" | "filter";

/** Which 404 view owns this pathname, or null if this project does not route it at all.
 *
 * Null covers every URL this app does not route to an entity page: an unrecognized code, a
 * scanner probe (`/wp-login.php`), a path carrying more than one raw segment past an entity
 * prefix (`/carrier/DL/x`), and each of the four `opengraph-image` card paths
 * (`/carrier/DL/opengraph-image`) -- a card path's remainder past the entity prefix is always
 * two raw segments, the slug and then `opengraph-image`, and every reader below refuses that
 * shape exactly as it refuses any other nested path.
 *
 * Null is not a failure -- it is the answer for a URL this app never routes, and the root
 * `not-found.tsx` renders its database-free generic view for exactly that case. */
export function notFoundFamilyFromPath(pathname: string): NotFoundFamily | null {
  if (routeSlugFromPath(pathname) !== null) return "route";
  if (airportSlugFromPath(pathname) !== null) return "airport";
  if (carrierSlugFromPath(pathname) !== null) return "carrier";
  if (aircraftSlugFromPath(pathname) !== null) return "aircraft";
  if (presetSlugFromPath(pathname) !== null) return "watch";
  if (filterDimFromPath(pathname) !== null) return "filter";
  return null;
}
