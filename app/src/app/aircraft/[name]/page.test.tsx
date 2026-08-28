// @vitest-environment jsdom

// `next/headers` throws "called outside a request scope" when invoked directly in a test -- the
// same reason `/airport`'s page test carries this identical mock, and for the identical cause:
// #106 gave this page's REDIRECT branch a `headers()` call, so that the raw query survives the
// case-normalization 308 instead of being silently dropped. That branch is already exercised by
// the pre-existing lowercase-redirect test below, so the module has to be mocked rather than
// left real. The factory awaits a dynamic `import()` for `RAW_QUERY_HEADER` -- a top-level
// import binding referenced inside `vi.mock` would break on hoisting, since `vi.mock` calls are
// hoisted above every import statement in the file.
import { vi } from "vitest";
vi.mock("next/headers", async () => {
  const { RAW_QUERY_HEADER } = await import("@/lib/rawQuery");
  // Default: an empty raw query, matching a bare request with no `?` at all -- which is what
  // keeps every PRE-EXISTING test in this file (none of which anticipated `headers()` being
  // called) passing unmodified, including the lowercase-redirect digest, which must stay exactly
  // the bare canonical path with no stray `?`.
  return { headers: vi.fn(async () => new Headers({ [RAW_QUERY_HEADER]: "" })) };
});
import { describe, expect, it } from "vitest";
import { headers } from "next/headers";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { render, screen } from "@testing-library/react";
import AircraftPage, {
  AircraftView,
  aircraftRedirectTarget,
  generateMetadata,
} from "@/app/aircraft/[name]/page";
import { decode } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist, runPivot } from "@/lib/db";
import { resolveAircraftSlug } from "@/lib/aircraftSlug";
import { resolveCarrierFilter } from "@/lib/map/mapFilter";
import { AIRCRAFT_CARRIER_LIMIT, trailing12Query } from "@/lib/entityFacts";

/** `permanentRedirect`/`notFound` throw rather than return -- calling `AircraftPage` on a slug
 * that hits either branch rejects with that thrown Error. Same narrowing as
 * route/[pair]/page.test.tsx: the one property both throw shapes carry, nothing else assumed. */
async function catchDigest(name: string): Promise<string> {
  try {
    await AircraftPage({ params: Promise.resolve({ name }) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`AircraftPage(${JSON.stringify(name)}) did not throw`);
}

function page(name: string) {
  return AircraftPage({ params: Promise.resolve({ name }) });
}

/** The page as `proxy.ts` hands it over: the map filter arrives on `RAW_QUERY_HEADER` as raw,
 * still-percent-encoded bytes, and never through `searchParams`.
 *
 * DRIVEN THROUGH `AircraftPage`, not `AircraftView`, and that is the point of this helper. A
 * test that called the view directly would pass the filter value in by hand and so could not
 * tell a header read from a `searchParams` read -- and which of those two this page does is the
 * whole of #106's admission policy here (`AircraftPage`'s own comment has the argument). */
function filtered(name: string, rawQuery: string) {
  vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: rawQuery }));
  return AircraftPage({ params: Promise.resolve({ name }) });
}

/** `B737-8` resolved once, for the tests that need to drive `AircraftView`'s explicit inputs
 * (the row limit) rather than a request. Same shape, same reason, as /airport's `view(limit)`. */
async function view(opts: { limit?: number; carrierFilter?: string | null } = {}) {
  const r = await resolveAircraftSlug("B737-8");
  if (r.kind !== "ok") throw new Error("expected B737-8 to resolve for this fixture");
  return await AircraftView({ type: r.type, canonical: r.canonical, ...opts });
}

