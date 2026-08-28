// @vitest-environment jsdom

// `next/headers` throws "called outside a request scope" when invoked directly in a test
// (verified against this exact vitest setup before writing this mock) -- the same reason
// explore/page.tsx's default export, which also calls `headers()` unconditionally, is never
// unit-tested directly here, only its `*View` counterpart is. AirportPage now needs `headers()`
// on its redirect branch (fix round 1: preserving the raw query string across a
// case-normalization redirect), and that branch IS already exercised by the pre-existing
// "redirects a lowercase code" test below, so it has to be mocked rather than left real. The
// factory awaits a dynamic `import()` of the real module for `RAW_QUERY_HEADER` -- a top-level
// `import` binding referenced inside `vi.mock` would break on hoisting, since `vi.mock` calls
// are hoisted above every import statement in the file.
import { describe, expect, it, vi } from "vitest";
vi.mock("next/headers", async () => {
  const { RAW_QUERY_HEADER } = await import("@/lib/rawQuery");
  // Default: an empty raw query, matching a bare `/airport/<code>` request with no `?` at
  // all -- this is what keeps every PRE-EXISTING test in this file (none of which anticipated
  // `headers()` being called at all) passing unmodified, including the lowercase-redirect test
  // whose digest must stay exactly `/airport/SEA`, no stray `?`.
  return { headers: vi.fn(async () => new Headers({ [RAW_QUERY_HEADER]: "" })) };
});

import { render, screen } from "@testing-library/react";
import { headers } from "next/headers";
import AirportPage, { AirportView, airportRedirectTarget, generateMetadata } from "@/app/airport/[code]/page";
import { resolveAirportCode } from "@/app/airport/[code]/resolveAirport";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";
import { decode } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist } from "@/lib/db";

/** `permanentRedirect`/`notFound` throw rather than return -- same helper, same reasoning, as
 * route/[pair]/page.test.tsx's. */
