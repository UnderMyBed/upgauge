import { lookupAirportsByCode, type AirportRef } from "@/lib/resolve";

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
 * They disagree for 154 of 22,950 routes (0.7%) -- verified: HPN (12197) and BNH (16954),
 * so id order is HPN-BNH while the alphabetical canonical is BNH-HPN. Conflating them would
 * query the wrong route for that 0.7%, or mint a URL nobody would type. */
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
    return { kind: "notFound", reason: `unknown airport code '${missing.join("', '")}'` };
  }

  const a = found.get(rawA)!;
  const b = found.get(rawB)!;
  const canonical = [a.code, b.code].sort().join("-");
  if (canonical !== slug) return { kind: "redirect", canonical };

  const [low, high] = a.id < b.id ? [a, b] : [b, a];
  return { kind: "ok", low, high, canonical, filterValue: `${low.id}-${high.id}` };
}
