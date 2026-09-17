import { healthReport, type AsOfFn, type GapProbe } from "@/lib/health";

/** Deliberately NOT declared in `QUERY_ROWS`, and canonicalQuery.test.ts pins that in `NOT_OURS`.
 *
 * `proxy.ts` runs on every request and sets both headers here as everywhere, but a route
 * `QUERY_ROWS` does not declare gets nothing more: no canonical-query gate, no Cache-Control
 * decision. Here uncached is the REQUIREMENT, so this is the documented exception rather than a
 * silent omission: a route handler sets its own headers (/api/pivot already does this for its
 * errors), this endpoint takes no query, and it has no not-found path. Declaring a route is what
 * lets the proxy GRANT cacheability; this route must never have it.
 *
 * 503 rather than 200-with-a-flag: Docker's HEALTHCHECK and any load balancer both need the
 * status line to mean "do not send traffic here". */
export const dynamic = "force-dynamic";

/** The injectable form, exported for tests only.
 *
 * The probe is NOT a parameter of GET. Next calls `GET(request)` -- a GET whose first parameter
 * was the probe would receive a Request object as that probe, `await probe()` would throw,
 * healthReport() would catch it, and production would report degraded on every request while a
 * test calling `GET()` with no arguments passed. Green suite, broken production, which is the
 * exact class app-smoke exists to catch. Keep the injection point out of the handler's
 * signature. */
export async function healthResponse(probe?: GapProbe, asOf?: AsOfFn): Promise<Response> {
  const report = await healthReport(probe, asOf);
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(): Promise<Response> {
  return healthResponse();
}
