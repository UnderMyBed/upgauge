// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CarrierPage, { CarrierView, generateMetadata } from "@/app/carrier/[code]/page";
import { decode } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist } from "@/lib/db";
import { resolveCarrier } from "@/lib/carrier";

/** Every figure asserted below was measured against the built warehouse for
 * op_airline_id 19790 over 2025-05..2026-04 (the trailing 12 months this page shows):
 *
 *   17 aircraft types · seats 167,718,257 · passengers 138,932,990 · departures 1,024,444
 *   load factor  138,932,990 / 167,718,257 = 82.84%   (mean of the 17 rows: 83.34%)
 *   avg gauge    167,718,257 /   1,024,444 = 163.7    (mean of the 17 rows: 194.8)
 *
 * The two means are the point. CLAUDE.md calls averaging a derived measure "the #1 bug in
 * every homemade T-100 tool", and both wrong answers are within a plausible range -- 83.34% is
 * not obviously wrong next to 82.84%. Asserting the exact figure is what tells them apart;
 * asserting "a percentage renders" would not. The gauge pair (163.7 vs 194.8) is the same test
 * with a much wider gap, so a rounding change cannot make it accidentally pass. */
const DL = {
  id: 19790,
  name: "Delta Air Lines Inc.",
  types: 17,
  seats: "167,718,257",
  passengers: "138,932,990",
  departures: "1,024,444",
  loadFactor: "82.84%",
  avgGauge: "163.7",
} as const;

/** `permanentRedirect`/`notFound` throw rather than return -- same helper, same reasoning, as
 * route/[pair]/page.test.tsx's. */
