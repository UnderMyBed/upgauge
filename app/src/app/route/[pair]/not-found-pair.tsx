"use client";

import { usePathname } from "next/navigation";

/** Split out as its own Client Component because deriving the failing pair from the URL
 * needs `usePathname()`, and Next's `not-found.js` convention accepts no props (Next 16
 * docs, node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * not-found.md: "not-found.js or global-not-found.js components do not accept any props") --
 * there is no `params` this file can read for the `[pair]` segment. The same docs are
 * explicit about the tradeoff: "If you need to use Client Component hooks like usePathname
 * to display content based on the path, you must fetch data on the client-side instead" --
 * everything else on this page (the `DATA AS OF` badge) stays server-rendered in
 * `not-found.tsx`, and only this one path-derived bit is a Client Component.
 *
 * Reads the pair straight from the URL rather than re-running `resolveRoutePair` over a
 * client-side fetch: that would need a new API route, a network round trip, and would
 * duplicate validation `routePair.ts` already owns server-side. Good enough to tell the
 * reader WHICH pair failed to resolve; the specific reason (malformed slug, unknown code, or
 * a real-but-non-domestic code) stays server-side only, in `routePair.ts`'s `reason` string
 * and `routePair.test.ts`'s coverage of the three cases -- not reproduced here. */
export function NotFoundPair() {
  const pathname = usePathname();
  const pair = pathname?.replace(/^\/route\//, "") ?? "";
  return (
    <p role="alert">
      {pair ? (
        <>We don&rsquo;t recognize the route &lsquo;{pair}&rsquo;.</>
      ) : (
        <>We don&rsquo;t recognize this route.</>
      )}{" "}
      Either the URL isn&rsquo;t two airport codes joined by a hyphen, one of the codes isn&rsquo;t
      one this dataset knows, or it names a real airport outside this dataset&rsquo;s
      domestic-only (T-100 Segment) scope.
    </p>
  );
}
