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

// THE CALL SITE, WHICH NO FIXTURE CAN REACH. `/carrier`'s wholly-quarantined foot is unreachable
// on this warehouse -- no carrier's every trailing-12 filing is quarantined (measured) -- so
// before the clause was hoisted to lib/, its copy of that sentence could be replaced with garbage
// and all 1,516 tests plus all 663 served checks stayed green. Review found exactly that, on the
// call site one file over from the card whose identical hole #121 had already closed with a spy.
//
// The clause itself is asserted at its four cells in lib/quarantineClause.test.ts. What is left
// to pin is that THIS page reaches it with ITS OWN subject and count line, and that hop is
// reachable on any carrier -- the arguments are supplied before the branch is chosen. The spy
// CALLS THROUGH, so the rendered page is the real one.
const clauseSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/quarantineClause", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quarantineClause")>();
  clauseSpy.mockImplementation(actual.quarantineClause);
  return { ...actual, quarantineClause: clauseSpy };
});
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
import CarrierPage, {
  CarrierView,
  carrierRedirectTarget,
  generateMetadata,
} from "@/app/carrier/[code]/page";
import { decode } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist } from "@/lib/db";
import { fetchCarrierDiff } from "@/lib/map/carrierDiff";
import { resolveCarrier } from "@/lib/carrier";

/** Every figure asserted below was measured against the built warehouse for
 * op_airline_id 19790 over 2025-06..2026-05 (the trailing 12 months this page shows):
 *
 *   17 aircraft types · seats 167,780,538 · passengers 139,046,982 · departures 1,025,515
 *   load factor  139,046,982 / 167,780,538 = 82.87%   (mean of the 17 rows: 83.33%)
 *   avg gauge    167,780,538 /   1,025,515 = 163.6    (mean of the 17 rows: 194.7)
 *
 * The two means are the point. CLAUDE.md calls averaging a derived measure "the #1 bug in
 * every homemade T-100 tool", and both wrong answers are within a plausible range -- 83.34% is
 * not obviously wrong next to 82.87%. Asserting the exact figure is what tells them apart;
 * asserting "a percentage renders" would not. The gauge pair (163.6 vs 194.7) is the same test
 * with a much wider gap, so a rounding change cannot make it accidentally pass. */
const DL = {
  id: 19790,
  name: "Delta Air Lines Inc.",
  types: 17,
  seats: "167,780,538",
  passengers: "139,046,982",
  departures: "1,025,515",
  loadFactor: "82.87%",
  avgGauge: "163.6",
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
    // Scoped to the FIRST table: M6 Task 4 added a "Top routes" and a "Top origin airports"
    // table below this one, each with their own `td.id` cells, so an unscoped query would
    // count all three tables' identifier cells together.
    const codes = [...container.querySelectorAll("table")[0].querySelectorAll("tbody td.id")].map(
      (c) => c.textContent ?? "",
    );
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
    expect(stats).not.toContain("83.33%");
    expect(stats).not.toContain("194.7");
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
    // Exact name, not /Explorer/i -- M6 Task 4 added two more Explorer links (Top routes,
    // Top origin airports), each with its own distinguishing text.
    const href =
      screen.getByRole("link", { name: "Open in the Explorer" }).getAttribute("href") ?? "";
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
  // #106. This redirect used to build `/carrier/DL` from the slug alone, silently dropping
  // every query key -- so `/carrier/dl?type=B737-8` would have 308ed to `/carrier/DL` with the
  // filter gone entirely, and the destination would have rendered the unfiltered view with no
  // error anywhere. The identical measured bug `/airport` fixed with `airportRedirectTarget`.
  //
  // Asserting the digest STRING, not merely that a redirect fired: "a redirect happened" is true
  // both before and after the fix, so the test immediately below would keep passing under the
  // bug. The string is what discriminates.
  it("preserves a filter query across the case-normalization redirect", async () => {
    vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: "type=B737-8" }));
    expect(await catchDigest("dl")).toBe(
      "NEXT_REDIRECT;replace;/carrier/DL?type=B737-8;308;",
    );
  });

  it("preserves an UNRESOLVABLE filter across the same redirect, rather than dropping it", async () => {
    // A redirect that stripped a bad filter would be the same silent-fallback bug in a different
    // coat: the canonical URL must reach the same refusal the direct URL does -- `no-store` from
    // proxy.ts, and (once #107/#108 land the page surface) a named error -- not quietly render
    // the unfiltered view because the redirect erased the evidence anything was wrong.
    vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: "type=NOPE-1" }));
    expect(await catchDigest("dl")).toBe(
      "NEXT_REDIRECT;replace;/carrier/DL?type=NOPE-1;308;",
    );
  });

  it("appends nothing for an empty raw query, rather than a stray '?'", () => {
    // The bare-request case, and the reason the helper tests the LENGTH rather than appending
    // unconditionally: every pre-existing redirect on this page carries no query at all.
    expect(carrierRedirectTarget("DL", "")).toBe("/carrier/DL");
    expect(carrierRedirectTarget("DL", "type=B737-8")).toBe("/carrier/DL?type=B737-8");
  });

  it("passes the raw query through VERBATIM, without re-encoding it", () => {
    // Reassembling a query from decoded params is the corruption `lib/rawQuery.ts`'s header
    // exists to prevent -- a `,` inside a value becomes indistinguishable from a separator. This
    // helper concatenates bytes and must never normalize them.
    expect(carrierRedirectTarget("DL", "type=%42%37")).toBe("/carrier/DL?type=%42%37");
  });

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
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/carrier/DL");
  });

  it("declares dim_carrier's own spelling for a lowercase request, not the request", async () => {
    // The bug to exclude, same shape as /airport/sea: emitting the requested spelling.
    // /carrier/dl never renders this page in production (it 308s first), but the canonical
    // tag must still name `dim_carrier`'s own code.
    const meta = await generateMetadata({ params: Promise.resolve({ code: "dl" }) });
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/carrier/DL");
  });

  it("returns no canonical for a code that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "ZZ" }) });
    expect(meta.alternates?.canonical).toBeUndefined();
  });
});

