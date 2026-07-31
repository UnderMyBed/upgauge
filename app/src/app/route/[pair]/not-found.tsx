import Link from "next/link";
import { dataAsOf } from "@/lib/db";
import { NotFoundPair } from "./not-found-pair";

// Same reasoning as page.tsx's own export of this constant: DATA AS OF must never be frozen
// at build time, even on the 404 path -- a statically-cached 404 would keep serving a stale
// badge to every visitor forever.
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

/** Next's `not-found.js` convention: rendered when `notFound()` is thrown from a page in this
 * route segment (`page.tsx`'s `RoutePage`, for all three of `routePair.ts`'s `notFound`
 * reasons -- a malformed slug, an unknown code, and a same-airport slug). Without this file
 * Next's own stock UI rendered instead -- `404 | This page could not be found.`, no wordmark,
 * no `DATA AS OF`, no hint of what routePair.ts already worked out and tested (routePair.
 * test.ts). CLAUDE.md: "DATA AS OF ... is a first-class element on every data view" -- this
 * page still asserts something about the data (that a query against it would answer nothing),
 * so it keeps the badge rather than treating a 404 as data-free.
 *
 * Matches explore/page.tsx's error-page structure (wrap > TopBar + main.error-page > h1 +
 * p[role=alert] + a recovery link) so the two "this URL didn't work" pages read as one
 * system, not two ad hoc ones.
 *
 * See not-found-pair.tsx's header comment for why the specific reason routePair.ts computed
 * (typo vs. domestic-only vs. malformed) does NOT reach this page: Next's not-found.js accepts
 * no props, and there is no route-segment mechanism to pass it through. This page names the
 * PAIR instead (via a small Client Component reading usePathname()), which is what
 * features.md, pipeline.md and the design spec's error-taxonomy table actually promise
 * ("404s naming the offending code") -- the pair a reader typed always contains it. */
export default async function NotFound() {
  const asOf = await dataAsOf();
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>Route not found</h1>
        <NotFoundPair />
        <p>
          {/* eslint-plugin-next flags a literal <a href="/route/..."> against this exact
              dynamic route ([pair]) as "use next/link instead" -- it does NOT flag the
              Explorer link below, whose href carries a query string, so only this one needed
              the swap. */}
          Try <Link href="/route/JFK-LAX">JFK–LAX</Link>, or start from{" "}
          <a href="/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op">
            the Explorer
          </a>
          .
        </p>
      </main>
    </div>
  );
}