describe("/aircraft/<slug>", () => {
  it("renders the short name and the full BTS designation", async () => {
    // The short_name is the display code and the slug; the `name` is what makes it legible.
    // Scoped to `.entity .code` because the chart's subtitle names the same type.
    const { container } = render(await page("B737-8"));
    expect(container.querySelector(".entity .code")?.textContent).toBe("B737-8");
    expect(screen.getByText(/BOEING 737-800/)).toBeDefined();
    // Never the raw BTS code, which is the M4a rule this page is the newest instance of: 612
    // is the 737-700, not the A321, and '614' means nothing to a reader.
    expect(container.querySelector(".entity")?.textContent).not.toContain("614");
  });

  it("shows DATA AS OF", async () => {
    render(await page("B737-8"));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("renders a type whose short name is not a URL path segment", async () => {
    // `/aircraft/A320-1/2` is two path segments and unroutable, so this page is reachable ONLY
    // through the slug transform. Falsifiable end to end: remove it and this 404s, while every
    // B737-8 test above stays green -- which is exactly how the spec's own worked example got
    // through design review.
    const { container } = render(await page("A320-1-2"));
    expect(container.querySelector(".entity .code")?.textContent).toBe("A320-1/2");
    expect(screen.getByText(/AIRBUS INDUSTRIE A320-100\/200/)).toBeDefined();
  });

  it("lists the operating carriers of the type, by code", async () => {
    const { container } = render(await page("B737-8"));
    const codes = [...container.querySelectorAll("tbody td.id")].map((c) => c.textContent);
    // Measured: 7 carriers operated the 737-800 in the trailing 12 months.
    expect(codes).toHaveLength(7);
    expect(codes.every((c) => /^[A-Z0-9]{2}$/.test(c ?? ""))).toBe(true);
    expect(codes).toContain("WN");
  });

  it("computes the stat strip from summed parts, not by averaging the carrier rows", async () => {
    // Measured over the trailing 12 months (2025-06..2026-05) for BTS type 614:
    // seats 165,826,686 · passengers 129,838,662 · departures 970,584.
    // Sum(pax)/Sum(seats) = 78.30%; Sum(seats)/Sum(dep) = 170.9. A mean of the seven carrier
    // rows gives different numbers for both, so these two assertions distinguish them --
    // CLAUDE.md's #1 bug in every homemade T-100 tool.
    const { container } = render(await page("B737-8"));
    const stats = container.querySelector(".stats")!.textContent ?? "";
    expect(stats).toContain("165,826,686");
    expect(stats).toContain("129,838,662");
    expect(stats).toContain("78.30%");
    expect(stats).toContain("170.9");
    expect(stats).toContain("Carriers");
  });

  it("offers the same query in the Explorer", async () => {
    // Round-tripped through the real decode(), like /route's: it fails on a missing or extra
    // filter, the wrong dimension, or an int-parsed aircraft code -- '614' is not zero-padded,
    // but the filter value must still travel as the string the catalog is keyed on.
    render(await page("B737-8"));
    const href = screen.getByRole("link", { name: /Explorer/i }).getAttribute("href") ?? "";
    expect(href.startsWith("/explore?")).toBe(true);
    const query = decode(href.slice("/explore?".length), await loadAllowlist());
    expect(query.dimensions).toEqual(["op_airline_id"]);
    expect(query.filters).toEqual([["aircraft_type", ["614"]]]);
    expect(query.grouping).toBe("operating");
  });

  it("draws the mix chart stacked by carrier, above the table", async () => {
    // The whole reason this page does not reuse the type stack: a page that IS one aircraft
    // type would draw a single band whose gauge ordering encodes nothing. Falsifiable against
    // the degenerate version -- the title names the dimension, and the type stack would render
    // "Seats by aircraft type" with one band.
    const { container } = render(await page("B737-8"));
    expect(container.querySelector(".chart .ctitle")?.textContent).toBe(
      "Seats by operating carrier",
    );
    const svg = container.querySelector(".chart svg[role='img']");
    const table = container.querySelector("table");
    expect(svg).not.toBeNull();
    expect(svg!.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Five bands and an Other, all seven carriers accounted for -- and the aria-label is the
    // honest witness for the window, as on /route.
    const label = svg!.getAttribute("aria-label")!;
    expect(label).toContain("monthly seats by operating carrier");
    expect(label).toContain(`2015-01 to ${await dataAsOf()}`);
  });

  it("shades the carrier bands by cabin density, lightest first", async () => {
    // Measured, full window, BTS 614: WN 175.0 seats/departure (the most seats AND the densest
    // cabin) down to AS 159.8 (the fewest seats AND the least dense). Seats order and gauge
    // order are EXACT reverses on this type, so a single sort mislabels all five swatches --
    // this is the live-data half of the fixture in lib/chart/aircraftMix.test.ts.
    const { container } = render(await page("B737-8"));
    const shaded = ["--g1", "--g2", "--g3", "--g4", "--g5"].map(
      (t) => container.querySelector(`.ckey [data-token="${t}"]`)?.textContent,
    );
    expect(shaded[0]).toContain("AS");
    expect(shaded[4]).toContain("WN");
  });

  it("carries the carrier-stack methodology in the rail, not the type-stack one", async () => {
    // Every band on this page is the same airframe, so "larger metal" and "the five types with
    // the most seats" would both be false sentences in the panel whose job is telling a reader
    // how to read the chart next to it.
    render(await page("B737-8"));
    expect(screen.getByText(/five carriers with the most seats/i)).toBeDefined();
    expect(screen.queryByText(/five types with the most seats/i)).toBeNull();
  });

  it("states both windows, since the table and the chart do not share one", async () => {
    const asOf = await dataAsOf();
    const { container } = render(await page("B737-8"));
    const line = container.querySelector(".window")?.textContent ?? "";
    expect(line).toMatch(/trailing 12 months/i);
    expect(line).toContain(`2015-01 → ${asOf}`);
  });
});

describe("/aircraft/<slug> for a zero-padded BTS code", () => {
  it("renders the CESSNA 172, whose code is '036' and not 36", async () => {
    // CLAUDE.md's zero-padding rule, exercised end to end rather than asserted in a comment.
    // Every other type on this page (614, 655, 699) is a three-digit code that survives an
    // int-parse unchanged, so nothing else here can catch `Number(type.id)` in the filter --
    // and 13 fact-present types carry a leading zero. Under that mutation the filter becomes
    // '36', matches no rows, and this page renders the empty state for a type that flew in 120
    // months. Measured: 3 operating carriers in the trailing 12 months, 5 over the full window.
    const { container } = render(await page("SKYHAWK"));
    expect(container.querySelector(".entity .code")?.textContent).toBe("SKYHAWK");
    expect(container.querySelector(".empty-state")).toBeNull();
    expect([...container.querySelectorAll("tbody td.id")]).toHaveLength(3);
  });
});

describe("/aircraft/<slug> redirect and 404", () => {
  // #106. This redirect used to build `/aircraft/B737-8` from the slug alone, silently dropping
  // every query key -- so `/aircraft/b737-8?carrier=DL` would have 308ed to `/aircraft/B737-8` with the
  // filter gone entirely, and the destination would have rendered the unfiltered view with no
  // error anywhere. The identical measured bug `/airport` fixed with `airportRedirectTarget`.
  //
  // Asserting the digest STRING, not merely that a redirect fired: "a redirect happened" is true
  // both before and after the fix, so the test immediately below would keep passing under the
  // bug. The string is what discriminates.
  it("preserves a filter query across the case-normalization redirect", async () => {
    vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: "carrier=DL" }));
    expect(await catchDigest("b737-8")).toBe(
      "NEXT_REDIRECT;replace;/aircraft/B737-8?carrier=DL;308;",
    );
  });

  it("preserves an UNRESOLVABLE filter across the same redirect, rather than dropping it", async () => {
    // A redirect that stripped a bad filter would be the same silent-fallback bug in a different
    // coat: the canonical URL must reach the same refusal the direct URL does -- `no-store` from
    // proxy.ts, and (once #107/#108 land the page surface) a named error -- not quietly render
    // the unfiltered view because the redirect erased the evidence anything was wrong.
    vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: "carrier=ZZ" }));
    expect(await catchDigest("b737-8")).toBe(
      "NEXT_REDIRECT;replace;/aircraft/B737-8?carrier=ZZ;308;",
    );
  });

  it("appends nothing for an empty raw query, rather than a stray '?'", () => {
    // The bare-request case, and the reason the helper tests the LENGTH rather than appending
    // unconditionally: every pre-existing redirect on this page carries no query at all.
    expect(aircraftRedirectTarget("B737-8", "")).toBe("/aircraft/B737-8");
    expect(aircraftRedirectTarget("B737-8", "carrier=DL")).toBe("/aircraft/B737-8?carrier=DL");
  });

  it("passes the raw query through VERBATIM, without re-encoding it", () => {
    // Reassembling a query from decoded params is the corruption `lib/rawQuery.ts`'s header
    // exists to prevent -- a `,` inside a value becomes indistinguishable from a separator. This
    // helper concatenates bytes and must never normalize them.
    expect(aircraftRedirectTarget("B737-8", "carrier=%42%37")).toBe("/aircraft/B737-8?carrier=%42%37");
  });

  it("redirects a lower-case slug permanently (308) to the canonical URL", async () => {
    // Fails if the redirect branch is dropped, if `permanentRedirect` regresses to plain
    // `redirect()` (digest would end ';307;'), or if the target carries the raw short name --
    // `/aircraft/A320-1/2` is unroutable, so the canonical MUST be the slug.
    expect(await catchDigest("a320-1-2")).toBe("NEXT_REDIRECT;replace;/aircraft/A320-1-2;308;");
  });

  it("404s an unknown short name", async () => {
    expect(await catchDigest("NOPE-1")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("404s a slug that names two airframes rather than picking one", async () => {
    // CE-180 is a REACHABLE URL: codes 030 and 031 both really flew under that short name.
    // A distinct code path from the unknown-slug case above (AmbiguousCodeError, caught), so a
    // regression that special-cased only one would still be caught here.
    expect(await catchDigest("CE-180")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("/aircraft/<slug> canonical metadata (M5, Task 2)", () => {
  it("declares the canonical URL for an already-canonical slug", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ name: "B737-8" }) });
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/aircraft/B737-8");
  });

  it("declares the UPPERCASED slug for a lowercase request, not the request", async () => {
    // The bug to exclude, same shape as /airport/sea: emitting the requested spelling.
    // /aircraft/a320-1-2 never renders this page in production (it 308s first), but the
    // canonical tag must still name the uppercased slug -- never the unroutable raw short
    // name (`A320-1/2`) either.
    const meta = await generateMetadata({ params: Promise.resolve({ name: "a320-1-2" }) });
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/aircraft/A320-1-2");
  });

  it("returns no canonical for a slug that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ name: "NOPE-1" }) });
    expect(meta.alternates?.canonical).toBeUndefined();
  });

  it("returns no canonical for an ambiguous slug -- there is no one URL to declare", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ name: "CE-180" }) });
    expect(meta.alternates?.canonical).toBeUndefined();
  });
});