// M9 Task 6b (og-cards FINDING 6): same finding as /route's -- `og:title` read "Upgauge" on a
// served /carrier/DL, not the carrier, because generateMetadata returned only
// `alternates.canonical`.
describe("/carrier/<code> Open Graph metadata (M9 Task 6b)", () => {
  it("carries the carrier code AND name in openGraph.title, not the bare code alone", async () => {
    // Fix round 1: `title: code` alone matched `.entity .code` (asserted above) but dropped
    // `.entity .ename` -- a pasted link previewing as bare "DL" delivers half the entity, and
    // `og:title` has no second line the way the OG image's title/subtitle split does. Pinned
    // to the exact string measured against the real warehouse (`dim_carrier`'s current
    // spelling, "Delta Air Lines Inc." -- with the "Inc.", not the design spec's shortened
    // worked example), not a substring match.
    const meta = await generateMetadata({ params: Promise.resolve({ code: "DL" }) });
    expect(meta.openGraph?.title).toBe("DL — Delta Air Lines Inc.");
  });

  it("states the data view honestly in openGraph.description, without a fare or real-time claim", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "DL" }) });
    const description = meta.openGraph?.description ?? "";
    expect(description).toContain("DL");
    expect(description).toMatch(/US DOT T-100/);
    expect(description).toMatch(/operated flights only/i);
    expect(description).toMatch(/not fares or real-time/i);
  });

  it("omits openGraph for a code that cannot resolve at all", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ code: "ZZ" }) });
    expect(meta.openGraph).toBeUndefined();
  });
});

// `truncated` and its disclosure are reachable only when a carrier's type count hits the
// limit. The busiest carrier operates 18 types in the trailing 12 months and 23 all-time
// (measured), nowhere near CARRIER_TYPE_LIMIT, so -- exactly as on /route -- the branch is
// driven through the exported `CarrierView` with a smaller limit against real rows, never a
// mock.
// M6 Task 4: the Top-N builder's first two callers. "Top origin airports", not "airports
// served" -- the pivot filters origin_airport_id only. Unlike the M6-era comment this used to
// carry: the either-endpoint filter is NOT missing -- M7 Task 3 built `endpoint_airport_id` and
// /airport/<code> uses it. The reason THIS table stays origin-only is different and still true:
// ranking airports means grouping BY airport, and `endpoint_airport_id` is `filter_only`
// (M7 Task 2's `for_grouping` guard rejects it as a grouping dimension, the same way it would
// double-count a segment row into both its origin's and its dest's group). An "airports served"
// heading over an origin-only query is a quiet false claim, the same shape as /airport reading
// 26,710,000 seats instead of 53,373,806 when it dropped a union term.
describe("/carrier/<code> Top-N tables", () => {
  it("labels the airports table 'origin', because either-endpoint is not what it queries", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const html = container.innerHTML;
    expect(html).toContain("Top origin airports");
    expect(html).not.toContain("Airports served");
  });

  it("heads the routes table 'Top routes' and ranks it", async () => {
    const { container } = render(
      await CarrierPage({ params: Promise.resolve({ code: "DL" }) }),
    );
    expect(screen.getByText("Top routes")).toBeDefined();
    // Two Top-N tables, each with a rank column, alongside the existing unranked
    // aircraft-type table -- DataTable never re-sorts, so rank 1 has to be the row the pivot
    // itself sorted first (measures[0] descending).
    const rankCells = container.querySelectorAll('[data-testid="rank-cell"]');
    expect(rankCells.length).toBeGreaterThan(0);
    expect(rankCells[0]?.textContent).toBe("1");
  });

  it("links the routes table to the identical Explorer query -- route dimension, this carrier, 25-row limit", async () => {
    render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const href = screen
      .getByRole("link", { name: "Open the routes query in the Explorer" })
      .getAttribute("href");
    expect(href?.startsWith("/explore?")).toBe(true);
    const query = decode(href!.slice("/explore?".length), await loadAllowlist());
    expect(query.grain).toBe("route");
    expect(query.dimensions).toEqual(["route"]);
    expect(query.filters).toEqual([["op_airline_id", [String(DL.id)]]]);
    expect(query.limit).toBe(25);
  });

  it("links the origins table to the identical Explorer query -- origin_airport_id, this carrier", async () => {
    render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const href = screen
      .getByRole("link", { name: "Open the origin airports query in the Explorer" })
      .getAttribute("href");
    expect(href?.startsWith("/explore?")).toBe(true);
    const query = decode(href!.slice("/explore?".length), await loadAllowlist());
    expect(query.grain).toBe("segment");
    expect(query.dimensions).toEqual(["origin_airport_id"]);
    expect(query.filters).toEqual([["op_airline_id", [String(DL.id)]]]);
  });

  it("states what the origin table counts and the REAL reason, not the retired 'no filter yet' claim", async () => {
    // Replaces an assertion on the old (false, as of M7 Task 3) claim that there is no
    // either-endpoint filter. The real reason is that ranking airports requires grouping BY
    // the endpoint dimension, and `endpoint_airport_id` is filter-only -- so this asserts the
    // accurate phrase AND the absence of the retired one, independently, the same shape as the
    // /airport Critical fix.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const text = container.textContent ?? "";
    expect(text).toMatch(/departures from each airport/i);
    expect(text).toMatch(/filter-only/i);
    expect(text).not.toMatch(/no either-endpoint filter yet/i);

    // ...and the FACT the copy rests on, read from the LIVE catalog rather than from the
    // word. The two assertions above are still assertions on a phrase: if a future change
    // made `endpoint_airport_id` groupable, this page's stated reason would become false and
    // both of them would stay green -- which is the failure shape M7's own review found seven
    // times. This line is what actually couples the copy to the thing it claims.
    const endpoint = (await loadAllowlist()).dims.get("endpoint_airport_id");
    expect(endpoint?.filterOnly).toBe(true);
  });
});

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

