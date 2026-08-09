import { healthReport, type GapProbe } from "@/lib/health";

/** Deliberately ABSENT from proxy.ts's matcher, and proxy.test.ts pins that.
 *
 * CLAUDE.md's rule is that a new route joins the matcher or it ships uncached and without the
 * raw-query and pathname headers. Here uncached is the REQUIREMENT, so this is the documented
 * exception rather than a silent omission: a route handler sets its own headers (/api/pivot
 * already does this for its errors), this endpoint takes no query so it needs no raw-query
 * header, and it has no not-found path so it needs no pathname header. The matcher's purpose
 * is to GRANT cacheability; this route must never have it.
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
export async function healthResponse(probe?: GapProbe): Promise<Response> {
  const report = await healthReport(probe);
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(): Promise<Response> {
  return healthResponse();
}