// M9 Task 6b (og-cards FINDING 6): same finding as /route's -- `og:title` read "Upgauge" on a
// served /aircraft/B737-8, not the type, because generateMetadata returned only
// `alternates.canonical`.
describe("/aircraft/<slug> Open Graph metadata (M9 Task 6b)", () => {
  it("carries the short name AND the full designation in openGraph.title, not the code alone", async () => {
    // Fix round 1: `title: code` alone matched `.entity .code` (asserted above) but dropped
    // `.entity .ename` -- a pasted link previewing as bare "B737-8" delivers half the entity,
    // and `og:title` has no second line the way the OG image's title/subtitle split does.
    // Pinned to the exact string measured against the real warehouse (`dim_aircraft_type`'s
    // own full BTS designation, all-caps as filed), not a substring match. `code` stays the
    // short_name, never the raw BTS code (M4a's rule).
    const meta = await generateMetadata({ params: Promise.resolve({ name: "B737-8" }) });
    expect(meta.openGraph?.title).toBe("B737-8 — BOEING 737-800");
  });

  it("states the data view honestly in openGraph.description, without a fare or real-time claim", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ name: "B737-8" }) });
    const description = meta.openGraph?.description ?? "";
    expect(description).toContain("B737-8");
    expect(description).toMatch(/US DOT T-100/);
    expect(description).toMatch(/not fares or real-time/i);
  });

  it("omits openGraph for a slug that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ name: "NOPE-1" }) });
    expect(meta.openGraph).toBeUndefined();
  });

  it("omits openGraph for an ambiguous slug -- there is no one type to name", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ name: "CE-180" }) });
    expect(meta.openGraph).toBeUndefined();
  });
});