/**
 * #107 -- the network map section.
 *
 * The filter is driven as a RESOLVED `MapFilter`, taken from the real `resolveTypeFilter`
 * against the real warehouse rather than hand-built, so these fixtures cannot drift from what
 * the page is actually handed: `CE-180` really is ambiguous (BTS codes 030 and 031, both
 * fact-present), and `NOPE-1` really is unknown. The one exception is the raw-query pair at the
 * bottom, which drives `CarrierPage` end-to-end because the header read is the thing under test.
 */
import { resolveTypeFilter } from "@/lib/map/mapFilter";

// MERGE (#107 x #110): `segment-map` matches #110's three diff panels too, so this must name
// the ROLE. Queried un-scoped it found DL's "added" panel and the no-map assertions inverted.
const mapOf = (c: HTMLElement) => c.querySelector('[data-testid="network-map"]');
const pickerOf = (c: HTMLElement) => c.querySelector('[data-testid="map-picker"]');
const clearOf = (c: HTMLElement) =>
  [...c.querySelectorAll("a")].find((a) => a.textContent === "Clear the filter") ?? null;

async function viewOf(code: string, typeFilter?: Awaited<ReturnType<typeof resolveTypeFilter>>) {
  const r = await resolveCarrier(code);
  if (r.kind !== "ok") throw new Error(`expected ${code} to resolve for this fixture`);
  return render(
    await CarrierView({ carrier: r.carrier, filterValue: r.filterValue, typeFilter }),
  );
}

