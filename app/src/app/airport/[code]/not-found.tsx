import Link from "next/link";
import { headers } from "next/headers";
import { dataAsOf } from "@/lib/db";
import { rawPathFromHeaders } from "@/lib/rawPath";
import { airportSlugFromPath, resolveAirportCode } from "./resolveAirport";

// Same reasoning as page.tsx's own export: DATA AS OF must never be frozen at build time,
// even on the 404 path. proxy.ts sets `no-store` on this response one level out, at the CDN.
export const dynamic = "force-dynamic";

function Wordmark() {
  return (
    <span className="mark">
      UP<span className="accent">GAUGE</span>
    </span>
  );
}

function TopBar({ asOf }: { asOf: string }) {
  return (
    <div className="top">
      <Wordmark />
      <span className="asof">DATA AS OF {asOf}</span>
    </div>
  );
}

/** The specific reason this slug is not an airport, in `resolveAirport.ts`'s own words -- which
 * name the offending CODE, and distinguish a typo from a real airport this domestic-only
 * dataset simply has no rows for.
 *
 * Re-running the resolver rather than receiving page.tsx's result is forced by the framework:
 * `notFound()` takes no argument and `not-found.js` accepts no props, so there is no channel
 * between the two renders. It is one extra read of dimension-sized tables on a request that
 * has already decided it has nothing else to do. */
async function reasonFor(pathname: string): Promise<string | null> {
  const slug = airportSlugFromPath(pathname);
  if (slug === null) return null;
  const resolved = await resolveAirportCode(slug);
  return resolved.kind === "notFound" ? resolved.reason : null;
}

/** Next's `not-found.js` convention, scoped to this route segment: rendered when `page.tsx`
 * throws `notFound()`. Without it Next's stock `404 | This page could not be found.` renders
 * instead -- no wordmark, no DATA AS OF, and no hint of what the resolver already worked out.
 * Structure matches route/[pair]/not-found.tsx and explore/page.tsx's error page so every
 * "this URL didn't work" page in the product reads as one system.
 *
 * Takes the pathname as a prop, from proxy.ts's RAW_PATH_HEADER, for the reason lib/rawPath.ts
 * documents at length: a Client Component reading `usePathname()` would put the one value this
 * page's message depends on somewhere no server test and no `curl` can see it. */
export async function NotFoundView({ pathname }: { pathname: string }) {
  const [asOf, reason] = await Promise.all([dataAsOf(), reasonFor(pathname)]);
  const slug = airportSlugFromPath(pathname);
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>Airport not found</h1>
        <p role="alert">
          {slug !== null && reason !== null ? (
            <>
              We can&rsquo;t show &lsquo;{slug}&rsquo;: {reason}.
            </>
          ) : (
            <>We don&rsquo;t recognize this page.</>
          )}
        </p>
        <p>
          {/* eslint-plugin-next flags a literal <a href> against this dynamic route ([code])
              as "use next/link instead"; it does not flag the Explorer link below, whose href
              carries a query string. */}
          Try <Link href="/airport/SEA">SEA</Link>, or start from{" "}
          <a href="/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op">
            the Explorer
          </a>
          .
        </p>
      </main>
    </div>
  );
}

export default async function NotFound() {
  const requestHeaders = await headers();
  // Fails loudly if proxy.ts did not run. There is deliberately no fallback: a 404 page that
  // quietly stops naming the offending code, with every gate green, is the precise failure
  // this header exists to make impossible. NOTE FOR M4d TASK 5: `/airport/:code` must be added
  // to proxy.ts's matcher, or this throws on every 404 here.
  return <NotFoundView pathname={rawPathFromHeaders(requestHeaders)} />;
}