describe("/aircraft/<slug> for a type that has stopped flying", () => {
  // The MD-80: 68 filed months, 2015-01 to 2023-04, and nothing since (measured). The trailing
  // 12-month table is empty and the chart is the only panel on the page with anything in it --
  // the same shape as /route's ATL-CAK, and on this page it is the retirement story itself.
  it("still draws the history when the trailing-12 table is empty", async () => {
    const { container } = render(await page("MD-80"));
    expect(container.querySelector(".chart svg[role='img']")).not.toBeNull();
    // Scoped to the empty state: the chart's own key also says "N months with no filings" for
    // this type (it filed 68 of the 100 months it spans), so an unscoped text match finds two
    // nodes and throws -- and would have been satisfied by the chart alone, which is the
    // opposite of what this test is about.
    expect(container.querySelector(".empty-state")?.textContent).toMatch(
      /No filings for MCDONNELL DOUGLAS .*\(MD-80\)/,
    );
    // Gating the chart on `!isEmpty` -- the obvious way to write the mount -- blanks the only
    // panel with anything in it, and would pass every other test in this file.
    expect(screen.getByRole("link", { name: /2015-01/ })).toBeDefined();
  });

  it("names the range the chart actually draws, not the range it asked for", async () => {
    const asOf = await dataAsOf();
    const { container } = render(await page("MD-80"));
    const line = container.querySelector(".window")?.textContent ?? "";
    const chartHalf = line.slice(line.indexOf("chart:"));
    expect(chartHalf).toContain("2015-01 → 2023-04");
    expect(chartHalf).not.toContain(asOf);
  });
});