describe("/carrier/<code> network map", () => {
  it("renders the picker and draws no map when no type is selected", async () => {
    // BOTH halves, in one test, on purpose: a `CarrierView` that threw or rendered nothing
    // would satisfy the "no map" clause alone, and prove nothing.
    const { container } = await viewOf("DL");
    expect(pickerOf(container)).not.toBeNull();
    expect(mapOf(container)).toBeNull();
  });

  it("offers no way back when there is nothing to go back from", async () => {
    // The clear link's ABSENCE is the property. Rendered unconditionally it is a live link to
    // the page you are already on, which reads as a control that does nothing.
    const { container } = await viewOf("DL");
    expect(clearOf(container)).toBeNull();
  });

  it("draws the map when a type resolves", async () => {
    const { container } = await viewOf("DL", await resolveTypeFilter("B737-8"));
    expect(mapOf(container)).not.toBeNull();
  });

  it("marks the showing type in the picker, so the reader can see which view this is", async () => {
    // POSITION, not presence: `aria-current="page"` must land on the B737-8 option and on no
    // other. Asserting merely that some option carries it passes under a picker that marks the
    // wrong one, and asserting the option EXISTS passes under one that marks nothing -- which
    // is what shipped, because `selected` compared a slug against a BTS id.
    const { container } = await viewOf("DL", await resolveTypeFilter("B737-8"));
    const current = [...container.querySelectorAll('[data-testid="map-picker"] a[aria-current="page"]')];
    expect(current.map((a) => a.getAttribute("href"))).toEqual(["/carrier/DL?type=B737-8"]);
  });

  it("returns to the unfiltered page, not to the filtered URL", async () => {
    const { container } = await viewOf("DL", await resolveTypeFilter("B737-8"));
    expect(clearOf(container)?.getAttribute("href")).toBe("/carrier/DL");
  });

  it("refuses an ambiguous type rather than picking one of its holders", async () => {
    // `CE-180` names BTS codes 030 and 031, both fact-present. Picking one is the silent-pick
    // failure `/carrier/PA` exists to refuse.
    //
    // THE CARRIER IS Q5 (40-Mile Air, airline_id 20342) AND THAT IS THE WHOLE TEST. On DL --
    // the obvious fixture, and the one this test was first written with -- a page that silently
    // picked a holder would fetch DL x 030 or DL x 031, get NULL from both because DL flies no
    // Cessna 180s, and render no map. The assertion below would pass over the defect: an
    // outcome the buggy implementation also produces. Q5 is the only carrier in the warehouse
    // that flies either code (measured over the trailing 12: 031, four rows), and Q5 x 031
    // returns a real 2-segment map -- so under a silent pick a map APPEARS here and this goes
    // red.
    //
    // Residual, stated rather than papered over: the 030 direction stays unobservable, because
    // no carrier in this dataset flies 030 at all. No fixture can fix that, and the sibling
    // catalog test in picker.test.ts pins the reason (no carrier flies both codes of one short
    // name). The holder list below is what covers the rest: naming one holder and drawing its
    // map is the half-wrong state a bare "no map" assertion would miss.
    const filter = await resolveTypeFilter("CE-180");
    expect(filter.kind).toBe("ambiguous");
    const { container } = await viewOf("Q5", filter);
    expect(mapOf(container)).toBeNull();
    expect([...container.querySelectorAll('[data-testid="mp-holder"]')].map((li) => li.textContent))
      .toEqual(["030", "031"]);
  });

  it("keeps the picker and the way back reachable under a refusal", async () => {
    // A refusal that leaves the reader with nothing to do is a dead end. Both refusal kinds,
    // because they are two different findings and the page renders them through one branch.
    for (const raw of ["CE-180", "NOPE-1"]) {
      const { container } = await viewOf("DL", await resolveTypeFilter(raw));
      expect(container.querySelector(".mp-list")).not.toBeNull();
      expect(clearOf(container)?.getAttribute("href")).toBe("/carrier/DL");
    }
  });

  it("refuses an unknown type and draws no map", async () => {
    const filter = await resolveTypeFilter("NOPE-1");
    expect(filter.kind).toBe("unknown");
    const { container } = await viewOf("DL", filter);
    expect(mapOf(container)).toBeNull();
  });

  it("says so when a real type resolved but this carrier filed none of it", async () => {
    // VX stopped filing in 2018-03, so every type is `ok` and every map is null. Reachable from
    // any hand-typed URL naming a type the carrier does not operate; without this the heading
    // would sit above a silent gap.
    const { container } = await viewOf("VX", await resolveTypeFilter("B737-8"));
    expect(mapOf(container)).toBeNull();
    expect(screen.getByText(/VX filed no B737-8 routes in/)).toBeDefined();
  });

  it("discloses a truncated picker list", async () => {
    const r = await resolveCarrier("DL");
    if (r.kind !== "ok") throw new Error("expected DL to resolve for this fixture");
    const { container } = render(
      await CarrierView({ carrier: r.carrier, filterValue: r.filterValue, limit: 5 }),
    );
    expect(container.querySelector(".mp-note")).not.toBeNull();
  });

  it("does not claim a truncated picker below the limit", async () => {
    const { container } = await viewOf("DL");
    expect(container.querySelector(".mp-note")).toBeNull();
  });
});

describe("/carrier/<code> reads the filter from the raw query bytes", () => {
  it("draws the map for a filter that arrives on the raw-query header", async () => {
    vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: "type=B737-8" }));
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    expect(mapOf(container)).not.toBeNull();
  });

  it("refuses a percent-spelled filter the proxy already declined to cache", async () => {
    // THE DIVERGENCE, and the reason this page must not read `searchParams`. `?type=%42737-8`
    // decodes to "B737-8", so a `searchParams`-based page draws the map -- while `proxy.ts`
    // reads the same key on the RAW bytes, fails the no-percent bound and sets `no-store`. The
    // page would then be applying a filter the server's admission policy refused: one value,
    // two readings. The needle is the MAP, not the header, because the header is the proxy's.
    vi.mocked(headers).mockResolvedValueOnce(
      new Headers({ [RAW_QUERY_HEADER]: "type=%42737-8" }),
    );
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    expect(mapOf(container)).toBeNull();
    expect(pickerOf(container)).not.toBeNull();
  });
});

/* ---- #110: the diff map, driven against the REAL warehouse through the real page ---- */
/* Fixtures prove the component; these prove the WIRING -- that `carrier.id` reaches
 * `fetchCarrierDiff`, that the section lands inside the content column, and that the three
 * carriers whose shapes the plan names actually render the way the shapes predict. A component
 * test cannot see any of that: it is handed its `diffs` by the test. */
