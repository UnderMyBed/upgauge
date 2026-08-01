// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AircraftPage, { generateMetadata } from "@/app/aircraft/[name]/page";
import { decode } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist } from "@/lib/db";

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
    // `/aircraft/A321/LR` is two path segments and unroutable, so this page is reachable ONLY
    // through the slug transform. Falsifiable end to end: remove it and this 404s, while every
    // B737-8 test above stays green -- which is exactly how the spec's own worked example got
    // through design review.
    const { container } = render(await page("A321-LR"));
    expect(container.querySelector(".entity .code")?.textContent).toBe("A321/LR");
    expect(screen.getByText(/AIRBUS INDUSTRIE A321\/LR/)).toBeDefined();
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
    // Measured over the trailing 12 months (2025-05..2026-04) for BTS type 614:
    // seats 166,039,695 · passengers 130,153,460 · departures 971,746.
    // Sum(pax)/Sum(seats) = 78.39%; Sum(seats)/Sum(dep) = 170.9. A mean of the seven carrier
    // rows gives different numbers for both, so these two assertions distinguish them --
    // CLAUDE.md's #1 bug in every homemade T-100 tool.
    const { container } = render(await page("B737-8"));
    const stats = container.querySelector(".stats")!.textContent ?? "";
    expect(stats).toContain("166,039,695");
    expect(stats).toContain("130,153,460");
    expect(stats).toContain("78.39%");
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
  it("redirects a lower-case slug permanently (308) to the canonical URL", async () => {
    // Fails if the redirect branch is dropped, if `permanentRedirect` regresses to plain
    // `redirect()` (digest would end ';307;'), or if the target carries the raw short name --
    // `/aircraft/A321/LR` is unroutable, so the canonical MUST be the slug.
    expect(await catchDigest("a321-lr")).toBe("NEXT_REDIRECT;replace;/aircraft/A321-LR;308;");
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
    // /aircraft/a321-lr never renders this page in production (it 308s first), but the
    // canonical tag must still name the uppercased slug -- never the unroutable raw short
    // name (`A321/LR`) either.
    const meta = await generateMetadata({ params: Promise.resolve({ name: "a321-lr" }) });
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/aircraft/A321-LR");
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
