import { entitySlugFromPath } from "@/lib/entitySlug";
import { carrierHoldersByCode, lookupCarriersByCode, type CarrierRef } from "@/lib/resolve";

export type CarrierResult =
  | { kind: "ok"; carrier: CarrierRef; canonical: string; filterValue: string }
  | { kind: "redirect"; canonical: string }
  /** `holders` is every `dim_carrier` row carrying this code, in the order
   *  `lookup_carrier_code_exists.sql` returned them -- EMPTY when the code is nowhere in
   *  `dim_carrier` at all, which is the unknown-vs-recognized split `carrierNotFoundReason`
   *  below words. It rides on the result rather than being left for the caller to re-derive:
   *  this function has already paid for the query (it needs the holders to word `reason`), and
   *  a caller that wants them otherwise has to make the SAME `carrierHoldersByCode` call a
   *  second time -- which is what `/aircraft/:name?carrier=`'s filter did, running THREE carrier
   *  queries per refused code where two is the floor (the refusal needs one lookup to learn the
   *  code is not fact-present and one to learn who holds it). Measured under one protocol, warm,
   *  mean of 30: 9.42 ms before, 7.32 ms after -- the removed `lookup_carrier_code_exists` costs
   *  1.40 ms measured alone, and the saving is that query and nothing more. Exactly the precedent
   *  `AmbiguousCodeError` already sets by carrying its `ids` instead of making the caller
   *  re-parse a message (`resolve.ts`), and `AircraftSlugResult.ambiguous` by carrying its. */
  | { kind: "notFound"; reason: string; holders: CarrierRef[] };

/** The `/carrier/<code>` slug's prefix, and the reader for it.
 *
 * Sibling of `rawPath.ts`'s `ROUTE_PREFIX`/`routeSlugFromPath` and it exists for the same two
 * consumers: `proxy.ts`, which has to know whether a request is a real carrier before the page
 * runs so a 404 gets `no-store` rather than a month of CDN cache, and `not-found.tsx`, which
 * has no props and no route params (Next's `not-found.js` convention) and so can only learn
 * the requested code from `proxy.ts`'s `RAW_PATH_HEADER`. */
export const CARRIER_PREFIX = "/carrier/";

// A one-line wrapper around lib/entitySlug.ts's entitySlugFromPath. This file used to carry
// its own copy of the decode guard (deliberately, at the time -- M4d built three of these
// pages concurrently and rawPath.ts is one file three tasks would have been editing at once).
// M5 Task 6 is the collapse that comment always pointed at. The wrapper (and CARRIER_PREFIX
// above) stays, unchanged in name and behaviour, so nothing importing carrierSlugFromPath
// needs an edit.
export function carrierSlugFromPath(pathname: string): string | null {
  return entitySlugFromPath(pathname, CARRIER_PREFIX);
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
 *   notFound -- names the code, and -- since M5 Task 6 -- splits WHY.
 *
 * `routePair.ts` has always split its 404 two ways -- unknown code versus a real, recognized
 * airport this domestic-only dataset simply has no rows for -- because
 * `lookup_airport_code_exists.sql` existed to tell them apart. This file used to say there was
 * no carrier equivalent and settle for one sentence true of both cases; M5 Task 6 is that
 * equivalent, `sql/03_queries/lookup_carrier_code_exists.sql`, and `carrierNotFoundReason`
 * below is the split it enables:
 *
 *   unknown      -- the code is in `dim_carrier` not at all. ZZ is the measured example.
 *   recognized   -- the code is in `dim_carrier` but every holder has zero T-100 Segment rows.
 *                   1,543 of `dim_carrier`'s 1,657 DISTINCT codes land here (measured; 1,776 is
 *                   the table's ROW count, one per `airline_id`, and 1,657 - 114 fact-present
 *                   carriers is exactly the 1,543), so this is the COMMON carrier 404, not the
 *                   exotic one. It is worded to name EVERY holder, not just the first: `PA`
 *                   alone names three (`airline_id` 20384 and 20386, both "Pan American World
 *                   Airways", plus 20389 "Florida Coastal Airlines", an unrelated carrier that
 *                   happens to share the code) -- 94 of the 1,543 never-filed codes name more
 *                   than one airline this way (measured; worst case 3, `PA`). A sentence
 *                   naming only the first holder is the exact silent-pick failure `AUS`
 *                   (docs/data/invariants.md § Entity resolution) already cost this project
 *                   once, one dimension over.
 *
 * `AmbiguousCodeError` from `lookupCarriersByCode` is deliberately NOT caught. Carrier codes
 * collide 0 times among fact-present airlines today (measured), so there is no fixture that
 * could reach a catch block here and any handling written for it would be untested code on
 * the page's happy path. A loud 500 is the documented contract (`resolve.ts`'s own header) and
 * matches what `/route` does with the identical error. `/aircraft` is where that error is
 * reachable on today's data, and where it must be rendered. */
export async function resolveCarrier(slug: string): Promise<CarrierResult> {
  const wanted = slug.trim().toUpperCase();
  if (wanted.length === 0) {
    return { kind: "notFound", reason: `expected a carrier code, got '${slug}'`, holders: [] };
  }

  const found = await lookupCarriersByCode([wanted]);
  const carrier = found.get(wanted);
  if (carrier === undefined) {
    const holders = (await carrierHoldersByCode([wanted])).get(wanted) ?? [];
    return { kind: "notFound", reason: carrierNotFoundReason(wanted, holders), holders };
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

/** The two-way split `resolveCarrier`'s own header documents. `holders` is
 * `carrierHoldersByCode`'s result for `code` -- empty means the code is nowhere in
 * `dim_carrier`; non-empty means it is, but zero of its holders have filed a T-100 Segment
 * row, and every one of them is named, in the order `lookup_carrier_code_exists.sql` returned
 * them (driver row order, not sorted -- unlike `/aircraft`'s ambiguity page, this is prose in
 * a single `<p>`, not a list of links a reader could compare across page loads, so a stable
 * ordering is not load-bearing here the way `aircraftSlug.ts`'s not-found sort is). */
function carrierNotFoundReason(code: string, holders: CarrierRef[]): string {
  if (holders.length === 0) {
    return `unknown carrier code '${code}'`;
  }
  const named = holders.map((h) => `${h.name}, airline_id ${h.id}`).join("; ");
  const countWord = holders.length === 1 ? "one airline id" : `${holders.length} airline ids`;
  return (
    `'${code}' is recognized by BTS under ${countWord} (${named}), none of which has filed a ` +
    "T-100 Segment row in this dataset (US DOT domestic segments, 2015 onwards)"
  );
}