describe("/carrier/<code> diff map (#110)", () => {
  function diffPanels(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-testid="diff-panel"]')];
  }

  it("renders all three panels, in order, on a carrier that has all three", async () => {
    // AS: 225 added, 138 dropped, 128 downgauged, every panel UNDER the cap
    // (map_carrier_diff.sql's per-carrier table), so nothing here is masked by truncation.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "AS" }) }));
    const labels = diffPanels(container).map(
      (p) => p.querySelector('[data-testid="diff-panel-label"]')?.textContent,
    );
    expect(labels).toEqual(["Added", "Dropped", "Downgauged"]);
  });

  it("gives the three real panels three DISTINCT accessible names", async () => {
    // The live half of the `title` fix. Added and downgauged SHARE the trailing window, so
    // before this unit two of these three were byte-identical strings.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "AS" }) }));
    const labels = diffPanels(container).map(
      (p) => p.querySelector("svg[role='img']")?.getAttribute("aria-label") ?? "",
    );
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(3);
    expect(labels[0]).toContain("AS added.");
    expect(labels[1]).toContain("AS dropped.");
    expect(labels[2]).toContain("AS downgauged.");
  });

  it("labels a single-category carrier by ITS category, not by panel index", async () => {
    // ZW (Air Wisconsin): 92 dropped, 0 added, 0 downgauged. A component that labelled panels by
    // POSITION in DIFF_CATEGORIES rather than by each panel's own `category` calls this one
    // "Added" -- and on AS, where all three are present, index and category agree, so the test
    // above cannot fail that way. 26 of the 66 carriers with any change have an empty category.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "ZW" }) }));
    const panels = diffPanels(container);
    expect(panels).toHaveLength(1);
    expect(panels[0].querySelector('[data-testid="diff-panel-label"]')?.textContent).toBe("Dropped");
    expect(panels[0].querySelector("svg[role='img']")?.getAttribute("aria-label")).toContain(
      "ZW dropped.",
    );
  });

  it("states the carrier-wide quarantine count on a carrier with NO drawable arc", async () => {
    // F4 (Air Flamenco, 21615) is the one carrier of 114 in this state: 3 undrawable
    // carrier-routes, zero arcs. `panels` is empty and `quarantinedRoutes` is not, so a section
    // gated on the panels drops the count entirely -- the "no trace that anything was there"
    // this field exists to prevent, on a page that is live in the sitemap.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "F4" }) }));
    expect(diffPanels(container)).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="diff-quarantine"]')?.textContent,
    ).toMatch(/^3 of F4’s route pairs are on no panel above/);
  });

  it("renders THIS carrier's diff, not some other carrier's", async () => {
    // THE WIRING ITSELF, as a round trip rather than a shape check. Every other test here passes
    // unchanged if `carrier.id` is replaced by a hardcoded id -- WN, DL and AA all have three
    // non-empty categories too, so "three panels, in order, with distinct names" is TRUE of the
    // wrong carrier's data. Measured: swapping in WN's 19393 left every one of them green.
    //
    // So the binding is to the NUMBERS: the page's rendered pre-cap totals must equal what the
    // producer returns for the id this page resolved. No figure is hardcoded, so this does not
    // rot on a BTS refresh -- it re-derives both sides from the same warehouse.
    const r = await resolveCarrier("AS");
    if (r.kind !== "ok") throw new Error("expected AS to resolve for this fixture");
    const expected = await fetchCarrierDiff(r.carrier.id, await dataAsOf());
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "AS" }) }));
    const rendered = diffPanels(container).map((p) => {
      const text = p.querySelector('[data-testid="diff-panel-count"]')?.textContent ?? "";
      const m = /^AS (added|dropped|downgauged) ([\d,]+) route pair/.exec(text);
      if (m === null) throw new Error(`count sentence did not parse: ${text}`);
      return { category: m[1], total: Number(m[2].replace(/,/g, "")) };
    });
    expect(rendered).toEqual(
      expected.panels.map((d) => ({ category: d.category, total: d.map.totalRoutes })),
    );
    // The fixture only bites if the categories actually carry different totals -- otherwise a
    // wrong-carrier id could coincide. AS's three are 225 / 138 / 128 on the 2026-05 warehouse.
    expect(new Set(rendered.map((x) => x.total)).size).toBe(rendered.length);
  });

  it("puts the section inside the content column, where the page's own claims live", async () => {
    // `content()` excludes the legend rail on purpose (see its docstring). The diff map's
    // sentences are claims about THIS carrier and have to be reachable there, not parked in a
    // generic rail that has its own tests.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "AS" }) }));
    expect(content(container)).toContain("another carrier may still be flying it");
    expect(content(container)).toContain("re-entry, not first appearance");
  });

  it("renders no diff section at all for a carrier that filed in neither window", async () => {
    // VX (Virgin America) has been dormant since 2018-03: no panels and nothing withheld, so
    // there is no orphan heading and no empty map.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "VX" }) }));
    expect(container.querySelector('[data-testid="diff-map"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// THE FLOOR PARTITION AT THIS PAGE'S THREE CALL SITES (#127, review finding 1). DataTable's own
// tests prove the component partitions and that the default is on; they cannot prove any given
// page reaches it with the default intact. Since /explore carries an opt-out, `partition` is a
// real axis rather than a constant, and a per-call-site `partition={false}` is invisible to
// every test that does not read THAT page's rendered rows -- verified: adding it to any of the
// three tables below left all 1,483 tests green before these existed.
//
// /carrier is where the change has its largest measured effect: across the trailing 12 months,
// its Top routes table renders 141 below-floor rows over 24 of 70 carriers, and Top origins 85
// over 22.
//
// WHAT MAKES A FIXTURE HERE DISCRIMINATING: in the pivot's own order, a SCORED row appears
// after a below-floor one. Only then do the measure order and the partitioned order differ, and
// only then can a row-order test fail for the reason its name gives.
//
// "some below-floor row out-seats some scored one" is a PROXY for that, and it is WRONG. The
// pivot sorts `seats DESC`, which is NULLS LAST, so a wholly-quarantined group -- seats NULL,
// therefore no claim about the floor, therefore scored -- sits BELOW a below-floor row holding a
// stated 0. Zero does not out-seat NULL, and the orderings disagree anyway. Reviewing this work
// I asserted that proxy in two permanent files and used it to justify deleting coverage; two of
// the three people who then re-derived it reached the same wrong answer. Asserting through a
// proxy the buggy case also satisfies is this project's signature failure, recorded here because
// the proxy is the seductive part, not the conclusion.
//
// Re-swept over all 114 fact-present carriers and 110 aircraft short names, through the real
// queries and their real limits, with the correct predicate:
//
//     CARRIER-TYPETABLE        6 below-floor rows over  4 pages -- 0 disagreements
//     CARRIER-TOPROUTES      141 below-floor rows over 24 pages -- 2 (2O, F4)
//     CARRIER-TOPORIGINS      85 below-floor rows over 22 pages -- 1 (F4)
//     AIRCRAFT-CARRIERTABLE    6 below-floor rows over  6 pages -- 0 disagreements
//
// So both Top-N tables ARE testable behaviourally, and both are tested below, each on a carrier
// that disagrees for a DIFFERENT reason. Only the aircraft-type table here and /aircraft's
// carrier table have no discriminating page anywhere in the warehouse; those two are pinned on
// the prop instead, in app/floorPartition.callsites.test.tsx, which states why.
describe("/carrier/<code> sorts below-floor rows last", () => {
  /** One table's rendered rows: the below-floor flag, and seats as the page PRINTED them --
   * `null` where the cell is the absence marker, which is a different finding from 0 and is the
   * whole mechanism the Top-origins fixture below turns on. */
  function rowsOf(container: HTMLElement, tableIndex: number) {
    const table = container.querySelectorAll("table.data-table")[tableIndex];
    if (table === undefined) throw new Error(`no table ${tableIndex} on this page`);
    return [...table.querySelectorAll("tbody tr")].map((tr) => {
      const seats = tr.querySelectorAll("td.num")[0]?.textContent ?? "";
      return {
        belowFloor: tr.getAttribute("data-below-floor") === "true",
        seats: seats === "\u2014" ? null : Number(seats.replace(/,/g, "")),
      };
    });
  }

  /** A below-floor row may not be followed by a scored one, and the table must hold at least one
   * of each -- otherwise the assertion is vacuous and passes against the bug. */
  function expectContiguousSuffix(flags: boolean[]) {
    const first = flags.indexOf(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(flags.slice(0, first).length).toBeGreaterThan(0);
    expect(flags.slice(first).includes(false)).toBe(false);
  }

  it("sorts the Top routes table's below-floor rows last, and withholds their rank", async () => {
    // 2O: 25 rows, 2 below floor, disagreeing the ORDINARY way -- a below-floor row (179 seats,
    // 28 departures) out-seats three scored ones (176, 169, 168), so the measure sort puts it at
    // 21 of 25 and the partition has to move it.
    //
    // NOT 4W, AND THE REASON IS THE SHARPEST TRAP THIS UNIT TURNED UP.
    //
    // *A fixture that exercises one of two asserted properties is the vacuous fixture wearing
    // half a disguise.*
    //
    // This test asserts two things: the ORDER (below-floor rows last) and the RANK (1..k, then
    // em dashes). 4W's below-floor rows are already last by seats, so both orderings agree on it
    // and the order half could never fail. The rank half still could -- and did. So the mutant
    // died, the run reported this test by name as having refused it, and the property in the
    // test's own title was never exercised at all. A reviewer and the conductor both signed off
    // on 4W on exactly that evidence; it was found while fixing something else.
    //
    // CLAUDE.md's existing rule catches the fixture that fails to discriminate at all. This is
    // the partial case, and a mutation report cannot distinguish it from real coverage: "test X
    // went red" is true either way. The only thing that separates them is checking, per asserted
    // property, that the fixture can distinguish correct from buggy ON THAT PROPERTY -- which is
    // what the fixture guard below does, and why it is a separate assertion rather than a
    // comment.
    // MUTANT: `partition={false}` at the Top routes DataTable -> red here.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "2O" }) }));
    const rows = rowsOf(container, 1);
    expectContiguousSuffix(rows.map((r) => r.belowFloor));
    // THE FIXTURE GUARD: a below-floor row really does out-seat a scored one here, so the two
    // orderings genuinely disagree. Red -- not quietly vacuous -- if a refresh moves 2O.
    const seatsOf = (below: boolean) =>
      rows.filter((r) => r.belowFloor === below && r.seats !== null).map((r) => r.seats as number);
    expect(Math.max(...seatsOf(true))).toBeGreaterThan(Math.min(...seatsOf(false)));
    // ...and the rank column follows the partition rather than merely counting rows.
    const table = container.querySelectorAll("table.data-table")[1];
    const ranks = [...table.querySelectorAll('[data-testid="rank-cell"]')].map(
      (n) => n.textContent,
    );
    const scored = rows.filter((r) => !r.belowFloor).length;
    expect(ranks.slice(0, scored)).toEqual(Array.from({ length: scored }, (_, i) => String(i + 1)));
    expect(new Set(ranks.slice(scored))).toEqual(new Set(["\u2014"]));
  });

  it("sorts the Top origins table's below-floor rows past a scored row with no stated seats", async () => {
    // THE TEST A COMMENT IN THIS FILE PREVIOUSLY SAID COULD NOT BE WRITTEN. F4's Top origins is
    // 7 rows: three scored, then two below floor holding a stated 0, then two scored whose seats
    // are NULL because every filing in the window was quarantined. `seats DESC` is NULLS LAST, so
    // 0 sorts ABOVE NULL and the sparse rows land at 4 and 5 of 7 -- the orderings disagree
    // without any below-floor row out-seating anything.
    // MUTANT: `partition={false}` at the Top origins DataTable -> red here.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "F4" }) }));
    const rows = rowsOf(container, 2);
    expectContiguousSuffix(rows.map((r) => r.belowFloor));
    // THE FIXTURE GUARD, stated as the mechanism rather than as a restatement: a below-floor row
    // with a stated seat count, and a scored row with none. That pair is exactly what NULLS LAST
    // interleaves, so if a refresh ends it this goes red instead of turning vacuous.
    expect(rows.some((r) => r.belowFloor && r.seats !== null)).toBe(true);
    expect(rows.some((r) => !r.belowFloor && r.seats === null)).toBe(true);
  });
});

/** THE STAT STRIP AND THE FOOT (#121). NO CARRIER's every trailing-12 filing is quarantined on
 * this warehouse (measured), so this page cannot reach the wholly-quarantined clause with real
 * data -- the branch exists, is identical to the one `/route`, `/aircraft` and `/airport` carry,
 * and is driven live on those three. What is reachable here, and asserted below, is the other
 * absence and the quarantine-beside-real-traffic case.
 *
 * The strip is read as an ORDERED LIST, never searched for a dash: under the bug load factor and
 * average gauge rendered `—` anyway, so the buggy page read `0 · 0 · — · — · 0`. */
function statStrip(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".stats .v")].map((n) => n.textContent ?? "");
}

describe("a carrier that filed nothing in the window states absence, not zero", () => {
  // VX has been dormant since 2018-03; 45 of this dataset's carriers are in that state.
  // MUTANT: seed `sumColumn` at 0 -> `["0", "0", "—", "—", "0", "0", "0"]` -> red.
  it("renders the measures as absence while still stating the counts", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "VX" }) }));
    expect(statStrip(container)).toEqual(["—", "—", "—", "—", "—", "0", "0"]);
  });

  // MUTANT: key the clause on `totals.seats === null` alone -> "Every filing by VX in this
  // window is quarantined — 0 rows", naming the one cause it is not -> red.
  it("names neither an exclusion nor quarantine", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "VX" }) }));
    const feet = [...container.querySelectorAll(".foot")].map((n) => n.textContent ?? "").join(" ");
    expect(feet).not.toContain("excluded from these totals");
    expect(feet).not.toContain("is quarantined");
    // The derived-measure disclosure and the two grain claims are not optional, and must
    // survive an empty quarantine clause.
    expect(feet).toContain("never averaged");
  });

  // QUARANTINE BESIDE REAL TRAFFIC, at this dataset's extreme: Wright Air Service filed 118
  // quarantined rows in this window AND stateable traffic on 3 aircraft types. Its figures are
  // honest, its ordinary clause is the true one, and without this the check_nots above could
  // pass against a page that had stopped rendering a strip.
  // MUTANT: key the clause on `quarantinedRowsOnPage > 0` -> the wholly-quarantined sentence
  // appears over real figures -> red.
  it("states real figures and the ordinary exclusion where rows were quarantined", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "8V" }) }));
    const strip = statStrip(container);
    expect(strip.slice(0, 5)).not.toContain("—");
    expect(strip[5]).toBe("3");
    const feet = [...container.querySelectorAll(".foot")].map((n) => n.textContent ?? "").join(" ");
    expect(feet).toContain("118 quarantined rows excluded from these totals");
    expect(feet).not.toContain("is quarantined");
  });
});