async function catchDigest(code: string): Promise<string> {
  try {
    await CarrierPage({ params: Promise.resolve({ code }) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`CarrierPage(${JSON.stringify(code)}) did not throw`);
}

/** The CONTENT column's text, excluding the legend rail.
 *
 * Load-bearing for the two caveat tests below, and the reason they are not satisfiable by
 * accident: `LegendRail` already carries a generic version of both claims ("Operating carrier
 * is the grain: a Delta-branded regional files under its own code, not DL" and "Codes and
 * names are current identity"), on every data view in the product. A test that searched the
 * whole page for those ideas would pass on a `/carrier` page that said nothing about its own
 * subject at all -- it would be measuring `LegendRail`, which has its own tests. Scoping to
 * `.body > div` puts the rail out of reach, so the claim has to be made HERE, about THIS
 * carrier, to be seen. */
function content(container: HTMLElement): string {
  return container.querySelector(".body > div")?.textContent ?? "";
}

describe("/carrier/<code>", () => {
  it("renders the code and the carrier name", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    // Scoped to `.entity .code`: the chart's subtitle names the same carrier, so an unscoped
    // match would find two nodes and throw. Same scoping, same reason, as the route page's.
    expect(container.querySelector(".entity .code")?.textContent).toBe("DL");
    expect(container.querySelector(".entity .ename")?.textContent).toBe(DL.name);
  });

  it("shows DATA AS OF", async () => {
    render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("lists the aircraft types operated, by short name and never by raw BTS code", async () => {
    // M4a's invariant, applied to this page: the table is keyed on AIRCRAFT_TYPE, whose values
    // are zero-padded three-digit strings ('888' is the 737-900ER, '699' the A321). Rendering
    // those is the failure `resolve.ts` exists to prevent, and it looks like a working page.
    // Asserting BOTH directions -- a real short name is present AND no cell is a bare code --
    // is what distinguishes "resolved" from "happened to render something".
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const codes = [...container.querySelectorAll("tbody td.id")].map((c) => c.textContent ?? "");
    expect(codes.length).toBe(DL.types);
    expect(codes).toContain("B737-9ER");
    expect(codes.some((c) => /^\d{3}$/.test(c))).toBe(false);
  });

  it("computes load factor and gauge from summed parts, never by averaging the rows", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const stats = container.querySelector(".stats")?.textContent ?? "";
    expect(stats).toContain(DL.loadFactor);
    expect(stats).toContain(DL.avgGauge);
    // The wrong answers, named explicitly. A mean-of-rows implementation renders these
    // instead, and both look entirely reasonable on screen.
    expect(stats).not.toContain("83.34%");
    expect(stats).not.toContain("194.8");
  });

  it("shows the additive totals and the type count", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const stats = container.querySelector(".stats")?.textContent ?? "";
    expect(stats).toContain(DL.seats);
    expect(stats).toContain(DL.passengers);
    expect(stats).toContain(DL.departures);
    expect(stats).toContain("Aircraft types");
  });

  it("offers the same query in the Explorer, filtered on the airline id", async () => {
    // Round-tripped through the real decode(), not matched as a string: it fails on a missing
    // or extra filter, the wrong dimension, or -- the case this page can get wrong while still
    // rendering -- a filter carrying the letter code instead of the airline id.
    render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const href = screen.getByRole("link", { name: /Explorer/i }).getAttribute("href") ?? "";
    expect(href.startsWith("/explore?")).toBe(true);
    const query = decode(href.slice("/explore?".length), await loadAllowlist());
    expect(query.dimensions).toEqual(["aircraft_type"]);
    expect(query.filters).toEqual([["op_airline_id", [String(DL.id)]]]);
    expect(query.grain).toBe("segment");
  });

  it("shows the legend rail, with the fleet-shading group the chart needs", async () => {
    render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    expect(screen.getByText("Chart legend")).toBeDefined();
    expect(screen.getByText(/darkening stack is an upgauge/i)).toBeDefined();
  });
});

// The two claims CLAUDE.md makes hard rules and this page cannot omit. Both read as BUGS to
// anyone who knows the network if left unsaid: the operated/marketed distinction makes DL's
// numbers look too low, and a current code presented as historical fact makes a 2016 row look
// mislabelled.
//
// Each is asserted twice, on two different carriers, and that pairing is the whole design.
// A note hard-coded to Delta -- the obvious way to write this while reading the spec, whose
// every example is Delta -- passes the DL half and fails the AS half. A note deleted entirely
// fails both. A note moved into the shared LegendRail (which already says both things
// generically, for every page in the product) fails both, because `content()` cannot see the
// rail. The substantive clause is asserted, not the topic word: "operating" alone appears in
// this codebase's grouping toggle, its measure labels and its rail, so matching on it would
// be satisfied by a page that made no claim at all.
describe("/carrier/<code> states what it is counting", () => {
  it("says the figures are what this carrier OPERATED, not what it marketed", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const text = content(container);
    expect(text).toContain(DL.name);
    expect(text).toMatch(/operating carrier/i);
    expect(text).toMatch(/no marketing-carrier field/i);
    // The consequence, which is the part a reader needs and the part a generic sentence
    // leaves out: the excluded flying is counted somewhere else, under someone else's code.
    expect(text).toMatch(/DL-branded/);
    expect(text).toMatch(/counted there, not here/i);
  });

  it("makes that claim about the carrier the page is actually about", async () => {
    // Alaska, not Delta. Kills a hard-coded subject, which no assertion on the DL page can.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "AS" }) }));
    const text = content(container);
    expect(text).toMatch(/Alaska Airlines/);
    expect(text).toMatch(/AS-branded/);
    expect(text).not.toMatch(/Delta/);
  });

  it("says the code and name are CURRENT identity, not what was filed at the time", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const text = content(container);
    expect(text).toMatch(/current identity/i);
    expect(text).toMatch(/not the code it filed under/i);
  });

  it("makes the identity claim about this page's own code", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "AS" }) }));
    const text = content(container);
    expect(text).toMatch(/current identity/i);
    // The sentence names the subject's code, so it cannot have been written for Delta and
    // left there.
    expect(text).toMatch(/AS and “Alaska Airlines/);
  });
});

