// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import RoutePage, { RouteView } from "@/app/route/[pair]/page";
import { decode } from "@/lib/pivot/urlstate";
import { loadAllowlist } from "@/lib/db";
import { resolveRoutePair } from "@/lib/routePair";

/** `permanentRedirect`/`notFound` throw rather than return -- calling `RoutePage` on a slug
 * that hits either branch rejects the returned promise with that thrown Error. Narrows the
 * `unknown` catch value down to the one property both throw shapes carry, without assuming
 * anything else about it (Next does not export a typed shape for either). */
async function catchDigest(pair: string): Promise<string> {
  try {
    await RoutePage({ params: Promise.resolve({ pair }) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`RoutePage(${JSON.stringify(pair)}) did not throw`);
}

describe("/route/<pair>", () => {
  it("renders the route title and both airport names", async () => {
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText(/JFK–LAX/)).toBeDefined();
    expect(screen.getByText(/Kennedy/i)).toBeDefined();
  });

  it("shows DATA AS OF", async () => {
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("lists the carriers flying the route, by code", async () => {
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    const codes = [...container.querySelectorAll("tbody td.id")].map((c) => c.textContent);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((c) => /^[A-Z0-9]{2}$/.test(c ?? ""))).toBe(true);
  });

  it("shows the passengers stat", async () => {
    // Important 3, final whole-branch review: `routeTotals` already computed `passengers`
    // (it's the load-factor numerator) but nothing rendered it, though four docs -- CLAUDE.md,
    // features.md, system.md, and this spec's own mockup -- all listed it. Measured for this
    // route and window (same query the page runs): seats=3,455,820 pax=2,998,796. Fails if
    // the Passengers stat is removed, or if it's ever rendered from a different column
    // (e.g. seats again).
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    // Scoped to .stats: the carriers table below also has a "Passengers" column, so an
    // unscoped getByText would match twice and throw.
    const stats = container.querySelector(".stats");
    expect(stats?.textContent).toContain("Passengers");
    expect(stats?.textContent).toContain("2,998,796");
  });

  it("computes totals from summed parts, not by averaging the carrier rows", async () => {
    // The whole point: Sum(pax)/Sum(seats), never mean(per-carrier lf). Measured for this
    // route and window: seats 3,455,820, pax 2,998,796 -> 86.78%. A mean of the carrier
    // load factors gives a different number, so this assertion distinguishes them.
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText("86.78%")).toBeDefined();
  });

  // Fix round 1 (task-6, pre-implementation falsifiability check): the brief's own version of
  // this test asserted `link.getAttribute("href")).toContain("route%3A12478-12892")` -- i.e.
  // a percent-encoded ':' in the composite filter's key:value separator. Empirically false for
  // ANY href built through this codebase's actual machinery: a plain `<a href>` (verified) and
  // `next/link` (verified) both preserve a literal ':' through JSX -> DOM -> getAttribute, and
  // urlstate.ts's `encode()` never escapes that separator (only the key and values individually
  // go through `quote()` -- the ':' between them is a template-literal character). Forcing it
  // to `%3A` would require hand-encoding, which breaks the *real* link: `parseFilter` in
  // urlstate.ts finds the key:value separator via `raw.indexOf(":")` *before* unquoting, so a
  // pre-encoded `%3A` there makes `decode()` throw "malformed filter" the moment this link is
  // clicked -- exactly the "one click from the raw rows" promise this link exists to keep.
  // Round-tripping the real href through the real `decode()` is strictly more falsifiable than
  // pinning an encoding detail: it fails on a missing/extra filter, the wrong dimension, the
  // wrong measures, or -- the case this route specifically guards, per routePair.ts's own
  // header comment -- the id-order/alphabetical-order mismatch, since a swapped low/high would
  // decode to a *different*, wrong filter value rather than throwing.
  it("offers the same query in the Explorer", async () => {
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    const link = screen.getByRole("link", { name: /Explorer/i });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("/explore?")).toBe(true);
    const allowlist = await loadAllowlist();
    const query = decode(href.slice("/explore?".length), allowlist);
    expect(query.dimensions).toEqual(["op_airline_id"]);
    expect(query.filters).toEqual([["route", ["12478-12892"]]]);
  });

  it("shows the legend rail", async () => {
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText("Chart legend")).toBeDefined();
  });

  it("states the finding for two real airports with no service", async () => {
    // Both codes resolve; nobody flies between them. That is data, not an error.
    render(await RoutePage({ params: Promise.resolve({ pair: "BNH-JFK" }) }));
    expect(screen.getByText(/no scheduled service/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /2015-01/ })).toBeDefined();
  });

  it("names the airports in the empty state in the same order as the header, not id order", async () => {
    // Minor, final whole-branch review: BNH-JFK is one of the 154 routes where id order
    // (JFK's airport_id is lower, so low=JFK/high=BNH) disagrees with the alphabetical
    // canonical order the header uses (BNH first). The empty-state prose used to be built
    // from low/high (id order), so it read "...John F Kennedy (JFK) and ... (BNH)" directly
    // under a header reading "BNH–JFK" -- backwards. Fails if RouteEmptyState reverts to
    // low/high instead of the alphabetically-matched a/b.
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "BNH-JFK" }) }),
    );
    const text = container.textContent ?? "";
    const bnhInEmptyState = text.indexOf("(BNH)");
    const jfkInEmptyState = text.indexOf("(JFK)");
    expect(bnhInEmptyState).toBeGreaterThan(-1);
    expect(jfkInEmptyState).toBeGreaterThan(-1);
    expect(bnhInEmptyState).toBeLessThan(jfkInEmptyState);
  });
});

