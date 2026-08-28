/** THE ARITHMETIC HALF OF `lib/format.ts`'s OPENING RULE -- "Null is absence, zero is a
 * measurement. Never render one as the other." The formatters there are the rendering half; a
 * value has to survive the arithmetic as an absence before a formatter can ever be handed one.
 *
 * Every `meta_pivot_measures` expression is `SUM(x) FILTER (WHERE NOT is_quarantined)`
 * (sql/02_marts/301_meta_pivot_measures.sql:21-32), and a SUM over zero passing rows returns
 * NULL -- "nothing filed here can be trusted", which is a different finding from "nothing flew"
 * and must stay distinguishable from it all the way to the page. TypeScript then folds those
 * values, and a fold is where the distinction gets thrown away.
 *
 * Lives in `lib/` rather than beside either caller because both of this repo's totals
 * definitions need it and they cannot import from each other: `lib/entityFacts.ts` is the shared
 * definition for /route, /carrier and /aircraft, `app/airport/[code]/endpoints.ts` is
 * /airport's either-endpoint one, and the latter imports `runPivot` -- so pulling these three
 * functions out of a route directory is what keeps DuckDB out of every consumer's graph. Issues
 * #114, #118, #121. */

/** SUM() semantics, mirroring the aggregate these values came from: a NULL contributes nothing,
 * and the sum of NO known values is NULL rather than 0.
 *
 * THIS FUNCTION IS THE FIX, not the `?? 0` deleted from the mappers that feed it. JS `+`
 * coerces null to 0 all by itself -- `null + 5` is `5`, and `[null].reduce((a, b) => a + b, 0)`
 * is `0` -- so a fold left on `+` reinstates the very coercion the mapper stopped doing, and a
 * test on the mapper alone stays green while the page still reads "0 seats". Deleting the `??`
 * and seeding the fold at `null` are two separate halves of one fix; either alone is the bug.
 *
 * Poisoning a whole row because ONE of its groups was quarantined would be the opposite error:
 * 24 of the 29 /airport pages carrying such a group have it folded in beside real traffic, whose
 * figures are honest and whose excluded filings the gutter and the foot's quarantined count
 * already disclose. */
export function addSum(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** A ratio of sums, or null when either input is unknowable or the denominator is zero. Never an
 * average of the rows above (CLAUDE.md's hard rule), and never 0.0 for "nothing flew" -- absence
 * is not a measurement.
 *
 * The null guard is not defensive padding. Typed to `number`, this function reads `null === 0`
 * as false and goes on to evaluate `null / null` -- NaN, which `formatGauge` renders as the
 * literal string "NaN" on a page carrying a DATA AS OF badge. Measured on /airport during #118,
 * and the reason /route, /carrier and /aircraft could not simply drop their `?? 0`. */
export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/** `null`/`undefined` stay absent; everything else becomes a number. `Number(null)` is 0, so the
 * absence has to be tested BEFORE the conversion, not after it -- and the test is against those
 * two values specifically, never a truthiness check, which would turn a real filed `0` into an
 * absence and commit the same error in the other direction. */
export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** One column of a pivot result, folded with SUM semantics end to end: `numOrNull` on the way in
 * so a NULL is never converted to 0, `addSum` in the fold so `+` never converts it either, and a
 * `null` SEED so a query that returned NO rows reports an absence rather than a measurement of
 * zero.
 *
 * The seed is the half that is easy to miss and has the widest footprint. `sumTotals`'s callers
 * reach it on every entity that is fact-present but filed nothing inside the trailing 12 --
 * 12,115 route pairs, and the /airport equivalent covers 290 airports. Those pages render `—`
 * for a reason quarantine had no part in, and their empty states say which absence it is. */
export function sumColumn(rows: Record<string, unknown>[], key: string): number | null {
  return rows.reduce<number | null>((a, r) => addSum(a, numOrNull(r[key])), null);
}