/** #108: the carrier x aircraft-type network map, entered from the type side.
 *
 * FIXTURES, measured against this warehouse over the trailing 12 to 2026-05 (B737-8 is BTS code
 * 614): WN files 1,318 distinct undirected pairs on it and AS files 325, against a
 * `NETWORK_ARC_CAP` of 400. Neither carrier has a quarantined or a same-airport group on this
 * type, so WN's map carries exactly one disclosure sentence and AS's carries none -- which is
 * what makes the pair able to tell a conditional cap note from an unconditional one. One page,
 * two sides of one boundary.
 *
 * The counts are asserted as a PATTERN, never as the literal 1,318: a BTS refresh moves it, and
 * a fixture that has to be re-typed every month is a fixture that gets deleted. */
describe("/aircraft/<slug> network map (#108)", () => {
  it("draws no map until a carrier is chosen, and says why", async () => {
    // The map query needs BOTH halves -- one carrier and one type -- so an unfiltered page
    // issues none at all. The bug this catches is the obvious mount, `<SegmentMap map={map}/>`
    // ungated, which on a null map throws, and whose "fixed" form (drawing every carrier's
    // routes) answers a different question than the one the page asks.
    const { container } = render(await page("B737-8"));
    expect(container.querySelector("[data-testid='segment-map']")).toBeNull();
    expect(container.querySelector("[data-testid='map-picker']")).not.toBeNull();
    expect(container.textContent).toContain("Pick a carrier to draw the routes it flew this type on");
  });

  it("draws the map once a carrier is chosen", async () => {
    const { container } = render(await filtered("B737-8", "carrier=AS"));
    const map = container.querySelector("[data-testid='segment-map']");
    expect(map).not.toBeNull();
    // Scoped INSIDE the map: the aircraft-mix chart on this same page also emits an
    // `svg[role='img']`, so an unscoped query is satisfied by the chart alone and this test
    // would stay green with the map removed entirely.
    expect(map?.querySelector("svg[role='img']")).not.toBeNull();
    expect(container.textContent).not.toContain("Pick a carrier to draw");
  });

  it("refuses a percent-spelling instead of decoding it into a filter", async () => {
    // `%57%4E` percent-decodes to `WN`. THE PRODUCTION HALF OF THIS IS IN app/smoke.sh: no unit
    // test can cross Next's own decoding of `searchParams`, so what this one pins is the half
    // that is visible from here -- the page resolves the RAW bytes, so a value `proxy.ts`
    // refused (and declined to cache) is refused by the page too. Reading it off `searchParams`
    // instead would hand this page `WN` and draw WN's map under a URL the server rejected.
    const { container } = render(await filtered("B737-8", "carrier=%57%4E"));
    expect(container.querySelector("[data-testid='segment-map']")).toBeNull();
    // The resolver's own curated reason, wired through rather than swallowed for a generic
    // message -- it is the only thing that says WHICH way this value failed.
    expect(container.textContent).toContain("without percent-encoding");
    expect(container.textContent).toContain("%57%4E");
  });

  it("refuses an ambiguous carrier code and names every holder, in id order", async () => {
    // `/carrier/PA` holds THREE airline_ids -- two Pan Am eras plus an unrelated Florida
    // Coastal -- and picking one is the silent-pick failure this project has already paid for.
    // Asserting a count of three alone would pass under an implementation that named the same
    // holder three times; asserting the ORDER as well pins the resolver's sort, which exists so
    // one URL does not render two ways across restarts.
    const { container } = render(await filtered("B737-8", "carrier=PA"));
    expect(container.querySelector("[data-testid='segment-map']")).toBeNull();
    const holders = [...container.querySelectorAll("[data-testid='mp-holder']")].map(
      (li) => li.textContent ?? "",
    );
    expect(holders).toEqual([
      "Pan American World Airways (airline_id 20384)",
      "Pan American World Airways (airline_id 20386)",
      "Florida Coastal Airlines (airline_id 20389)",
    ]);
    // The id suffix is load-bearing and this fixture proves it: the two Pan Am rows really are
    // BYTE-IDENTICAL by name, so a bare name list would print one string twice and tell a reader
    // nothing about why the code cannot resolve. The unrelated carrier is the third.
    expect(container.textContent).toContain("Florida Coastal Airlines");
  });

  it("states the cap when it hit one, and states nothing when it did not", async () => {
    // A cap note rendered UNCONDITIONALLY reads "325 of 325 routes drawn." under AS and looks
    // entirely plausible, so the over-cap half alone cannot catch it. The negative is written
    // against the REAL sentence, never a substring that happens to be absent from both.
    const over = render(await filtered("B737-8", "carrier=WN")).container;
    expect(over.querySelector("[data-testid='map-notes']")?.textContent).toMatch(
      /^400 of [\d,]+ routes drawn\./,
    );

    const under = render(await filtered("B737-8", "carrier=AS")).container;
    // Positive first, so the absence below cannot pass vacuously on a page that drew no map.
    expect(under.querySelector("[data-testid='segment-map']")).not.toBeNull();
    expect(under.querySelector("[data-testid='map-notes']")?.textContent ?? "").not.toMatch(
      /routes drawn\./,
    );
  });

  it("emits filter values the server's own admission policy resolves, back to the same ids", async () => {
    // THE ROUND TRIP, over every option this real page emits rather than one hand-built row.
    // `?carrier=` is a CODE vocabulary: `resolveCarrierFilter("OO")` resolves and
    // `resolveCarrierFilter("20304")` does not, so a picker that emitted the raw `airline_id`
    // would produce links that are live, look deliberate, and are refused at the far end. The
    // types line up either way -- both are `string` -- so only executing the far end can tell.
    const r = await resolveAircraftSlug("B737-8");
    if (r.kind !== "ok") throw new Error("expected B737-8 to resolve for this fixture");
    const result = await runPivot(
      trailing12Query({
        dimensions: ["op_airline_id"],
        filters: [["aircraft_type", [r.type.id]]],
        asOf: await dataAsOf(),
        limit: AIRCRAFT_CARRIER_LIMIT,
      }),
    );
    const idsFromWarehouse = new Set(result.rows.map((row) => String(row.op_airline_id)));
    expect(idsFromWarehouse.size).toBeGreaterThan(1);

    const { container } = render(await page("B737-8"));
    const hrefs = [...container.querySelectorAll(".mp-list a")].map((a) => a.getAttribute("href"));
    expect(hrefs.length).toBe(idsFromWarehouse.size);

    const idsFromLinks = new Set<string>();
    for (const href of hrefs) {
      // A carrier code is `[A-Z0-9]{2,3}` so percent-encoding is the identity over it; parsing
      // rather than string-slicing keeps this honest if that ever stops being true.
      const value = new URL(href ?? "", "http://example.test").searchParams.get("carrier");
      const verdict = await resolveCarrierFilter(value);
      if (verdict.kind !== "ok") {
        throw new Error(`picker emitted '${value}', which the server refuses: ${verdict.kind}`);
      }
      idsFromLinks.add(String(verdict.id));
    }
    expect(idsFromLinks).toEqual(idsFromWarehouse);
  });

  it("marks the showing carrier as the current view, and only that one", async () => {
    const { container } = render(await filtered("B737-8", "carrier=AS"));
    const current = [...container.querySelectorAll(".mp-list a[aria-current='page']")];
    expect(current.length).toBe(1);
    expect(current[0].textContent).toContain("AS");
  });

  it("offers a way back to the unfiltered view, and only when there is one to offer", async () => {
    // `MapPicker` holds per-option hrefs and no base path, so only the page knows the URL of its
    // own unfiltered view. Rendered unconditionally it is a control that does nothing on the
    // page a reader arrives at first.
    const clear = (c: HTMLElement) =>
      [...c.querySelectorAll("a")].filter((a) => a.textContent === "Clear the filter");

    expect(clear(render(await page("B737-8")).container)).toHaveLength(0);

    const drawn = clear(render(await filtered("B737-8", "carrier=AS")).container);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].getAttribute("href")).toBe("/aircraft/B737-8");

    // A REFUSED filter needs the way out most of all -- the reader is looking at a page with no
    // map and a value the server would not apply.
    expect(clear(render(await filtered("B737-8", "carrier=ZZ")).container)).toHaveLength(1);
  });

  it("says the filter applies to the map only, and only when a filter applied", async () => {
    // Nothing else on this page says so, and the stat strip, chart and table do NOT move with
    // `?carrier=`. A reader who assumes they did has been misled by omission.
    const scope = "The filter applies to the map only";
    expect(render(await filtered("B737-8", "carrier=AS")).container.textContent).toContain(scope);
    expect(render(await page("B737-8")).container.textContent).not.toContain(scope);
    // On a refusal NOTHING was applied, so the sentence would describe an event that did not
    // happen.
    expect(render(await filtered("B737-8", "carrier=ZZ")).container.textContent).not.toContain(
      scope,
    );
  });

  it("asks the rail for the arc encodings only when arcs are drawn", async () => {
    // The arcs encode three independent facts (width by seats, dash by load factor, dotted below
    // the departure floor) and nothing else on the served page explains any of them. The
    // converse matters too: a rail explaining arcs on a page with no map is the stale "how to
    // read this" the legend rail exists to replace.
    const rail = (c: HTMLElement) => c.querySelector(".legend")?.textContent ?? "";
    expect(rail(render(await filtered("B737-8", "carrier=AS")).container)).toContain(
      "Arc rendering",
    );
    expect(rail(render(await page("B737-8")).container)).not.toContain("Arc rendering");
  });

  it("discloses a partial picker when the page's own pivot was truncated", async () => {
    // The picker lists the rows the page already awaited, so it inherits that pivot's limit --
    // and only the page knows what its limit was. Undisclosed, the list reads as the complete
    // set of carriers flying this type.
    const short = render(await view({ limit: 2 })).container;
    expect(short.textContent).toContain("This picker lists the largest by seats");
    expect(render(await view()).container.textContent).not.toContain(
      "This picker lists the largest by seats",
    );
  });
});