describe("the foot's quarantine clause comes from the shared rule, with this page's words", () => {
  // MUTANT: inline a route-local string in place of the `quarantineClause(...)` call -> the spy
  // records nothing -> red. That is the mutant that survived the whole suite before this test.
  // MUTANT: pass `carrier.name` as the subject, or "The carrier count is" as the counts -> the
  // argument assertions redden. A call-count-only test would admit both.
  it("passes its own subject and its own count line", async () => {
    clauseSpy.mockClear();
    render(await CarrierPage({ params: Promise.resolve({ code: "8V" }) }));
    expect(clauseSpy).toHaveBeenCalled();
    const arg = clauseSpy.mock.calls[0][0];
    // "by" and not "at"/"on": a carrier FILES, an airport is filed AT. Each grain's preposition
    // is the page's to supply, and getting it from the wrong page is the drift this pins.
    expect(arg.subject).toBe("by 8V");
    // /carrier's entity count is aircraft types, not carriers -- the one page where it differs.
    expect(arg.counts).toBe("The aircraft-type count is");
    expect(arg.quarantinedRows).toBe(118);
    expect(arg.seatsAreNull).toBe(false);
  });
});

describe("/carrier/<code>: the legend rail follows the CHART, not the rows (#123)", () => {
  // ONE GATE PER CALL SITE, not one per rule. `mixChartDraws` is a single predicate, but each
  // page decides for itself whether to pass it to `<LegendRail>` -- and reverting any ONE of
  // those four call sites to `hasMix` is a live defect on that surface alone. A rule-level test
  // cannot see that: CLAUDE.md's "enumerate the matrix per CALL SITE".
  //
  // DATASET-PINNED SUBJECT. W7 files exactly ONE month, 2019-03, 882 seats.
  //
  // SAY WHY IT RESOLVES, and it is not that the code is unique -- `dim_carrier` holds TWO `W7`
  // airline_ids (20078 Western Pacific, 21944 Nealco d/b/a Watermakers Air). What makes
  // `/carrier/W7` a page rather than the silent-pick refusal is `lookup_carrier_by_code.sql`'s
  // FACT-PRESENCE clause: only one of the two has rows. That is CLAUDE.md's `/carrier/PA` rule
  // read the other way round, and a sentence about a CODE here would be a claim the query never
  // made. DL is the file's standing many-month subject.
  // If this reddens after a BTS refresh, re-derive a one-month subject rather than deleting the
  // test: the carrier with `count(DISTINCT year_month) = 1` in `fct_segment_month`.
  it("renders NO fleet-shading group for a subject whose chart cannot draw", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "W7" }) }));
    const rail = container.querySelector("aside.legend")!;
    expect(rail.textContent).not.toContain("Fleet shading");
    expect(rail.textContent).not.toContain("COVID is in the window on purpose");
    // NOT VACUOUS: the rail is mounted and the chart really did decline to draw. Without these
    // a page that failed to render at all would satisfy both negatives above.
    expect(rail.textContent).toContain("Gauge rail");
    expect(container.querySelector(".chart svg[role='img']")).toBeNull();
  });

  it("DOES render it for a subject whose chart draws", async () => {
    // The positive control. It passes under the bug -- which is exactly why the absence
    // assertion above is the one that catches it -- but without it, deleting the group outright
    // would satisfy every negative in this file.
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    const rail = container.querySelector("aside.legend")!;
    expect(rail.textContent).toContain("Fleet shading");
    expect(container.querySelector(".chart svg[role='img']")).not.toBeNull();
  });
});

