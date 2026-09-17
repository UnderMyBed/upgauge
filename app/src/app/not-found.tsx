import { headers } from "next/headers";
import { RAW_PATH_HEADER } from "@/lib/rawPath";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { notFoundFamilyFromPath } from "@/lib/notFoundFamily";
import { NotFoundView as RouteNotFound } from "./route/[pair]/not-found";
import { NotFoundView as AirportNotFound } from "./airport/[code]/not-found";
import { NotFoundView as CarrierNotFound } from "./carrier/[code]/not-found";
import { NotFoundView as AircraftNotFound } from "./aircraft/[name]/not-found";
import { NotFoundView as WatchNotFound } from "./watch/[preset]/not-found";
import { NotFoundView as FilterNotFound } from "./explore/filter/[dim]/not-found";

// NOT the siblings' reason, and copying it here would be wrong. All six segment `not-found.tsx`
// files export this so DATA AS OF is never frozen at build time; the generic branch below reads
// no data at all, deliberately, so that reason does not reach it. This export is here because the
// default export calls `headers()`, which has no answer at build time. The second-order cost is
// the part worth knowing, and it is measured rather than inferred: `next build`'s route table
// prints `/_not-found` as Static with this file absent and Dynamic with it present, so the
// unrouted-URL 404 is a per-request render now where it was a prerendered page before #157.
export const dynamic = "force-dynamic";

/** The root 404 boundary, and the ONLY one whose body reaches the served HTML.
 *
 * WHY THIS FILE EXISTS AT ALL, since six segment `not-found.tsx` files already render these
 * views: `notFound()` thrown from a rendered page cannot produce server HTML on this Next
 * version. The throw is caught in `app-render.js`'s error path, which re-renders through
 * `getErrorRSCPayload` -- and that function's seed markup is literally
 * `createElement('html', {id:'__next_error__'}, createElement('head'), createElement('body'))`,
 * an empty body by construction. The page's real markup then exists only inside the streamed
 * flight payload, so a visitor with JavaScript off gets a blank page. Measured on production
 * and locally: `/carrier/ZZZ` shipped 12,092 bytes with ZERO `<h1>` and no `DATA AS OF`.
 *
 * A URL that matches NO route does not have this problem, because Next reaches it with
 * `res.statusCode` already 404 and renders it through the normal payload path, root layout
 * included. `proxy.ts` turns the first case into the second: it already resolves every entity
 * before the page runs (that is how it picks a `Cache-Control`), so when it has already
 * determined the request 404s it rewrites to `/_not-found` -- here -- which keeps the 404
 * status, keeps `no-store`, and renders through the root layout into real HTML.
 *
 * SIX branches there rewrite, not seven: the four `opengraph-image` cards resolve exactly like
 * their pages do and deliberately do NOT rewrite. An `opengraph-image.tsx` compiles to a route
 * handler returning an `ImageResponse`, so a crawler asking for a PNG would be handed an HTML
 * document -- which is also why `notFoundFamilyFromPath` answers `null` for those paths rather
 * than naming an entity.
 *
 * The six segment files are NOT dead. An RSC request is answered by `proxy.ts`'s `RSC` header
 * guard, which returns before every branch below it, so client-side navigation to a 404 URL
 * still renders through the segment boundary, and any `notFound()` the proxy did not predict
 * still lands there with the blank body this file exists to fix -- narrowed, not closed.
 * They also keep the fail-loud `rawPathFromHeaders`; this file deliberately does not. `proxy.ts`
 * runs on every request, so an absent header means it did not run at all -- and this boundary is
 * what every unrouted URL renders, so throwing here would turn every scanner probe's 404 into a
 * 500 where the generic view below is still the right answer.
 *
 * THE HEADER IS AUTHORITATIVE because `proxy.ts` runs on every request (its matcher is
 * `/:path*`). Next deletes every request header outside the middleware's override set
 * (`server/lib/router-utils/resolve-routes.js`), and `proxy.ts` sets this one to the request's own
 * pathname, so a client-supplied `x-upgauge-path` never reaches the dispatch below. That is what
 * keeps the dispatch from being a client-selectable dimension lookup -- `dataAsOf()` plus a
 * resolver -- on any path `deploy/cloudflare/rate-limit.json`'s prefixes do not cover (#172). */
export async function RootNotFoundView({
  pathname,
  rawQuery,
}: {
  pathname: string | null;
  rawQuery: string;
}) {
  const family = pathname === null ? null : notFoundFamilyFromPath(pathname);
  if (pathname !== null) {
    // Called directly and awaited, NOT rendered as `<RouteNotFound .../>` JSX: each segment
    // view is an async function component, and react-dom's client renderer (what
    // @testing-library/react drives under jsdom) throws "async Client Component" for an async
    // component reached through JSX -- only an RSC render tolerates that. Calling the
    // function directly sidesteps that render path entirely, exactly as every segment view's
    // own test does (`render(await NotFoundView({...}))`, never `<NotFoundView .../>`).
    switch (family) {
      case "route":
        return await RouteNotFound({ pathname });
      case "airport":
        return await AirportNotFound({ pathname });
      case "carrier":
        return await CarrierNotFound({ pathname });
      case "aircraft":
        return await AircraftNotFound({ pathname });
      case "watch":
        return await WatchNotFound({ pathname });
      case "filter":
        return await FilterNotFound({ pathname, rawQuery });
      case null:
        break;
      default: {
        // A seventh `NotFoundFamily` with no case above compiles clean and silently serves the
        // generic "This URL is not part of Upgauge" for that whole family -- which is the bug
        // `not-found.test.tsx` names verbatim, and which no test can catch for a family that
        // does not exist yet. `never` makes it a TYPECHECK failure at the moment the union
        // grows. `case null` is what leaves this arm exhausted rather than merely unreached: an
        // unrouted pathname breaks to the generic view below, unchanged.
        const unhandled: never = family;
        void unhandled;
      }
    }
  }
  // NO DATABASE ON THIS BRANCH, deliberately. Every request -- `proxy.ts` sets the path header on
  // all of them -- lands here for zero queries when the pathname is one this app does not route:
  // every scanner probe and every typo, an unbounded set the edge rate limit does not enumerate.
  // That is also why there is no `TopBar`: it takes `asOf`, and `DATA AS OF` is a first-class
  // element on every DATA view, which this is not.
  return (
    <div className="wrap">
      <main className="error-page">
        <h1>Page not found</h1>
        <p role="alert">This URL is not part of Upgauge.</p>
        <p>
          Start from <a href="/explore">the Explorer</a>.
        </p>
      </main>
    </div>
  );
}

export default async function NotFound() {
  const requestHeaders = await headers();
  return (
    <RootNotFoundView
      pathname={requestHeaders.get(RAW_PATH_HEADER)}
      rawQuery={requestHeaders.get(RAW_QUERY_HEADER) ?? ""}
    />
  );
}