async function catchDigest(code: string): Promise<string> {
  try {
    await AirportPage({ params: Promise.resolve({ code }) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`AirportPage(${JSON.stringify(code)}) did not throw`);
}

function renderSEA() {
  return AirportPage({ params: Promise.resolve({ code: "SEA" }) });
}

/** `y` follows the same fold-to-first-element convention `/search`'s `q` reader uses --
 * `undefined` renders the bare page (no `y` at all, the default trailing-12 view), a string
 * renders `?y=<value>`. */
function renderSEAWithYear(y: string) {
  return AirportPage({
    params: Promise.resolve({ code: "SEA" }),
    searchParams: Promise.resolve({ y }),
  });
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// EVERY figure below is measured against upgauge.duckdb for SEA (airport_id 14747) over the
// trailing 12 months 2025-06..2026-05, and every one of them is a figure an ORIGIN-ONLY page
// gets wrong. That is the point: carriers (13) and aircraft types (25) are IDENTICAL either
// way, so a suite built on those two would pass against the bug this page exists to exclude.
//
//   seats          origin OR dest 53,372,100   origin only 26,708,918
//   passengers     origin OR dest 43,888,228   origin only 21,922,669
//   destinations   origin OR dest        143   origin only         139
//   AS's seats     origin OR dest 26,089,404   origin only 13,059,688
//
// And the third term, which is not a formality: 17 same-airport (origin = dest) filings at
// SEA carry 12,207 seats, so a naive origin + dest reads 53,384,307 rather than 53,372,100.
describe("/airport/<code>", () => {
  it("renders the airport's code and name, never the bare AIRPORT_ID", async () => {
    const { container } = render(await renderSEA());
    expect(container.querySelector(".entity .code")?.textContent).toBe("SEA");
    expect(container.querySelector(".entity .ename")?.textContent).toMatch(/Seattle/);
    // The id is what the catalog is keyed on and what the query filters on; it must never be
    // what a reader sees (CLAUDE.md: join on ids, display codes).
    expect(container.textContent).not.toContain("14747");
  });

  it("shows DATA AS OF", async () => {
    render(await renderSEA());
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("counts BOTH endpoints, not departures alone", async () => {
    // The one test this task exists for. 53,372,100 fails for an origin-only page
    // (26,708,918) AND for a page that forgets the overlap term (53,384,307).
    const { container } = render(await renderSEA());
    const stats = container.querySelector(".stats")?.textContent ?? "";
    expect(stats).toContain("53,372,100");
    expect(stats).not.toContain("26,708,918");
    expect(stats).not.toContain("53,384,307");
  });

  it("counts arrivals in passengers and destinations too, not only in seats", async () => {
    // A page that fixed the seat total alone -- by, say, doubling the origin figure -- would
    // pass the test above. Passengers and destinations are separately wrong under origin-only
    // (21,922,669 and 139), and the destination count cannot be reached by scaling anything.
    const { container } = render(await renderSEA());
    const stats = container.querySelector(".stats")?.textContent ?? "";
    expect(stats).toContain("43,888,228");
    expect(stats).not.toContain("21,922,669");
    // SCOPED to the Destinations stat's own value node. `toContain("143")` over the whole strip
    // was a three-digit substring match: it happens to be unambiguous against today's other
    // stats, but 143 is a substring of any figure containing it, so the assertion could pass for
    // a reason other than the destination count being right. The whole point of this figure is
    // that origin-only reads 139 and nothing can scale its way there.
    const destinations = [...container.querySelectorAll(".stats .stat")].find(
      (s) => s.querySelector(".k")?.textContent === "Destinations",
    );
    expect(destinations?.querySelector(".v")?.textContent).toBe("143");
  });

  it("computes load factor and avg gauge from summed parts, never by averaging carriers", async () => {
    // Ratio of sums: 43,888,228 / 53,372,100 = 82.23%, and 53,372,100 / 366,174 = 145.8.
    // The mean of the 13 carrier load factors is 83.84% and the mean of their gauges is
    // 164.9 -- both plausible, both wrong, both what AVG(load_factor) produces.
    const { container } = render(await renderSEA());
    const stats = container.querySelector(".stats")?.textContent ?? "";
    expect(stats).toContain("82.23%");
    expect(stats).toContain("145.8");
    expect(stats).not.toContain("83.84%");
    expect(stats).not.toContain("164.9");
  });

  it("lists the carriers at the airport by code, biggest first, counting both directions", async () => {
    const { container } = render(await renderSEA());
    const first = container.querySelector("tbody tr");
    const cells = [...(first?.querySelectorAll("td") ?? [])].map((c) => c.textContent);
    // Alaska, by a distance, at SEA. 26,089,404 seats over both endpoints; 13,059,688
    // departing only -- so this row alone distinguishes the two implementations.
    expect(cells[1]).toBe("AS");
    expect(cells.join(" ")).toContain("26,089,404");
    const codes = [...container.querySelectorAll("tbody td.id")].map((c) => c.textContent);
    expect(codes.length).toBe(13);
    expect(codes.every((c) => /^[A-Z0-9]{2}$/.test(c ?? ""))).toBe(true);
  });

  it("draws the fleet-mix chart above the table, over the full window", async () => {
    const asOf = await dataAsOf();
    const { container } = render(await renderSEA());
    const svg = container.querySelector(".chart svg[role='img']");
    const table = container.querySelector("table");
    expect(svg).not.toBeNull();
    expect(table).not.toBeNull();
    expect(svg!.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The chart's own aria-label names the window it actually drew -- the honest witness that
    // it was handed 2015-01, not the table's trailing 12 months.
    expect(svg!.getAttribute("aria-label")).toContain(`2015-01 to ${asOf}`);
  });

  it("draws the chart over both endpoints too, not just departures", async () => {
    // The stat strip and the chart are fed by two SEPARATE unions, so fixing one leaves the
    // other free to be half the airport -- and a half-height stacked area looks perfectly
    // normal. The y axis is the witness: SEA's busiest month is 5,345,819 seats over both
    // endpoints and 2,675,160 departing only (measured, 2025-07), so a 4M tick exists on the
    // honest chart and CANNOT exist on an origin-only one.
    const { container } = render(await renderSEA());
    const ticks = [...(container.querySelectorAll(".chart svg text") ?? [])].map(
      (t) => t.textContent,
    );
    expect(ticks).toContain("4M");
  });

  it("states both windows in the window line", async () => {
    const asOf = await dataAsOf();
    const { container } = render(await renderSEA());
    const line = container.querySelector(".window")?.textContent ?? "";
    expect(line).toMatch(/trailing 12 months/i);
    expect(line).toContain(`2015-01 → ${asOf}`);
    expect(line).toMatch(/2025-\d\d → /);
  });

  it("offers the single either-endpoint query in the Explorer, and does not claim it can't", async () => {
    // M7 Task 3 added `endpoint_airport_id` (filter_only, filter_mode='either'), which
    // compiles to an OR across origin and dest -- so this page now offers ONE permalink, not
    // two halves. This is the replacement for a test that asserted a mandated PHRASE
    // ("cannot express both endpoints in one query") rather than the fact: the phrase was
    // exactly what M7 falsified, and a test built only on the phrase's absence could pass
    // against a page that also dropped the link, or linked to the wrong filter, or reverted to
    // an origin-only query -- so this asserts the fact (the link's filter) AND the absence of
    // the false claim, independently.
    const { container } = render(await renderSEA());
    const allowlist = await loadAllowlist();
    const link = screen.getByRole("link", { name: /open in the explorer/i });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("/explore?")).toBe(true);
    const decoded = decode(href.slice("/explore?".length), allowlist);
    expect(decoded.filters).toEqual([["endpoint_airport_id", ["14747"]]]);
    expect(container.textContent).not.toMatch(/cannot express both endpoints in one query/i);
  });

  it("shows the legend rail, with the fleet-shading group the chart needs", async () => {
    render(await renderSEA());
    expect(screen.getByText("Chart legend")).toBeDefined();
    expect(screen.getByText(/darkening stack is an upgauge/i)).toBeDefined();
  });

  it("discloses the quarantined-row count rather than hiding it", async () => {
    const { container } = render(await renderSEA());
    expect(container.textContent).toMatch(/quarantined row/i);
    expect(container.textContent).toMatch(/never averaged/i);
  });
});

// #114, at the page. The unit tests prove the producer counts and the renderer states; this
// proves the served page mounts the map that carries it.
describe("/airport/<code> whose whole network is one quarantined route pair", () => {
  // Kantishna (A18) has exactly one filing in the trailing 12 and it is quarantined
  // `zero_seats`, having PERFORMED a departure. Before #114 this page drew that pair as an arc
  // reading 0 seats and 0 departures -- dotted and muted, "barely flown" -- which is a claim the
  // data cannot support. A18 is sitemap-listed (`sitemap.test.ts` pins it as one of four
  // airports resolving ONLY because quarantined rows are counted), so this is a live page.
  it("renders the map and its disclosure rather than dropping the section", async () => {
    const { container } = render(await AirportPage({ params: Promise.resolve({ code: "A18" }) }));
    // The map is mounted at all -- a gate on `arcs.length` would take the whole section, and
    // with it the only thing on this page saying anything was filed.
    expect(container.querySelector("svg[role='img']")).not.toBeNull();
    expect(container.querySelectorAll("polyline").length).toBe(0);
    expect(container.querySelector('[data-testid="network-notes"]')!.textContent).toContain(
      "1 quarantined route not drawn — failed an invariant, never clamped.",
    );
  });

  it("does not draw an arc claiming the pair carried nothing", async () => {
    // The defect stated as an absence. `LMA` is A18's only far endpoint in this window; a
    // destination label for it means the fabricated arc is back.
    const { container } = render(await AirportPage({ params: Promise.resolve({ code: "A18" }) }));
    const svg = container.querySelector("svg[role='img']")!;
    expect(svg.textContent).not.toContain("LMA");
  });
});

describe("/airport/<code> with nothing in the trailing 12 months", () => {
  // ISN, Sloulin Field International (airport_id 12389): 515 fact rows over 58 months,
  // 2015-01 to 2019-10, and nothing since (measured). Every airport that RESOLVES has some
  // history -- the lookup's fact-presence filter guarantees it -- so unlike /route/<pair>
  // this page's empty state always sits under a chart with something in it.
  it("states the finding in words and offers the widened window", async () => {
    render(await AirportPage({ params: Promise.resolve({ code: "ISN" }) }));
    expect(screen.getByText(/no filings/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /2015-01/ })).toBeDefined();
  });

  it("still draws the history, and names the range it actually drew", async () => {
    // Fetched over 2015-01 → asOf, drawable only to 2019-10. Claiming the requested window
    // over a chart that stops in 2019 is the same fabrication as interpolating a gap (M4c).
    const asOf = await dataAsOf();
    const { container } = render(await AirportPage({ params: Promise.resolve({ code: "ISN" }) }));
    expect(container.querySelector(".chart svg[role='img']")).not.toBeNull();
    const line = container.querySelector(".window")?.textContent ?? "";
    const chartHalf = line.slice(line.indexOf("chart:"));
    expect(chartHalf).toContain("2015-01 → 2019-10");
    expect(chartHalf).not.toContain(asOf);
  });
});

describe("/airport/<code> truncation disclosure", () => {
  // SEA's real trailing-12 traffic pivot returns 666 (carrier, origin, dest) groups, against a
  // 5,000 limit no airport in this database reaches (measured worst case is ORD at 1,732, M7
  // Task 3), so nothing in production data exercises this branch. `AirportView` takes the limit
  // as an explicit parameter for exactly that reason -- same split, same justification, as
  // RouteView's.
  async function view(limit?: number, mixLimit?: number) {
    const r = await resolveAirportCode("SEA");
    if (r.kind !== "ok") throw new Error("expected SEA to resolve for this fixture");
    return await AirportView({ airport: r.airport, limit, mixLimit });
  }

  it("discloses when the traffic pivot hits the row limit", async () => {
    render(await view(2));
    expect(screen.getByText(/top 2 /i)).toBeDefined();
  });

  it("does not disclose at the real limit", async () => {
    render(await view());
    expect(screen.queryByText(/top \d+ /i)).toBeNull();
  });

  it("discloses a truncated CHART separately, and does not 500 for being big", async () => {
    // The chart is a SEPARATE pivot from the table's, at a different grain and a different
    // limit, so either can be short while the other is whole -- `fetchAirportMix` sets its own
    // `truncated` from its own pivot's row count, same shape as `fetchAirportTraffic`'s.
    // Rendering at all is half the assertion here; saying so is the other half.
    render(await view(undefined, 5));
    expect(screen.getByText(/chart .*hit its 5-row limit/i)).toBeDefined();
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("does not disclose a truncated chart at the real limit", async () => {
    render(await view());
    expect(screen.queryByText(/row limit/i)).toBeNull();
  });
});

describe("airportRedirectTarget", () => {
  it("appends the raw query string verbatim", () => {
    expect(airportRedirectTarget("SEA", "y=2019")).toBe("/airport/SEA?y=2019");
  });

  it("appends nothing for an empty raw query, rather than a stray '?'", () => {
    expect(airportRedirectTarget("SEA", "")).toBe("/airport/SEA");
  });
});

describe("/airport/<code> redirect and 404", () => {
  it("redirects a lowercase code permanently (308) to the canonical URL", async () => {
    expect(await catchDigest("sea")).toBe("NEXT_REDIRECT;replace;/airport/SEA;308;");
  });

  // Fix round 1 finding: this redirect used to build `/airport/SEA` from the slug alone,
  // silently dropping every query key -- `/airport/sea?y=2019` 308ed to `/airport/SEA` with
  // no `y` at all, and the destination silently rendered the trailing-12 default instead of
  // 2019, with no error anywhere. Asserting the digest STRING (not merely that a redirect
  // fired, which the test immediately above already does and would keep passing under the
  // bug) is what catches this -- "a redirect happened" is true both before and after the fix.
  it("preserves a valid year query param across the case-normalization redirect", async () => {
    vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: "y=2019" }));
    expect(await catchDigest("sea")).toBe("NEXT_REDIRECT;replace;/airport/SEA?y=2019;308;");
  });

  it("preserves an INVALID year across the same redirect, rather than silently dropping it", async () => {
    // A redirect that stripped a bad `y` would be the identical silent-fallback bug in a
    // different coat: the canonical URL must render the SAME named error the direct URL does
    // (pinned separately in the "M7 Task 9" describe block above, for /airport/SEA?y=1999
    // directly), not quietly default to the trailing-12 view because the redirect erased the
    // evidence that anything was ever wrong.
    vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: "y=1999" }));
    expect(await catchDigest("sea")).toBe("NEXT_REDIRECT;replace;/airport/SEA?y=1999;308;");
  });

  it("404s an unknown code", async () => {
    expect(await catchDigest("ZZZZ")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("404s a real airport this domestic-only dataset has no rows for", async () => {
    // A DIFFERENT resolveAirportCode reason than the unknown code above, through the same
    // notFound() call -- a regression that special-cased one would still be caught here.
    expect(await catchDigest("LHR")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("/airport/<code> canonical metadata (M5, Task 2)", () => {
  it("declares the canonical URL for an already-canonical code", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "SEA" }) });
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/airport/SEA");
  });

  it("declares the UPPERCASED spelling for a lowercase request, not the request", async () => {
    // The bug to exclude (task-2-brief.md): "/airport/sea must declare /airport/SEA", not
    // the requested spelling. /airport/sea never renders this page in production (it 308s
    // first), but the canonical tag must still name the uppercase code.
    const meta = await generateMetadata({ params: Promise.resolve({ code: "sea" }) });
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/airport/SEA");
  });

  it("returns no canonical for a code that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "ZZZZ" }) });
    expect(meta.alternates?.canonical).toBeUndefined();
  });
});

// M9 Task 6b (og-cards FINDING 6): same finding as /route's -- `og:title` read "Upgauge" on a
// served /airport/SEA, not the airport, because generateMetadata returned only
// `alternates.canonical`.
describe("/airport/<code> Open Graph metadata (M9 Task 6b)", () => {
  it("carries the airport code AND name in openGraph.title, not the bare code alone", async () => {
    // Fix round 1: `title: code` alone matched `.entity .code` (asserted above) but dropped
    // `.entity .ename` -- a pasted link previewing as bare "SEA" (which is also an ordinary
    // English word) delivers half the entity, and `og:title` has no second line the way the OG
    // image's title/subtitle split does. Pinned to the exact string measured against the real
    // warehouse (dim_airport's own spelling), not a substring match, so a regression back to
    // the bare code fails here rather than passing on a loose `.toContain`.
    const meta = await generateMetadata({ params: Promise.resolve({ code: "SEA" }) });
    expect(meta.openGraph?.title).toBe("SEA — Seattle/Tacoma International");
  });

  it("states the data view honestly in openGraph.description, without a fare or real-time claim", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "SEA" }) });
    const description = meta.openGraph?.description ?? "";
    expect(description).toContain("SEA");
    expect(description).toMatch(/US DOT T-100/);
    expect(description).toMatch(/both endpoints/i);
    expect(description).toMatch(/not fares or real-time/i);
  });

  it("omits openGraph for a code that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "ZZZZ" }) });
    expect(meta.openGraph).toBeUndefined();
  });
});

