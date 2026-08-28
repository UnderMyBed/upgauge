// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import RoutePage, { RouteView, generateMetadata } from "@/app/route/[pair]/page";
import { decode } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist } from "@/lib/db";
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
    // Scoped to `.entity .code` since M4c: the chart's subtitle names the same pair ("JFK–LAX ·
    // monthly · shaded by seats per departure"), so an unscoped getByText now matches twice and
    // throws. The header is what this test is about, and asserting on it directly is stricter
    // than the old any-match -- a page that rendered the pair only inside the chart would now
    // fail here rather than pass.
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    expect(container.querySelector(".entity .code")?.textContent).toBe("JFK–LAX");
    expect(screen.getByText(/Kennedy/i)).toBeDefined();
  });

  // Final whole-branch review, F5: the spec required "both airport names in the title block
  // -> /airport/<code>", and it was never carried in -- `{a.name} ↔ {b.name}` rendered as
  // plain text. Measured consequence: no page in the product links to /airport/ or /route/ at
  // all, so 23,556 of the sitemap's 23,780 URLs at the time (23,785 as of M6 Task 7, whose
  // five `/watch` pages do not change this 23,556 numerator) (/airport 1,047 + /route 22,509) have zero
  // inbound internal links. This is the fix at the one place that can carry it: both airport
  // halves of the title block link to their own /airport/<code>.
  it("links both airport names in the title block to their own /airport/<code>", async () => {
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    const ename = container.querySelector(".entity .ename");
    expect(ename).not.toBeNull();
    const links = [...ename!.querySelectorAll("a")];
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/airport/JFK");
    expect(hrefs).toContain("/airport/LAX");
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
    // route and window (same query the page runs): seats=3,464,803 pax=3,005,548. Fails if
    // the Passengers stat is removed, or if it's ever rendered from a different column
    // (e.g. seats again).
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    // Scoped to .stats: the carriers table below also has a "Passengers" column, so an
    // unscoped getByText would match twice and throw.
    const stats = container.querySelector(".stats");
    expect(stats?.textContent).toContain("Passengers");
    expect(stats?.textContent).toContain("3,005,548");
  });

  it("computes totals from summed parts, not by averaging the carrier rows", async () => {
    // The whole point: Sum(pax)/Sum(seats), never mean(per-carrier lf). Measured for this
    // route and window: seats 3,464,803, pax 3,005,548 -> 86.75%. A mean of the carrier
    // load factors gives a different number, so this assertion distinguishes them.
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText("86.75%")).toBeDefined();
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

  it("carries the fleet-shading methodology in the rail when a chart is drawn", async () => {
    // The rail is opt-in per encoding (LegendRail's own header): /explore draws no chart and
    // must not get this group, so the page has to ask for it. Fails if `fleetMix` is dropped
    // from the <LegendRail> call here, or if it is passed a constant `false`. The per-route
    // numbers (how many types Other holds, its share) are deliberately NOT here -- they are on
    // the chart's own key, next to the swatch they describe.
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText(/darkening stack is an upgauge/i)).toBeDefined();
  });

  it("states the finding for two real airports with no service", async () => {
    // Both codes resolve; nobody flies between them. That is data, not an error.
    render(await RoutePage({ params: Promise.resolve({ pair: "BNH-JFK" }) }));
    expect(screen.getByText(/no scheduled service/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /2015-01/ })).toBeDefined();
  });

  it("names the airports in the empty state in the same order as the header, not id order", async () => {
    // Minor, final whole-branch review: BNH-JFK is one of the 215 routes where id order
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

// M4c, Task 6: the mount. `AircraftMixChart` and everything under it had 262 green tests and a
// clean production build while being reachable from no route at all -- these tests, and the
// served-build checks in app/smoke.sh, are what make the component part of the product rather
// than part of the repository. What is asserted here is the WIRING: where the chart sits, which
// window it is given, and when it is drawn at all. The encoding itself (band membership vs
// shade, the COVID band, the annotation) belongs to AircraftMixChart.test.tsx and is not
// re-asserted through a live database render.
describe("/route/<pair> aircraft-mix chart", () => {
  it("draws the chart above the carriers table, not below it", async () => {
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    const svg = container.querySelector(".chart svg[role='img']");
    const table = container.querySelector("table");
    expect(svg).not.toBeNull();
    expect(table).not.toBeNull();
    // Position, not mere presence: a chart mounted under the table would satisfy every
    // existence check on this page while inverting the reading order the mockup and the
    // design system specify (the shape, then the rows that make it). DOCUMENT_POSITION_
    // FOLLOWING means `table` comes after `svg` in document order.
    expect(svg!.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("gives the chart the FULL window, not the table's trailing 12 months", async () => {
    // The one wiring bug this mount can have that still looks completely fine on screen: a
    // chart drawn over `query.timeFrom` (2025-05) instead of 2015-01 renders a perfectly
    // plausible twelve-point stacked area under a page that claims a decade. The chart's own
    // aria-label names the window it actually drew, so it is the honest witness -- read here
    // rather than counting paths, which a shorter window would not change. Fails if
    // `fetchAircraftMix` is handed TRAILING_12_FROM.
    const asOf = await dataAsOf();
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    const label = container.querySelector(".chart svg[role='img']")?.getAttribute("aria-label");
    expect(label).toContain(`2015-01 to ${asOf}`);
  });

  it("states both windows in the window line, since the page now shows two", async () => {
    // The `.window` line used to read "Trailing 12 months · ..." full stop, which became a
    // false claim the moment a 2015-2026 chart appeared above it. Fails if either range is
    // dropped from the line, and (unlike a check for the word "chart") it fails if the chart's
    // range is stated as anything other than the window the chart is actually given.
    const asOf = await dataAsOf();
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    const line = container.querySelector(".window")?.textContent ?? "";
    expect(line).toMatch(/trailing 12 months/i);
    expect(line).toContain(`2015-01 → ${asOf}`);
    expect(line).toMatch(/2025-\d\d → /);
  });

  it("names the range the chart actually draws, not the range it asked for", async () => {
    // ATL-CAK filed 67 months, 2015-01 to 2022-06, and nothing since (measured). The chart is
    // FETCHED over 2015-01 -> asOf but can only DRAW to 2022-06, and the x axis ends there.
    // Stating the requested window in the visible line put "2015-01 → 2026-04" over a chart
    // that stops in 2022 -- the same fabrication as interpolating a gap (M4c final review, F1),
    // and the exact inverse of the mistake the mount comment warns about: claiming a window
    // you are not drawing. The aria-label already said "2015-01 to 2022-06"; only the text a
    // sighted reader sees was wrong.
    //
    // Falsifiable, and not merely by the presence of a date: it fails if the line reverts to
    // the requested window, because asOf (2026-04) must NOT appear in it. Paired with the
    // JFK-LAX test above, which files every month and so must still show the full window --
    // an implementation that hard-coded either range fails one of the two.
    const asOf = await dataAsOf();
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "ATL-CAK" }) }),
    );
    const line = container.querySelector(".window")?.textContent ?? "";
    // Scoped to the chart half: asOf legitimately appears in the TABLE half, which really does
    // run to 2026-04. Asserting over the whole line would fail for the right answer.
    const chartHalf = line.slice(line.indexOf("chart:"));
    expect(chartHalf).toContain("2015-01 → 2022-06");
    expect(chartHalf).not.toContain(asOf);
    expect(chartHalf).not.toMatch(/full window/);
  });

  it("still draws the history when the trailing-12 table is empty", async () => {
    // ATL-CAK: 67 months of filings, none since 2022-06 (measured). 12,115 of this database's
    // route pairs last filed before the current trailing-12 window, so this is over half of
    // them, not an oddity. Gating the chart on `!isEmpty` -- the obvious way to write the
    // mount -- would blank the only panel on the page with anything in it, and would pass
    // every other test in this file.
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "ATL-CAK" }) }),
    );
    expect(container.querySelector(".chart svg[role='img']")).not.toBeNull();
    expect(screen.getByText(/no scheduled service/i)).toBeDefined();
  });

  it("draws no chart at all when there is nothing in the full window either", async () => {
    // BNH-JFK: zero rows over 2015-2026 (measured). The empty state below already states that
    // finding in words and offers the widened permalink; a chart frame saying "no aircraft-type
    // filings" under it would be a second panel making the same claim. Fails if the mount
    // becomes unconditional -- which the ATL-CAK test above cannot catch, since an
    // unconditional mount passes it.
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "BNH-JFK" }) }),
    );
    expect(container.querySelector(".chart")).toBeNull();
    expect(screen.getByText(/no scheduled service/i)).toBeDefined();
  });

  it("omits the fleet-shading legend group when no chart is drawn", async () => {
    // Same page, same rail: the methodology group must follow the chart, not the route. Fails
    // if `fleetMix` is hardcoded true.
    render(await RoutePage({ params: Promise.resolve({ pair: "BNH-JFK" }) }));
    expect(screen.queryByText(/darkening stack is an upgauge/i)).toBeNull();
  });
});

