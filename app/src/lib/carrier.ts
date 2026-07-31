import { lookupCarriersByCode, type CarrierRef } from "@/lib/resolve";

export type CarrierResult =
  | { kind: "ok"; carrier: CarrierRef; canonical: string; filterValue: string }
  | { kind: "redirect"; canonical: string }
  | { kind: "notFound"; reason: string };

/** The `/carrier/<code>` slug's prefix, and the reader for it.
 *
 * Sibling of `rawPath.ts`'s `ROUTE_PREFIX`/`routeSlugFromPath` and it exists for the same two
 * consumers: `proxy.ts`, which has to know whether a request is a real carrier before the page
 * runs so a 404 gets `no-store` rather than a month of CDN cache, and `not-found.tsx`, which
 * has no props and no route params (Next's `not-found.js` convention) and so can only learn
 * the requested code from `proxy.ts`'s `RAW_PATH_HEADER`.
 *
 * It lives HERE rather than beside its route sibling in `rawPath.ts` because M4d builds three
 * of these pages concurrently and `rawPath.ts` is one file three tasks would be editing at
 * once. The four copies (route, airport, carrier, aircraft) should collapse into one
 * `entitySlugFromPath(pathname, prefix)` once they all exist -- see this task's report. */
export const CARRIER_PREFIX = "/carrier/";

export function carrierSlugFromPath(pathname: string): string | null {
  if (!pathname.startsWith(CARRIER_PREFIX)) return null;
  const raw = pathname.slice(CARRIER_PREFIX.length);
  // Same guard, same reason, as routeSlugFromPath: the page receives `params.code` already
  // percent-decoded, so this must decode too or the two disagree -- and `decodeURIComponent`
  // THROWS on a malformed escape ('%zz'), which is bug #2 on smoke.sh's list of
  // production-only failures. A malformed escape falls back to the raw text, which
  // resolveCarrier then rejects as a code nothing has filed under. Never uncaught.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Parse and canonicalise a `/carrier/<code>` slug.
 *
 * Unlike `/route/<pair>` there is only ONE ordering here and no composite key, so this is the
 * simpler of the two resolvers -- but it carries the same three-way result shape, and for the
 * same reasons:
 *
 *   ok       -- `filterValue` is the AIRLINE ID as a string, never the letter code.
 *               CLAUDE.md: key on `AIRLINE_ID`, display `carrier_code`. `op_airline_id` is an
 *               integer column, so a query filtered by 'DL' would match nothing and the page
 *               would render a confident, fully-formatted empty state for the largest carrier
 *               in the dataset.
 *   redirect -- `/carrier/dl` is the same carrier as `/carrier/DL`, and permalinks are this
 *               product's growth mechanic (CLAUDE.md's UI constraints), so there is exactly
 *               one URL per carrier and every other spelling 308s to it.
 *   notFound -- names the code.
 *
 * ONE 404 reason, worded to be true of both of the ways a code can fail. 1,543 of
 * dim_carrier's 1,657 DISTINCT codes have no fact-present holder -- measured, and 1,657 is the
 * right denominator: 1,776 is the table's ROW count (one row per airline_id), and 1,657 - 114
 * fact-present carriers is exactly the 1,543. So "recognized by BTS but
 * never filed a T-100 Segment row" is the COMMON case, not the exotic one: PA (Pan American
 * World Airways, three airline_ids, zero rows) reaches this branch by exactly the same path as
 * ZZ, which is in dim_carrier not at all. `routePair.ts` splits its two cases apart because it
 * can -- `lookup_airport_code_exists.sql` already existed to tell them apart. There is no
 * carrier equivalent, and M4d's spec rules out new SQL beyond the two reverse lookups, so this
 * says the thing that is true of both rather than guessing: it talks about FILINGS, not about
 * recognition. A sentence reading "unknown carrier code 'PA'" would be false.
 *
 * `AmbiguousCodeError` from the lookup is deliberately NOT caught. Carrier codes collide 0
 * times among fact-present airlines today (measured), so there is no fixture that could reach
 * a catch block here and any handling written for it would be untested code on the page's
 * happy path. A loud 500 is the documented contract (`resolve.ts`'s own header) and matches
 * what `/route` does with the identical error. `/aircraft` is where that error is reachable
 * on today's data, and where it must be rendered. */
export async function resolveCarrier(slug: string): Promise<CarrierResult> {
  const wanted = slug.trim().toUpperCase();
  if (wanted.length === 0) {
    return { kind: "notFound", reason: `expected a carrier code, got '${slug}'` };
  }

  const found = await lookupCarriersByCode([wanted]);
  const carrier = found.get(wanted);
  if (carrier === undefined) {
    return {
      kind: "notFound",
      reason:
        `no carrier with code '${wanted}' has filed a T-100 Segment row in this dataset ` +
        "(US DOT domestic segments, 2015 onwards)",
    };
  }

  // The canonical spelling is the one dim_carrier stores, not `wanted` -- so the redirect
  // target is always a code that really exists rather than an uppercasing of whatever was
  // typed.
  if (carrier.code !== slug) return { kind: "redirect", canonical: carrier.code };

  return {
    kind: "ok",
    carrier,
    canonical: carrier.code,
    filterValue: String(carrier.id),
  };
}