// Fix round 1, Finding 1: the redirect and notFound branches had zero committed coverage --
// verified working during initial development (permanentRedirect/notFound digest inspected
// by hand) and then deleted rather than kept, which meant nothing failing if
// `permanentRedirect` regressed to a temporary `redirect()` (307) or `notFound()` were
// dropped entirely. Both thrown shapes are read from the actual Next 16 source, not assumed
// (app/AGENTS.md's warning): node_modules/next/dist/client/components/redirect.js's
// `permanentRedirect()` throws `getRedirectError(url, type, RedirectStatusCode.
// PermanentRedirect)`, whose `.digest` is the literal string
// `NEXT_REDIRECT;${type};${url};${statusCode};` -- fully distinguishable from `redirect()`'s
// 307 (`RedirectStatusCode.TemporaryRedirect`) at the digest level, so this pins the exact
// string rather than hedging. node_modules/next/dist/client/components/not-found.js's
// `notFound()` throws an Error whose `.digest` is the literal `NEXT_HTTP_ERROR_FALLBACK;404`
// (http-access-fallback.js's `HTTP_ERROR_FALLBACK_ERROR_CODE` + the fixed 404 status).
describe("/route/<pair> redirect and 404", () => {
  it("redirects a reversed pair permanently (308) to the canonical URL", async () => {
    // Fails if the redirect branch is dropped (would throw "did not throw" instead), if
    // `permanentRedirect` regresses to plain `redirect()` (digest would end ';307;' instead
    // of ';308;'), or if the target path is wrong (wrong canonical, missing '/route/' prefix).
    const digest = await catchDigest("LAX-JFK");
    expect(digest).toBe("NEXT_REDIRECT;replace;/route/JFK-LAX;308;");
  });

  it("404s an unknown airport code", async () => {
    // Fails if notFound() is removed or replaced with a silent fallback, or if
    // resolveRoutePair's "unknown code" reason stops reaching this page's notFound() branch.
    const digest = await catchDigest("ZZZZ-LAX");
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("404s a slug that is not two codes", async () => {
    // A DIFFERENT resolveRoutePair reason (routePair.ts: "expected two airport codes joined
    // by '-'") than the unknown-code case above -- exercises a distinct code path through the
    // same notFound() call, so a future regression that special-cased only one reason would
    // still be caught here even if the "unknown code" test above kept passing.
    const digest = await catchDigest("JFK");
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

// Fix round 1, Finding 2: `truncated` and its disclosure footer were real code reachable only
// when a route's row count hits ROUTE_CARRIER_LIMIT (50) -- JFK-LAX has 5 operating carriers
// in the real trailing-12-month window (measured against upgauge.duckdb), so nothing in
// production data exercised either branch. `RouteView` (exported from page.tsx, split out of
// the default-exported `RoutePage` the same way explore/page.tsx splits `ExploreView` from
// `ExplorePage`) takes `limit` as an explicit, defaultable parameter, so these tests drive a
// real, live-database render -- genuine SQL LIMIT against genuine JFK-LAX rows, not a mock or
// a synthetic row array (this codebase has no mocks, lib/resolve.ts's header comment) -- with
// a limit small enough for the real 5-carrier result to actually reach it.
describe("/route/<pair> truncation disclosure", () => {
  it("discloses when the carrier limit is reached", async () => {
    // 5 real candidates, limit 3 -> SQL LIMIT returns exactly 3 rows, 3 >= 3. Fails if
    // `truncated`'s `rows.length >= limit` regressed to `>` (3 rows would then read as NOT
    // truncated, since 3 > 3 is false), or if the disclosure paragraph were removed.
    const pair = await resolveRoutePair("JFK-LAX");
    if (pair.kind !== "ok") throw new Error("expected JFK-LAX to resolve for this fixture");
    render(
      await RouteView({
        low: pair.low,
        high: pair.high,
        canonical: pair.canonical,
        filterValue: pair.filterValue,
        limit: 3,
      }),
    );
    expect(screen.getByText(/top 3 carriers/i)).toBeDefined();
  });

  it("does not disclose below the carrier limit", async () => {
    // Same query, a limit (50, the real ROUTE_CARRIER_LIMIT) the real 5-row result does not
    // reach. Fails if the disclosure paragraph rendered unconditionally (e.g. a `truncated`
    // that got hardcoded to `true`) -- the previous test alone could not catch that, since
    // both would then show the notice.
    const pair = await resolveRoutePair("JFK-LAX");
    if (pair.kind !== "ok") throw new Error("expected JFK-LAX to resolve for this fixture");
    render(
      await RouteView({
        low: pair.low,
        high: pair.high,
        canonical: pair.canonical,
        filterValue: pair.filterValue,
      }),
    );
    expect(screen.queryByText(/top \d+ carriers/i)).toBeNull();
  });
});
