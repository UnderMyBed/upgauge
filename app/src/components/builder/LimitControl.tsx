import { Chip, ChipRow } from "@/components/builder/Chips";
import type { PivotQuery } from "@/lib/pivot/types";
import { exploreHref, setLimit } from "@/lib/pivot/builder";

/** The app's own emitted set {25, 50, 100} plus two larger steps, topping out at MAX_LIMIT.
 *  Not every integer up to 1000 -- each is a distinct CDN cache key, and `bounds.ts` documents
 *  n=1000 at 2.2 MB of served HTML. */
const LIMITS = [25, 50, 100, 250, 1000];

export function LimitControl({ query }: { query: PivotQuery }) {
  return (
    <ChipRow urlKey="n" label="Rows">
      {LIMITS.map((n) => (
        <Chip
          key={n}
          label={String(n)}
          current={query.limit === n}
          href={exploreHref(setLimit(query, n))}
        />
      ))}
    </ChipRow>
  );
}