describe("/aircraft/<slug> network map on a type with nothing in the window", () => {
  // The MD-80 again: 68 filed months, none since 2023-04, so the trailing-12 table is empty.
  it("draws no map section at all when nobody asked for one", async () => {
    // `AircraftEmptyState` already states this finding in words. A picker offering nothing,
    // under a map that cannot exist, is the second panel repeating it -- the card soup /route's
    // chart rule refuses.
    const { container } = render(await page("MD-80"));
    expect(container.querySelector("[data-testid='map-picker']")).toBeNull();
    expect(container.querySelector("[data-testid='segment-map']")).toBeNull();
    expect(container.querySelector(".empty-state")).not.toBeNull();
  });

  it("still answers a filter that WAS asked for", async () => {
    // The reader typed a question into the URL; silence is not an answer to it. `DL` resolves,
    // so this is the `ok`-with-no-map arm: the finding stated in words, not a blank panel.
    const { container } = render(await filtered("MD-80", "carrier=DL"));
    expect(container.querySelector("[data-testid='map-picker']")).not.toBeNull();
    expect(container.querySelector("[data-testid='segment-map']")).toBeNull();
    expect(container.textContent).toContain(
      "No routes to draw: DL performed no departures on the MD-80",
    );
  });
});

/** THE STAT STRIP AND THE FOOT ON AN UNKNOWABLE PAGE (#121), and this surface is the half the
 * issue never measured: it scoped the wholly-quarantined footprint at route grain only. At
 * aircraft grain, BTS types 201 and 489 have no un-quarantined filing in the trailing 12
 * either -- both F4 in 2025-08, 5 and 27 PERFORMED departures against a filed seat count of
 * zero. `/aircraft/TRISLNDR` and `/aircraft/SHORT360` rendered three fabricated zeros, so the
 * reachable footprint is 12 pages and not 10.
 *
 * The strip is read as an ORDERED LIST, never searched for a dash: load factor and average gauge
 * rendered `—` under the bug too, so the buggy page read `0 · 0 · — · — · 0`. */
