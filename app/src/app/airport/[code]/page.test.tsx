// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AirportPage, { AirportView } from "@/app/airport/[code]/page";
import { resolveAirportCode } from "@/app/airport/[code]/resolveAirport";
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

// EVERY figure below is measured against upgauge.duckdb for SEA (airport_id 14747) over the
// trailing 12 months 2025-05..2026-04, and every one of them is a figure an ORIGIN-ONLY page
// gets wrong. That is the point: carriers (13) and aircraft types (25) are IDENTICAL either
// way, so a suite built on those two would pass against the bug this page exists to exclude.
//
//   seats          origin OR dest 53,373,806   origin only 26,710,000
//   passengers     origin OR dest 43,896,637   origin only 21,941,241
//   destinations   origin OR dest        143   origin only         140
//   AS's seats     origin OR dest 26,091,482   origin only 13,061,110
//
// And the third term, which is not a formality: 18 same-airport (origin = dest) filings at
// SEA carry 12,646 seats, so a naive origin + dest reads 53,386,452 rather than 53,373,806.
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
    // The one test this task exists for. 53,373,806 fails for an origin-only page
    // (26,710,000) AND for a page that forgets the overlap term (53,386,452).
    const { container } = render(await renderSEA());
    const stats = container.querySelector(".stats")?.textContent ?? "";
    expect(stats).toContain("53,373,806");
    expect(stats).not.toContain("26,710,000");
    expect(stats).not.toContain("53,386,452");
  });

  it("counts arrivals in passengers and destinations too, not only in seats", async () => {
    // A page that fixed the seat total alone -- by, say, doubling the origin figure -- would
    // pass the test above. Passengers and destinations are separately wrong under origin-only
    // (21,941,241 and 140), and the destination count cannot be reached by scaling anything.
    const { container } = render(await renderSEA());
    const stats = container.querySelector(".stats")?.textContent ?? "";
    expect(stats).toContain("43,896,637");
    expect(stats).not.toContain("21,941,241");
    // SCOPED to the Destinations stat's own value node. `toContain("143")` over the whole strip
    // was a three-digit substring match: it happens to be unambiguous against today's other
    // stats, but 143 is a substring of any figure containing it, so the assertion could pass for
    // a reason other than the destination count being right. The whole point of this figure is
    // that origin-only reads 140 and nothing can scale its way there.
    const destinations = [...container.querySelectorAll(".stats .stat")].find(
      (s) => s.querySelector(".k")?.textContent === "Destinations",
    );
    expect(destinations?.querySelector(".v")?.textContent).toBe("143");
  });

  it("computes load factor and avg gauge from summed parts, never by averaging carriers", async () => {
    // Ratio of sums: 43,896,637 / 53,373,806 = 82.24%, and 53,373,806 / 366,350 = 145.7.
    // The mean of the 13 carrier load factors is 83.79% and the mean of their gauges is
    // 164.0 -- both plausible, both wrong, both what AVG(load_factor) produces.
    const { container } = render(await renderSEA());
    const stats = container.querySelector(".stats")?.textContent ?? "";
    expect(stats).toContain("82.24%");
    expect(stats).toContain("145.7");
    expect(stats).not.toContain("83.79%");
    expect(stats).not.toContain("164.0");
  });

  it("lists the carriers at the airport by code, biggest first, counting both directions", async () => {
    const { container } = render(await renderSEA());
    const first = container.querySelector("tbody tr");
    const cells = [...(first?.querySelectorAll("td") ?? [])].map((c) => c.textContent);
    // Alaska, by a distance, at SEA. 26,091,482 seats over both endpoints; 13,061,110
    // departing only -- so this row alone distinguishes the two implementations.
    expect(cells[1]).toBe("AS");
    expect(cells.join(" ")).toContain("26,091,482");
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

  it("offers the departing and arriving halves in the Explorer, and says they are halves", async () => {
    // The Explorer CANNOT express this page's query: its filters are AND-ed and there is no
    // either-endpoint dimension (see endpoints.ts). So the page offers the two halves it CAN
    // express and labels them as halves -- a single link claiming "the identical query" would
    // be a lie about the one thing this page does differently from /route.
    const { container } = render(await renderSEA());
    const allowlist = await loadAllowlist();
    const read = (name: RegExp) => {
      const href = screen.getByRole("link", { name }).getAttribute("href") ?? "";
      expect(href.startsWith("/explore?")).toBe(true);
      return decode(href.slice("/explore?".length), allowlist);
    };
    expect(read(/departures/i).filters).toEqual([["origin_airport_id", ["14747"]]]);
    expect(read(/arrivals/i).filters).toEqual([["dest_airport_id", ["14747"]]]);
    expect(container.textContent).toMatch(/cannot express both endpoints in one query/i);
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
  // SEA's real trailing-12 query returns 374 (carrier, destination) groups departing and 293
  // arriving, against a 5,000 limit no airport in this database reaches (measured worst case is
  // ORD at 879 origin / 855 dest per side; 959 is ORD's union), so nothing in production data
  // exercises this branch. `AirportView` takes the limit
  // as an explicit parameter for exactly that reason -- same split, same justification, as
  // RouteView's.
  async function view(limit?: number, mixLimit?: number) {
    const r = await resolveAirportCode("SEA");
    if (r.kind !== "ok") throw new Error("expected SEA to resolve for this fixture");
    return await AirportView({ airport: r.airport, limit, mixLimit });
  }

  it("discloses when a side hits the row limit", async () => {
    render(await view(2));
    expect(screen.getByText(/top 2 /i)).toBeDefined();
  });

  it("does not disclose at the real limit", async () => {
    render(await view());
    expect(screen.queryByText(/top \d+ /i)).toBeNull();
  });

  it("discloses a truncated CHART separately, and does not 500 for being big", async () => {
    // The chart is a SECOND union over three SEPARATE LIMIT-ed pivots, and it shipped without
    // the `partial` guard its sibling has: a truncated side drops a cell the overlap query
    // still returns, inclusionExclusion throws, and the page 500s -- with the proxy's
    // `public, s-maxage=2592000` already on the response, so the CDN pins that 500 for a month.
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

describe("/airport/<code> redirect and 404", () => {
  it("redirects a lowercase code permanently (308) to the canonical URL", async () => {
    expect(await catchDigest("sea")).toBe("NEXT_REDIRECT;replace;/airport/SEA;308;");
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