describe("/route/<pair> canonical metadata (M5, Task 2)", () => {
  // `http://localhost:3000` is `@/lib/siteUrl`'s own default with `UPGAUGE_BASE_URL` unset --
  // NOT a hardcoded production hostname (fix round 1, Critical 1). See
  // `src/lib/siteUrl.test.ts` for the env-var-override case; the point under test here is
  // that the resolved PAIR is correct, not the host.
  it("declares the canonical URL for an already-canonical pair", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ pair: "JFK-LAX" }) });
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/route/JFK-LAX");
  });

  it("declares the CANONICAL (alphabetical) spelling for a reversed request, not the request", async () => {
    // The bug to exclude (task-2-brief.md): emitting the requested spelling. LAX-JFK never
    // renders this page in production (it 308s first), but the canonical tag must still name
    // the alphabetical pair, not `/route/LAX-JFK`, an already-canonical fixture cannot fail.
    const meta = await generateMetadata({ params: Promise.resolve({ pair: "LAX-JFK" }) });
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/route/JFK-LAX");
  });

  it("returns no canonical for a pair that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ pair: "ZZZZ-LAX" }) });
    expect(meta.alternates?.canonical).toBeUndefined();
  });
});

// M9 Task 6b (og-cards FINDING 6): served `/route/JFK-LAX` and read the emitted tags -- `og:title`
// was "Upgauge" (the root layout's generic site title), not the route, because generateMetadata
// returned only `alternates.canonical`. The image already carries the entity; a pasted link's
// title did not.
describe("/route/<pair> Open Graph metadata (M9 Task 6b)", () => {
  it("carries the route pair in openGraph.title, matching the page's own heading", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ pair: "JFK-LAX" }) });
    // Same string routeTitle() produces for `.entity .code` (asserted above) and for the OG
    // image's own title -- en-dashed, not the raw hyphenated slug.
    expect(meta.openGraph?.title).toBe("JFK–LAX");
  });

  it("states the data view honestly in openGraph.description, without a fare or real-time claim", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ pair: "JFK-LAX" }) });
    const description = meta.openGraph?.description ?? "";
    expect(description).toContain("JFK–LAX");
    expect(description).toMatch(/US DOT T-100/);
    expect(description).toMatch(/not fares or real-time/i);
  });

  it("omits openGraph for a pair that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ pair: "ZZZZ-LAX" }) });
    expect(meta.openGraph).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// THE FLOOR PARTITION AT THIS CALL SITE (#127, review finding 1). See /carrier's copy of this
// block for why a component-level test cannot stand in for one here: `partition` defaults to
// true but /explore opts out, so a per-call-site opt-out is caught only by a test that reads
// this page's own rendered rows.
describe("/route/<pair> sorts below-floor rows last", () => {
  /** One rendered row of the carriers table: below-floor flag, and seats as the page printed
   * them (`null` for the absence marker, a different finding from 0). */
  function carrierRows(container: HTMLElement) {
    return [...container.querySelectorAll("table.data-table tbody tr")].map((tr) => {
      const seats = tr.querySelectorAll("td.num")[0]?.textContent ?? "";
      return {
        belowFloor: tr.getAttribute("data-below-floor") === "true",
        seats: seats === "\u2014" ? null : Number(seats.replace(/,/g, "")),
      };
    });
  }

  it("renders the below-floor carriers as one contiguous block at the foot", async () => {
    // MKE-ORD: 15 carrier rows in the trailing 12, 10 of them below floor.
    // MUTANT: `partition={false}` at page.tsx's DataTable -> red here only.
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "MKE-ORD" }) }),
    );
    const flags = carrierRows(container).map((r) => r.belowFloor);
    const first = flags.indexOf(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(flags.slice(0, first).length).toBeGreaterThan(0);
    expect(flags.slice(first).includes(false)).toBe(false);
  });

  it("still discriminates: a below-floor carrier here out-seats a scored one", async () => {
    // THE FIXTURE GUARD, AND IT IS EXECUTABLE -- this was a prose claim until the final review
    // caught that /route was the one call site the round's own remedy never reached. /airport
    // got a guard `it()`, /carrier two inline guards, /route a sentence.
    //
    // The sentence was also load-bearing and wrong: it said JFK-LAX "cannot be the fixture:
    // every carrier on it clears the floor". JFK-LAX does carry a below-floor carrier row, last
    // of five. It is unusable because the ORDERINGS AGREE there, which is the only property that
    // matters and is not the one the comment named.
    //
    // The population is against this test: over the 400 busiest routes in the trailing 12, 327
    // satisfy its assertions with the orderings already agreeing and only 2 disagree. MKE-ORD is
    // one of the two, so it is one refresh away from vacuous -- exactly the 4W disease this
    // branch invented the guard for.
    //
    // MECHANISM: a below-floor carrier (4,195 seats, 25 departures) out-seats a scored one
    // (2,924 seats, 45 departures), so the measure sort puts it at 5 of 15 and the partition has
    // to move it. If a refresh ends that, THIS goes red and the fixture moves; the test above
    // does not quietly stop testing anything.
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "MKE-ORD" }) }),
    );
    const rows = carrierRows(container);
    const seatsOf = (below: boolean) =>
      rows.filter((r) => r.belowFloor === below && r.seats !== null).map((r) => r.seats as number);
    expect(Math.max(...seatsOf(true))).toBeGreaterThan(Math.min(...seatsOf(false)));
  });
});