// M7 Task 9: `/airport/<code>?y=<year>` selects a calendar year for the network map instead of
// the default trailing-12 view, and the track of year links that lets a reader move between
// them. Every figure below is measured against the real warehouse -- asOf is 2026-04 at the
// time this was written, so 2026 is the partial year and 2015-2025 are complete.
describe("/airport/<code>?y=<year> -- the year track (M7 Task 9)", () => {
  it("renders one link per calendar year plus the default, none missing or duplicated", async () => {
    const asOf = await dataAsOf();
    const asOfYear = Number(asOf.slice(0, 4));
    const { container } = render(await renderSEA());
    const links = [...container.querySelectorAll(".year-track a")];
    // EARLIEST_YEAR (2015) through asOf's own year, inclusive, plus the "Trailing 12 months"
    // link -- 12 years at 2026-04 (2015..2026), so 13 links total. Derived from asOf, not
    // hardcoded, so this does not need editing after a future rebuild.
    expect(links.length).toBe(asOfYear - 2015 + 1 + 1);
    expect(links[0].textContent).toBe("Trailing 12 months");
    const yearTexts = links.slice(1).map((a) => a.textContent);
    expect(yearTexts[0]).toBe("2015");
    expect(new Set(yearTexts).size).toBe(yearTexts.length);
  });

  it("marks the default view current when no y is given, and no year link current", async () => {
    const { container } = render(await renderSEA());
    const links = [...container.querySelectorAll(".year-track a")];
    expect(links[0].getAttribute("aria-current")).toBe("page");
    expect(links.slice(1).every((a) => a.getAttribute("aria-current") === null)).toBe(true);
  });

  it("marks the SELECTED year current, and only that one", async () => {
    const { container } = render(await renderSEAWithYear("2019"));
    const links = [...container.querySelectorAll(".year-track a")];
    const y2019 = links.find((a) => a.textContent?.startsWith("2019"));
    expect(y2019?.getAttribute("aria-current")).toBe("page");
    expect(links.filter((a) => a !== y2019).every((a) => a.getAttribute("aria-current") === null)).toBe(
      true,
    );
  });

  it("states the map's own calendar-year window, distinct from the table's trailing 12", async () => {
    const { container } = render(await renderSEAWithYear("2019"));
    const line = container.querySelector(".window")?.textContent ?? "";
    expect(line).toMatch(/trailing 12 months/i);
    expect(line).toContain("map: calendar year 2019");
  });

  it("draws the map over the selected year's own data, not the trailing 12", async () => {
    // SEA carries 4,744 route-month rows in 2019 (measured against the real warehouse) -- a
    // regression that kept feeding the map the trailing-12 window regardless of `y` would still
    // render A map here, just the wrong one, so this only proves a map renders; the window-line
    // test above is what proves it's the RIGHT one.
    const { container } = render(await renderSEAWithYear("2019"));
    expect(container.querySelector(".map")).not.toBeNull();
  });

  it("marks a complete prior year's own tick without a partial asterisk", async () => {
    const { container } = render(await renderSEA());
    const links = [...container.querySelectorAll(".year-track a")];
    const y2015 = links.find((a) => a.textContent?.startsWith("2015"));
    expect(y2015?.textContent).toBe("2015");
  });

  it("marks the current, partial year's own tick with an asterisk", async () => {
    const asOf = await dataAsOf();
    const asOfYear = Number(asOf.slice(0, 4));
    const { container } = render(await renderSEA());
    const links = [...container.querySelectorAll(".year-track a")];
    const current = links.find((a) => a.textContent?.startsWith(String(asOfYear)));
    expect(current?.textContent).toBe(`${asOfYear}*`);
  });

  it("discloses the partial year in words, naming the exact month asOf stops at", async () => {
    // Catches: presenting a 4-month year identically to a 12-month one (CLAUDE.md's own
    // description of this exact failure class, "First appearance since 2015"). Derived from
    // `asOf`'s own month, not a hardcoded "April" -- this stays correct after a rebuild that
    // advances `asOf` to a different month.
    const asOf = await dataAsOf();
    const asOfYear = asOf.slice(0, 4);
    const monthName = MONTH_NAMES[Number(asOf.slice(5, 7)) - 1];
    const { container } = render(await renderSEA());
    const footers = [...container.querySelectorAll(".foot")].map((f) => f.textContent ?? "");
    expect(
      footers.some((t) => t.includes(`${asOfYear} is a partial year`) && t.includes(monthName)),
    ).toBe(true);
  });

  it("states the partial map window when the SELECTED year is the current, partial one", async () => {
    const asOf = await dataAsOf();
    const asOfYear = Number(asOf.slice(0, 4));
    const monthName = MONTH_NAMES[Number(asOf.slice(5, 7)) - 1];
    const { container } = render(await renderSEAWithYear(String(asOfYear)));
    const line = container.querySelector(".window")?.textContent ?? "";
    expect(line).toContain(
      `map: calendar year ${asOfYear} — partial, filed through ${monthName} ${asOfYear} only`,
    );
  });

  it("does not call a complete prior year partial in the map window line", async () => {
    const { container } = render(await renderSEAWithYear("2019"));
    const line = container.querySelector(".window")?.textContent ?? "";
    expect(line).not.toContain("partial");
  });

  it("renders a named error for a year outside the dataset, never a silent fallback", async () => {
    const { container } = render(await renderSEAWithYear("1999"));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/can.t be shown/i);
    expect(screen.getByRole("alert").textContent).toBe(
      "unknown year '1999' — this dataset covers 2015–2026",
    );
    // The default view's own content -- stats, table, track -- must not render alongside the
    // error; a page that rendered both would be the "guessed a default anyway" failure this
    // contract exists to forbid.
    expect(container.querySelector(".stats")).toBeNull();
    expect(container.querySelector(".year-track")).toBeNull();
  });

  it("renders a named error for malformed input the same way as an out-of-range year", async () => {
    const { container } = render(await renderSEAWithYear("nonsense"));
    expect(screen.getByRole("alert").textContent).toContain("unknown year 'nonsense'");
    expect(container.querySelector(".stats")).toBeNull();
  });

  it("still shows DATA AS OF on the error page", async () => {
    render(await renderSEAWithYear("1999"));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("upper bound of the named error's range is derived, not the literal string '2026'", async () => {
    // The task brief's own example text is "this dataset covers 2015-2026" -- pinning ONLY that
    // literal would pass even if the implementation hardcoded it, which is exactly the "future
    // rebuild needs a code change" failure this task exists to avoid. This test instead derives
    // the expected bound from dataAsOf() the same way the page must.
    const asOf = await dataAsOf();
    const asOfYear = asOf.slice(0, 4);
    const { container } = render(await renderSEAWithYear("1999"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(`2015–${asOfYear}`);
  });
});

// ---------------------------------------------------------------------------------------
// Issue #118, at the rendered grain. endpoints.test.ts proves the fold; this proves the null
// actually survives DataTable -> lib/format.ts and reaches a `<td>`, which is the seam a unit
// test of either half alone cannot see.
//
// A18 (Kantishna), measured 2026-08-27 at asOf 2026-05: ONE row in the entire dataset --
// 2025-06, op_airline 20333, seats 0.0, departures_performed 1.0, is_quarantined true, with A18
// as the DESTINATION. So its trailing-12 pivot returns a single wholly-quarantined group, and
// under the `?? 0` bug the only row of the only table on the page read "0 / 0 / 0".
//
// TWO THINGS TURN THIS FIXTURE RED, AND THE LIKELIER ONE IS NOT A BUG. (1) A BTS revision
// un-quarantines that row. (2) `asOf` ADVANCES: 2025-06 is the FIRST month of the current
// trailing 12, so one dataset month rolls it out of the window, A18 has no rows at all, and the
// page becomes the empty state -- taking these four tests, three of app/smoke.sh's A18 needles
// and #114's already-merged A18 map needles with it. Expiry is the likelier cause by far, so
// triage the window before hunting an un-quarantine that never happened. JZM and OQZ carry the
// identical single-quarantined-row property at 2025-08, two months of further runway, and are
// the fixtures to MOVE to (CLAUDE.md, "MOVE the fixture") -- not a relaxed assertion, which
// would keep passing against the very bug this guards.
describe("/airport/<code> renders an unknowable sum as absence, not zero", () => {
  async function a18() {
    const r = await resolveAirportCode("A18");
    if (r.kind !== "ok") throw new Error("expected A18 to resolve for this fixture");
    return await AirportView({ airport: r.airport });
  }

  it("renders every measure cell as the absence marker, in order", async () => {
    // THE SEQUENCE, not "contains a dash". Load factor and average gauge are ALREADY `—` under
    // the bug (their denominators are zero), so `toContain("—")` passes on the broken page --
    // the class of self-defect app/smoke.sh has produced three times. Only asserting the
    // POSITION of each dash distinguishes the fixed page from the buggy one.
    // MUTANT: restore `Number(r.seats ?? 0)` in endpoints.ts -> ["0","0","0","—","—"], red.
    const { container } = render(await a18());
    const cells = [...container.querySelectorAll("td.num")].map((c) => c.textContent);
    expect(cells).toEqual(["—", "—", "—", "—", "—"]);
  });

  it("renders no measure cell as a zero anywhere on the page", async () => {
    // The absence half. A page that dropped the row entirely would satisfy the test above
    // vacuously (zero cells is not a sequence of five), so the row's presence is asserted too.
    const { container } = render(await a18());
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
    expect([...container.querySelectorAll("td.num")].some((c) => c.textContent === "0")).toBe(
      false,
    );
  });

  it("leaves the stat strip unknowable rather than reporting zero traffic", async () => {
    // A18's whole window is that one quarantined filing, so the strip has nothing to state --
    // but the COUNTS are still real facts about what was filed, and must not be blanked with it.
    // MUTANT: seed airportTotals' reduce at 0 again -> "0" for seats/passengers/departures, red.
    const { container } = render(await a18());
    const stats = [...container.querySelectorAll(".stat")].map((s) => [
      s.querySelector(".k")?.textContent,
      s.querySelector(".v")?.textContent,
    ]);
    expect(stats).toContainEqual(["Seats", "—"]);
    expect(stats).toContainEqual(["Passengers", "—"]);
    expect(stats).toContainEqual(["Departures", "—"]);
    expect(stats).toContainEqual(["Carriers", "1"]);
    expect(stats).toContainEqual(["Quarantined", "1"]);
  });

  it("does not tell the reader the counts are net of the excluded row", async () => {
    // BLOCKER FROM DESIGN REVIEW. The strip beside this sentence reads Carriers 1 ·
    // Destinations 1 · Quarantined 1, and `airportTotals` builds those counts from EVERY row
    // regardless of quarantine -- so on this page they are counts OF the excluded row, not
    // figures left over after excluding it. "Excluded from these totals" is true only while
    // there are totals left to exclude from, and here there are none. The /watch/new-routes
    // class of defect: a compound claim whose clauses need re-deriving one at a time.
    // MUTANT: drop the `totals.seats === null` branch from `quarantineClause` -> red.
    const { container } = render(await a18());
    const feet = [...container.querySelectorAll(".foot")].map((f) => f.textContent).join(" ");
    expect(feet).toContain("Every filing at A18 in this window is quarantined");
    expect(feet).toContain("no measure above can be summed");
    expect(feet).not.toContain("excluded from these totals");
  });

  it("agrees with its own count on the plural, on both halves of the sentence", async () => {
    // `1 destinations` shipped beside a correctly singularised `1 quarantined row` in the SAME
    // sentence. Small wrongness under a DATA AS OF badge is what makes a reader doubt the large
    // numbers, and this is now the only prose on the page explaining five em dashes.
    // MUTANT: hardcode `destinations` -> red. In-repo precedent: networkMap.test.ts asserts
    // `not.toContain("1 quarantined routes")` for the same class of defect.
    const { container } = render(await a18());
    const feet = [...container.querySelectorAll(".foot")].map((f) => f.textContent).join(" ");
    expect(feet).toContain("1 destination counted once each");
    expect(feet).not.toContain("1 destinations");
  });

  it("says WHY it cannot state them, in the reason-code gutter", async () => {
    // The em dash is the claim; this is its justification, and it is the reason the other four
    // table surfaces already carry (they hand DataTable raw pivot rows; /airport rebuilds its
    // rows in TypeScript, so it has to carry the reason deliberately).
    // MUTANT: drop quarantine_reasons from carrierRows' output -> the title loses ": zero_seats".
    const { container } = render(await a18());
    const gutter = container.querySelector("td.gut abbr");
    expect(gutter?.textContent).toBe("Q");
    expect(gutter?.getAttribute("title")).toBe(
      "Quarantined — failed an invariant: zero_seats",
    );
  });
});

// ---------------------------------------------------------------------------------------
// Issue #118 design review, FIX 2: the `null` seed changes 290 pages nothing else pins.
//
// `airportTotals` seeded at `null` also makes `airportTotals([])` unknowable, so a fact-present
// airport with NO rows in the trailing 12 now reports `—` where it reported `0`. Measured: 290
// such airports, against the 3 whose rows are all quarantined -- so the change's real footprint
// is 293 pages, not 3, and 290 of them are reached by a code path no test named. A future
// "simplify the seed back to 0" reverts all of them silently. (The airport total this is a
// fraction of is a `test_stated_counts.py`-gated figure and lives in docs/data/invariants.md;
// a hand-written copy here would rot silently, which is what that gate exists to prevent.)
//
// The rendering is correct for the reason CLAUDE.md gives for gaps: T-100 is a FILING, so a
// window with no row is neither "nobody flew" nor "0 seats flew". The two absences are
// different findings and `AirportEmptyState` is what names which one this page is in.
//
// 05A has zero rows in 2025-06..2026-05 (measured). Unlike A18 this fixture does not expire on
// an `asOf` advance -- an airport that stopped filing stays stopped.
describe("/airport/<code> with nothing filed in the window", () => {
  async function empty() {
    const r = await resolveAirportCode("05A");
    if (r.kind !== "ok") throw new Error("expected 05A to resolve for this fixture");
    return await AirportView({ airport: r.airport });
  }

  it("reports unknowable sums, not zero traffic", async () => {
    // MUTANT: seed airportTotals' reduce at 0 again -> "0", red.
    const { container } = render(await empty());
    const stats = [...container.querySelectorAll(".stat")].map((s) => [
      s.querySelector(".k")?.textContent,
      s.querySelector(".v")?.textContent,
    ]);
    expect(stats).toContainEqual(["Seats", "—"]);
    expect(stats).toContainEqual(["Passengers", "—"]);
    expect(stats).toContainEqual(["Departures", "—"]);
  });

  it("still counts zero carriers and zero quarantined rows", async () => {
    // The counts are not measures: zero carriers filed is a fact, not an absence, and blanking
    // them with the sums would be the mirror-image error this whole change exists to refuse.
    // MUTANT: widen `carriers`/`quarantinedRows` to null on an empty row set -> red.
    const { container } = render(await empty());
    const stats = [...container.querySelectorAll(".stat")].map((s) => [
      s.querySelector(".k")?.textContent,
      s.querySelector(".v")?.textContent,
    ]);
    expect(stats).toContainEqual(["Carriers", "0"]);
    expect(stats).toContainEqual(["Quarantined", "0"]);
  });

  it("names which absence it is, rather than leaving the dashes bare", async () => {
    // The em dash says "no measure"; only this says WHY, and it is a different why from A18's.
    // SCOPED TO THE FOOT, and the negative is the point: `seats === null` is true here too,
    // so a clause gated on that alone tells 290 pages that every filing at them was
    // quarantined -- inventing a finding on 290 pages to fix it on 3. This test caught exactly
    // that before it shipped.
    // MUTANT: gate `quarantineClause` on `totals.seats === null` alone -> red.
    const { container } = render(await empty());
    const feet = [...container.querySelectorAll(".foot")].map((f) => f.textContent).join(" ");
    expect(container.textContent).toContain("No filings at");
    expect(feet).not.toContain("is quarantined");
    // Nor the else-branch's claim, which is the same false shape: "0 quarantined rows excluded
    // from these totals" under a strip that has no totals to have excluded anything from.
    // MUTANT: collapse the nested ternary back to a two-way on `quarantinedRows > 0` -> red.
    expect(feet).not.toContain("excluded from these totals");
    expect(feet).not.toContain("quarantined row");
  });
});

// ---------------------------------------------------------------------------------------
// THE FLOOR PARTITION AT THIS CALL SITE (#127). DataTable.test.tsx proves the component
// partitions; it cannot prove this page reaches it with the partition on. A pinned function is
// not a pinned call site (CLAUDE.md), and the exemption /explore now carries makes the prop a
// real axis rather than a constant -- so the default has to be asserted where a page uses it.
//
// /airport is where the defect was reported and it is the only surface whose rows never pass
// through a SQL ORDER BY at all: endpoints.ts folds the pivot by carrier in TypeScript and
// sorts with `bySeatsDesc`. No SQL fix could have reached this page.
describe("/airport/<code> sorts below-floor rows last", () => {
  /** One rendered row of the carriers table: its carrier cell, its seats, and whether the page
   * gave it the below-floor treatment. */
  function carrierRowsRendered(container: HTMLElement) {
    const table = container.querySelector("table.data-table");
    if (table === null) throw new Error("expected a carriers table on this page");
    return [...table.querySelectorAll("tbody tr")].map((tr) => ({
      carrier: tr.querySelector("td.id")?.textContent ?? "",
      seats: Number((tr.querySelectorAll("td.num")[0]?.textContent ?? "").replace(/,/g, "")),
      belowFloor: tr.getAttribute("data-below-floor") === "true",
    }));
  }

  async function stt() {
    const r = await resolveAirportCode("STT");
    if (r.kind !== "ok") throw new Error("expected STT to resolve for this fixture");
    return await AirportView({ airport: r.airport });
  }

  it("renders the below-floor rows as one contiguous block at the bottom", async () => {
    // MUTANT M9: flip DataTable's `partition` default to false -> red. MUTANT M1 (delete the
    // partition entirely) -> red. Neither is visible to any test that counts dashed rows.
    const rows = carrierRowsRendered(render(await stt()).container);
    const firstBelow = rows.findIndex((r) => r.belowFloor);
    expect(firstBelow).toBeGreaterThanOrEqual(0);
    expect(rows.slice(firstBelow).every((r) => r.belowFloor)).toBe(true);
  });

  it("still discriminates: a below-floor row here outranks a scored one by seats", async () => {
    // THE FIXTURE GUARD, and it is the whole reason STT is the airport named here. The test
    // above is only meaningful while the measure order and the partitioned order DISAGREE on
    // this page -- if every below-floor row were already last by seats, both orderings would
    // agree and "contiguous block at the bottom" would pass against the bug it exists to catch.
    // That is exactly how M4c's two-sort fixture failed.
    //
    // Measured at the time of writing (trailing 12 to 2026-05): MQ files 380 seats on 5
    // departures and sits below floor, while VD files 115 seats on 120 departures and does
    // not -- so the measure sort puts a below-floor row ABOVE a scored one. If a BTS refresh
    // ends that, this goes red and the fixture MOVES to another airport (CLAUDE.md, "MOVE the
    // fixture") rather than the assertion above quietly becoming vacuous.
    // `Number.isFinite` drops the unknowable row -- STT's F4 renders `—` for every measure
    // (its whole window is quarantined), and NaN would poison both extrema. It is neither
    // below floor nor comparable by seats, so it takes no part in this comparison.
    const rows = carrierRowsRendered(render(await stt()).container);
    const seatsOf = (below: boolean) =>
      rows.filter((r) => r.belowFloor === below && Number.isFinite(r.seats)).map((r) => r.seats);
    expect(Math.max(...seatsOf(true))).toBeGreaterThan(Math.min(...seatsOf(false)));
  });
});