describe("/carrier/<code> aircraft-mix chart", () => {
  it("draws the chart above the table, over the FULL window", async () => {
    const asOf = await dataAsOf();
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const svg = container.querySelector(".chart svg[role='img']");
    const table = container.querySelector("table");
    expect(svg).not.toBeNull();
    expect(table).not.toBeNull();
    expect(svg!.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The chart's own aria-label names the window it actually drew -- the honest witness. A
    // chart handed the table's trailing 12 months instead renders a plausible twelve-point
    // area under a page claiming a decade.
    expect(svg!.getAttribute("aria-label")).toContain(`2015-01 to ${asOf}`);
  });

  it("states both windows in the window line, since the page shows two", async () => {
    const asOf = await dataAsOf();
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const line = container.querySelector(".window")?.textContent ?? "";
    expect(line).toMatch(/trailing 12 months/i);
    expect(line).toContain(`2015-01 → ${asOf}`);
    expect(line).toMatch(/2025-\d\d → /);
  });
});

// Virgin America: airline_id 21171, 4,275 filed rows over 2015-01..2018-03 and nothing since
// (measured). 45 of this database's 114 fact-present carriers last filed before the current
// trailing-12 window -- 39%, so a resolvable carrier with an empty table is a normal case here,
// not an oddity, and the chart is the only panel with anything in it.
describe("/carrier/<code> with nothing in the trailing 12 months", () => {
  it("states the finding in words and offers the widened window", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "VX" }) }));
    expect(container.querySelector("table")).toBeNull();
    expect(screen.getByText(/Virgin America \(VX\) filed no segments/)).toBeDefined();
    expect(screen.getByRole("link", { name: /2015-01/ })).toBeDefined();
  });

  it("still draws the history, and names the range it can actually draw", async () => {
    // Gating the chart on `!isEmpty` -- the obvious way to write the mount -- would blank the
    // only panel on this page with anything in it, and would pass every other test in this
    // file. The window line must name 2018-03, the last month VX filed, not asOf: stating the
    // requested window over a chart that stops in 2018 is the same fabrication as
    // interpolating across a gap (M4c, Finding 1).
    const asOf = await dataAsOf();
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "VX" }) }));
    expect(container.querySelector(".chart svg[role='img']")).not.toBeNull();
    const line = container.querySelector(".window")?.textContent ?? "";
    const chartHalf = line.slice(line.indexOf("chart:"));
    expect(chartHalf).toContain("2015-01 → 2018-03");
    expect(chartHalf).not.toContain(asOf);
    expect(chartHalf).not.toMatch(/full window/);
  });

  it("still states both caveats when there is no table to qualify", async () => {
    // The claims are about the SUBJECT, not about the rows: a page that only rendered them
    // alongside a populated table would drop them on 39% of carriers.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "VX" }) }));
    const text = content(container);
    expect(text).toMatch(/no marketing-carrier field/i);
    expect(text).toMatch(/current identity/i);
  });
});

describe("/carrier/<code> redirect and 404", () => {
  it("308s a lower-case code to the canonical URL", async () => {
    // The exact digest, read from Next 16's own source the way the route page's test is:
    // `permanentRedirect` throws `.digest === 'NEXT_REDIRECT;${type};${url};${statusCode};'`,
    // so a regression to plain `redirect()` shows up as ';307;' and fails here.
    expect(await catchDigest("dl")).toBe("NEXT_REDIRECT;replace;/carrier/DL;308;");
  });

  it("404s a code that is in no carrier table at all", async () => {
    expect(await catchDigest("ZZ")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("404s a recognized code that has never filed", async () => {
    // PA (Pan American World Airways) is a real BTS carrier code with three airline_ids and
    // zero T-100 Segment rows. A DIFFERENT reason from ZZ's inside resolveCarrier's wording,
    // reaching the same notFound() -- so a future change that special-cased one of the two
    // still fails here.
    expect(await catchDigest("PA")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("/carrier/<code> canonical metadata (M5, Task 2)", () => {
  it("declares the canonical URL for an already-canonical code", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "DL" }) });
    expect(meta.alternates?.canonical).toBe("https://upgauge.shipman.dev/carrier/DL");
  });

  it("declares dim_carrier's own spelling for a lowercase request, not the request", async () => {
    // The bug to exclude, same shape as /airport/sea: emitting the requested spelling.
    // /carrier/dl never renders this page in production (it 308s first), but the canonical
    // tag must still name `dim_carrier`'s own code.
    const meta = await generateMetadata({ params: Promise.resolve({ code: "dl" }) });
    expect(meta.alternates?.canonical).toBe("https://upgauge.shipman.dev/carrier/DL");
  });

  it("returns no canonical for a code that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "ZZ" }) });
    expect(meta.alternates?.canonical).toBeUndefined();
  });
});

// `truncated` and its disclosure are reachable only when a carrier's type count hits the
// limit. The busiest carrier operates 18 types in the trailing 12 months and 23 all-time
// (measured), nowhere near CARRIER_TYPE_LIMIT, so -- exactly as on /route -- the branch is
// driven through the exported `CarrierView` with a smaller limit against real rows, never a
// mock.
describe("/carrier/<code> truncation disclosure", () => {
  it("discloses when the type limit is reached", async () => {
    const r = await resolveCarrier("DL");
    if (r.kind !== "ok") throw new Error("expected DL to resolve for this fixture");
    render(await CarrierView({ carrier: r.carrier, filterValue: r.filterValue, limit: 5 }));
    expect(screen.getByText(/top 5 aircraft types/i)).toBeDefined();
  });

  it("does not disclose below the limit", async () => {
    // The pair: 17 real rows against the real limit. Fails if the disclosure ever renders
    // unconditionally, which the test above cannot catch.
    const r = await resolveCarrier("DL");
    if (r.kind !== "ok") throw new Error("expected DL to resolve for this fixture");
    render(await CarrierView({ carrier: r.carrier, filterValue: r.filterValue }));
    expect(screen.queryByText(/top \d+ aircraft types/i)).toBeNull();
  });
});