function statStrip(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".stats .v")].map((n) => n.textContent ?? "");
}

describe("an aircraft type whose every filing was quarantined states absence, not zero", () => {
  // MUTANT: restore `?? 0` inside `sumColumn` -> `["0", "0", "—", "—", "0", ...]` -> red.
  // MUTANT: remove the `??` and fold on `+` -> identical output -> red.
  it("renders the five measures as absence and keeps the counts", async () => {
    const { container } = render(await page("TRISLNDR"));
    expect(statStrip(container)).toEqual(["—", "—", "—", "—", "—", "1", "2"]);
  });

  // MUTANT: drop the `totals.seats === null` branch -> the foot claims "2 quarantined rows
  // excluded from these totals" under five em dashes -> red.
  it("explains the dashes instead of miscounting them", async () => {
    const { container } = render(await page("TRISLNDR"));
    const feet = [...container.querySelectorAll(".foot")].map((n) => n.textContent ?? "").join(" ");
    expect(feet).toContain("Every filing on the TRISLNDR in this window is quarantined");
    expect(feet).toContain("2 rows, each having failed an invariant");
    expect(feet).not.toContain("excluded from these totals");
  });
});

describe("an aircraft type that filed nothing in the window states absence too", () => {
  // The MD-80 stopped filing in 2023-04. 37 of this dataset's fact-present types are in that
  // state -- unknowable for a reason quarantine had no part in.
  // MUTANT: seed `sumColumn` at 0 -> three zeroes -> red.
  it("renders the measures as absence while still stating the counts", async () => {
    const { container } = render(await page("MD-80"));
    expect(statStrip(container)).toEqual(["—", "—", "—", "—", "—", "0", "0"]);
  });

  // MUTANT: key the clause on `totals.seats === null` alone -> "Every filing on the MD-80 in
  // this window is quarantined — 0 rows" -> red.
  it("names neither an exclusion nor quarantine", async () => {
    const { container } = render(await page("MD-80"));
    const feet = [...container.querySelectorAll(".foot")].map((n) => n.textContent ?? "").join(" ");
    expect(feet).not.toContain("excluded from these totals");
    expect(feet).not.toContain("is quarantined");
    expect(feet).toContain("never averaged");
  });

  // The negative, so neither check above can pass against a page that stopped rendering a strip.
  // The Caravan additionally carries 75 quarantined rows BESIDE stateable traffic -- 13
  // carriers' worth -- which is the case that makes the clause's first operand undeletable.
  it("still states real figures where quarantined rows sit beside stateable traffic", async () => {
    const { container } = render(await page("CARAVAN"));
    const strip = statStrip(container);
    expect(strip.slice(0, 5)).not.toContain("—");
    const feet = [...container.querySelectorAll(".foot")].map((n) => n.textContent ?? "").join(" ");
    expect(feet).toContain("excluded from these totals");
    expect(feet).not.toContain("is quarantined");
  });
});