/** Drives the page through a raw-query header, the only way this page admits a filter
 *  (`app/src/proxy.ts` + #106) -- the same shape as /aircraft's own `filtered`. */
function filteredCarrier(code: string, rawQuery: string) {
  vi.mocked(headers).mockResolvedValueOnce(new Headers({ [RAW_QUERY_HEADER]: rawQuery }));
  return CarrierPage({ params: Promise.resolve({ code }) });
}

describe("/carrier/<code>: the legend rail's arc group follows the ARCS (#123)", () => {
  // EVERY ROW IN THAT GROUP DESCRIBES AN ARC -- width by seats, dashed below the load-factor
  // floor, dotted-muted below the departure floor, and why a cross-panel arc is a straight line.
  // A map can render with none of them, so "a map was drawn" is the wrong gate: `fetchCarrierTypeNetwork` deliberately returns a map with ZERO
  // segments when every route of a pair is quarantined, so its disclosure reaches the reader --
  // `F4 x SHORT360` is that view, pinned at the producer by `carrierTypeNetwork.test.ts`.
  //
  // Asserted as an ABSENCE, because the presence form passes under the bug. And per CALL SITE:
  // each page decides for itself what to pass, so reverting one is a live defect on that surface
  // alone. Mutant: pass `hasMap` back to `<LegendRail map={...}>` here and this goes red.
  it("renders NO arc-rendering group when no arc was drawn", async () => {
    const { container } = render(await filteredCarrier("F4", "type=SHORT360"));
    const rail = container.querySelector("aside.legend")!;
    expect(rail.textContent).not.toContain("Arc rendering");
    expect(rail.textContent).not.toContain("width scales with seats");
    // NOT VACUOUS, and this is the half that matters: the MAP is still mounted -- dropping the
    // map to satisfy the negative would delete the disclosure this view exists to carry.
    expect(container.querySelector(".map svg[role='img']")).not.toBeNull();
    expect(container.querySelectorAll("polyline").length).toBe(0);
    expect(rail.textContent).toContain("Gauge rail");
  });

  it("DOES render it when arcs were drawn", async () => {
    const { container } = render(await CarrierPage({ params: Promise.resolve({ code: "DL" }) }));
    expect(container.querySelector("aside.legend")!.textContent).toContain("Arc rendering");
    expect(container.querySelectorAll("polyline").length).toBeGreaterThan(0);
  });

  it("DOES render it when only the TYPE MAP draws, and the diff map has no panel", async () => {
    // WHICH HALF OF THE DISJUNCTION REFUSES THIS FIXTURE. `arcsDrawn` on this page is
    // `typeMap draws || any diff panel draws`, and every other fixture here sits where the
    // first half cannot be the reason: `F4 x SHORT360` has BOTH halves false, and an unfiltered
    // `DL` has `typeMap === null`, so only the diff half can ever be true. Delete the type-map
    // disjunct entirely and all of them stay green -- the guard is deletable, which is CLAUDE.md's
    // "assert WHICH check refuses a fixture, not that something did".
    //
    // WHAT THIS FIXTURE VARIES: a carrier with ZERO diff panels whose filtered type map
    // nonetheless draws real arcs -- the one combination that isolates the first disjunct. F4
    // has no diff panel at all (measured), and `F4 x ISLANDER` draws 3 polylines. Seven
    // fact-present carriers have no diff panel and eight (carrier, type) views on them draw from
    // the type map alone, so this is a served shape, not a constructed one.
    //
    // Mutant: drop `typeMap !== null && segmentArcsDrawn(typeMap)` from `arcsDrawn` and this
    // goes red -- a page full of arcs with no group explaining them, #123's defect inverted.
    const { container } = render(await filteredCarrier("F4", "type=ISLANDER"));
    expect(container.querySelectorAll('[data-testid="diff-panel"]').length).toBe(0);
    expect(container.querySelectorAll("polyline").length).toBeGreaterThan(0);
    expect(container.querySelector("aside.legend")!.textContent).toContain("Arc rendering");
  });
});
