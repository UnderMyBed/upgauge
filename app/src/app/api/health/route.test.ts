import { describe, expect, it } from "vitest";
import { GET, healthResponse } from "./route";

describe("/api/health", () => {
  it("is 200 and ok against the real database", async () => {
    // GET() takes no arguments and is what Next calls; healthResponse() is the injectable one.
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.data.asOf).toMatch(/^\d{4}-\d{2}$/);
    expect(body.data.missing).toEqual([]);
    expect(body.build).toEqual({ sha: "dev", warehouse: "dev" });
  });

  it("is never cached", async () => {
    const res = await GET();
    // `no-store` asserted exactly, not by substring: Next's own fallback header for a route
    // that never reached the proxy is `private, no-cache, no-store, max-age=0, must-revalidate`,
    // which CONTAINS "no-store". A substring check passes under the bug and this repo has
    // already been bitten by exactly that in smoke.sh's /search block.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is 503, not a throw, when the data layer is broken", async () => {
    // The endpoint's contract is that a broken data layer produces this JSON, never a 500.
    // Note this calls healthResponse(), NOT GET(): Next invokes GET(request), so a GET whose
    // first parameter was an injectable probe would receive a Request object as that probe --
    // `await probe()` would throw, healthReport() would catch it, and production would report
    // degraded on every single request while this test passed. The injection point is
    // deliberately a separate export for exactly that reason.
    const res = await healthResponse(async () => {
      throw new Error("IO Error: No files found that match the pattern");
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.data.missing.join(" ")).toContain("IO Error");
  });
});
