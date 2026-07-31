import { airportCodesExist, lookupAirportsByCode, type AirportRef } from "@/lib/resolve";

export type RoutePairResult =
  | { kind: "ok"; low: AirportRef; high: AirportRef; canonical: string; filterValue: string }
  | { kind: "redirect"; canonical: string }
  | { kind: "notFound"; reason: string };

/** Parse and canonicalise a /route/<pair> slug.
 *
 * Two orderings are in play and they are NOT the same, so both are computed explicitly:
 *
 *   canonical (the URL)     -- ALPHABETICAL by code. Storage order is an implementation
 *                              detail that should not leak into a URL, and alphabetical is
 *                              predictable from the two codes alone without consulting the
 *                              database.
 *   filterValue (the query) -- by AIRPORT ID, matching route_key_low/route_key_high.
 *
 * They disagree for 154 of 22,420 routes (0.69%, excluding the 530 same-airport "routes"
 * that are not routes -- docs/data/invariants.md § Route identity) -- verified: HPN (12197)
 * and BNH (16954), so id order is HPN-BNH while the alphabetical canonical is BNH-HPN.
 * Conflating them would query the wrong route for that 0.69%, or mint a URL nobody would
 * type. */
export async function resolveRoutePair(slug: string): Promise<RoutePairResult> {
  const parts = slug.split("-");
  if (parts.length !== 2 || !parts.every((p) => p.trim().length > 0)) {
    return { kind: "notFound", reason: `expected two airport codes joined by '-', got '${slug}'` };
  }
  const [rawA, rawB] = parts.map((p) => p.trim().toUpperCase());

  if (rawA === rawB) {
    return {
      kind: "notFound",
      reason: `'${rawA}' to itself is not a route between two airports`,
    };
  }

  const found = await lookupAirportsByCode([rawA, rawB]);
  const missing = [rawA, rawB].filter((c) => !found.has(c));
  if (missing.length > 0) {
    // Split "no such code" from "this dataset is domestic-only" where we can tell them
    // apart: a code T-100 Segment (domestic only -- CLAUDE.md's "Segment only" rule) never
    // carries a fact row for (LHR, CDG, NRT, MEX, YYZ, ...) still resolves in dim_airport's
    // own reference table (BTS's master list is global), so lookupAirportsByCode's
    // EXISTS-in-facts filter rejects it for the same reason a genuine typo does -- reading
    // as identical 404s. airportCodesExist re-checks the missing codes WITHOUT that filter
    // to tell the two apart. Neither branch changes the response kind (both stay a named
    // 404, never a silent resolve to an airport with zero possible query results).
    const recognized = await airportCodesExist(missing);
    const unknown = missing.filter((c) => !recognized.has(c));
    const domesticOnly = missing.filter((c) => recognized.has(c));
    const reasons: string[] = [];
    if (unknown.length > 0) {
      reasons.push(`unknown airport code '${unknown.join("', '")}'`);
    }
    if (domesticOnly.length > 0) {
      const isAre = domesticOnly.length === 1 ? "is a recognized airport code" : "are recognized airport codes";
      reasons.push(
        `'${domesticOnly.join("', '")}' ${isAre}, but this dataset is domestic-only ` +
          "(T-100 Segment) and carries no rows for it",
      );
    }
    return { kind: "notFound", reason: reasons.join("; ") };
  }

  const a = found.get(rawA)!;
  const b = found.get(rawB)!;
  const canonical = [a.code, b.code].sort().join("-");
  if (canonical !== slug) return { kind: "redirect", canonical };

  const [low, high] = a.id < b.id ? [a, b] : [b, a];
  return { kind: "ok", low, high, canonical, filterValue: `${low.id}-${high.id}` };
}
