// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  FilterListView,
  FILTER_VALUE_LIMIT,
  readValue,
  renderSource,
  valueSources,
} from "@/app/explore/filter/[dim]/page";
import { loadAllowlist, runPivot } from "@/lib/db";
import { decodeRequest } from "@/lib/pivot/bounds";
import { formatSeats } from "@/lib/format";
import { filterableDimensions } from "@/lib/pivot/builder";
import type { Resolved } from "@/lib/resolve";
import { resolutionKey } from "@/lib/resolve";

/** Renders against the REAL database, this codebase's usual integration-test style (db.test.ts,
 * watch/[preset]/page.test.tsx, carrier/[code]/page.test.tsx all query real data rather than
 * mock it). `vitest.config.ts` sets UPGAUGE_ROOT to the repo root, so the same `upgauge.duckdb`
 * the server reads is the one under test.
 *
 * NOT `FilterListPage`: that wrapper's only job is `headers()`, which has no request scope in a
 * test. `ExploreView` is split from `ExplorePage` for the identical reason, and its own comment
 * states it -- the tests cross the real permalink boundary with a real raw string. */
const SEGMENT = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op";
const ROUTE = "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op";

async function renderList(dim: string, rawQuery = SEGMENT) {
  return render(await FilterListView({ rawQuery, dim }));
}

/** `notFound()` throws rather than returning -- same helper, same reasoning, as
 * watch/[preset]/page.test.tsx's `catchDigest`. */
async function catchDigest(dim: string, rawQuery = SEGMENT): Promise<string> {
  try {
    await FilterListView({ rawQuery, dim });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`FilterListView(${JSON.stringify(dim)}) did not throw`);
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll(".mp-list li")] as HTMLElement[];
}

describe("/explore/filter/[dim]", () => {
  it("lists values as anchors that ADD the filter and return to /explore", async () => {
    const { container } = await renderList("op_airline_id");
    const first = container.querySelector(".mp-list a")!;
    expect(first.getAttribute("href")).toMatch(/^\/explore\?/);
    expect(first.getAttribute("href")).toContain("f=op_airline_id:");
  });

  // The BTS id is the filter value and the code is the display, and they must not be swapped:
  // `dim_carrier` carries the CURRENT carrier code, so a code-valued filter silently changes
  // meaning across a rebuild (CLAUDE.md). DL is the largest carrier by seats in this window.
  it("shows the resolved code and filters on the id", async () => {
    // WN (19393, 223,049,191 seats) is the largest carrier over 2025-05..2026-04 -- measured.
    const { container } = await renderList("op_airline_id");
    const first = container.querySelector(".mp-list a")!;
    expect(first.textContent).toContain("WN");
    expect(first.textContent).not.toContain("19393");
    expect(first.getAttribute("href")).toContain("f=op_airline_id:19393");
  });

  it("states 'quarantined' rather than a seat total for a wholly-quarantined value", async () => {
    // NULL is absence, zero is a measurement. `?? 0` here would claim a value flew nothing.
    // Aircraft types 489 and 201 are the LIVE instances over 2025-05..2026-04: 5 and 2 filed
    // rows respectively, every one of them quarantined (`zero_seats`), so
    // `SUM(seats) FILTER (WHERE NOT is_quarantined)` is NULL, not 0. Re-derive against the
    // warehouse if this goes red -- a replacement value that is not wholly quarantined passes
    // against the very bug this test exists to catch.
    const { container } = await renderList("aircraft_type");
    const absent = rows(container).filter((r) => r.textContent!.includes("quarantined"));
    expect(absent.length).toBeGreaterThan(0);
    // The row must not ALSO carry a figure -- "quarantined 0" would be the same lie with a word
    // in front of it. `.mp-seats` is the only place a figure is rendered.
    for (const row of absent) {
      expect(row.querySelector(".mp-seats")!.textContent).toBe("quarantined");
    }
    // 76 distinct types in this window, under the limit, so both NULL rows are on the page.
    expect(absent.length).toBe(2);
  });

  // The discriminator for the `filters` line of `listQuery`: a list scoped by its OWN filter
  // shows exactly the value already chosen, which is not a list. The OTHER filter must survive.
  it("drops the filter on the listed dimension and keeps the others", async () => {
    const scoped = `v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&f=op_airline_id:19790&f=origin_state:HI&s=-seats&n=25&g=op`;
    const { container } = await renderList("op_airline_id", scoped);
    const texts = rows(container).map((r) => r.textContent!);
    // Keeping `f=op_airline_id` in the list query leaves exactly one row -- DL, the value already
    // chosen. HA leads Hawaii-origin seats in this window (19690, 6,660,459) and DL does not
    // appear in that top three at all, so its presence here is the whole discriminator.
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.some((t) => t.startsWith("HA"))).toBe(true);
    // The OTHER filter survives into every href, so the list is still the Hawaii-scoped one.
    const hrefs = [...container.querySelectorAll(".mp-list a")].map((a) => a.getAttribute("href")!);
    expect(hrefs.every((h) => h.includes("f=origin_state:HI"))).toBe(true);
    // The value already applied is marked and removes itself, never offered as a no-op add.
    const current = container.querySelector('.mp-list a[aria-current="page"]')!;
    expect(current.textContent).toContain("DL");
    expect(current.getAttribute("href")).not.toContain("f=op_airline_id");
    expect(current.getAttribute("href")).toContain("f=origin_state:HI");
  });

  it("scopes the list to the query's own window", async () => {
    // 2015 carries carriers this dataset's trailing 12 months do not -- Virgin America (VX,
    // 21167) last filed 2018-03 (sitemap.ts's own dormant-carrier fixture). A list that ignored
    // `t` would rank the current window and never show it.
    const old = "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&s=-seats&n=25&g=op";
    const { container } = await renderList("op_airline_id", old);
    const hrefs = [...container.querySelectorAll(".mp-list a")].map((a) => a.getAttribute("href")!);
    expect(hrefs.some((h) => h.includes("f=op_airline_id:21167"))).toBe(true);
    const now = await renderList("op_airline_id");
    const nowHrefs = [...now.container.querySelectorAll(".mp-list a")].map(
      (a) => a.getAttribute("href")!,
    );
    expect(nowHrefs.some((h) => h.includes("f=op_airline_id:21167"))).toBe(false);
  });

  // THE ASSERTION WHOSE ABSENCE SHIPPED A 25.7%-WRONG PAGE. Both original fixtures were `g=op`,
  // where the mainline rollup and the raw column agree, so nothing could see it. Under `g=ml`
  // `renderPivot` GROUP BYs `coalesce(m.parent_airline_id, f.op_airline_id)` while the `f` clause
  // it builds targets the RAW `op_airline_id` (sql/03_queries/pivot_mainline_join.sql documents
  // that gap) -- so spreading `...query` displayed AS at 62,663,219 seats and linked to a query
  // returning 46,551,806, with HA (8,861,773) and QX/Horizon (7,249,640) folded into the figure
  // and dropped by the link. NOT VX -- Virgin America last filed 2018-03 and files zero seats in
  // this window, so it cannot be in the 16,111,413-seat gap however plausible the name looks.
  //
  // The check is not "the figure looks right": it FOLLOWS the emitted href and re-runs it. A
  // hardcoded expected number would rot with the next BTS refresh and would not test the
  // relationship that actually broke.
  it("under g=ml, every listed figure equals what its own link returns", async () => {
    const ML = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=ml";
    const { container } = await renderList("op_airline_id", ML);
    const allowlist = await loadAllowlist();
    const anchors = [...container.querySelectorAll(".mp-list a")].slice(0, 5);
    expect(anchors.length).toBe(5);
    for (const anchor of anchors) {
      const shown = anchor.querySelector(".mp-seats")!.textContent!;
      const target = anchor.getAttribute("href")!.split("?")[1];
      const result = await runPivot(decodeRequest(target, allowlist));
      const returned = result.rows.reduce((a, r) => a + Number(r.seats ?? 0), 0);
      expect(shown, `listed figure for ${anchor.textContent}`).toBe(formatSeats(returned));
    }
  });

  it("says so when the query is mainline-grouped but the list is not", async () => {
    const ML = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=ml";
    const { container } = await renderList("op_airline_id", ML);
    expect(container.textContent).toContain("Listed by operating carrier as filed");
    // And NOT on an operating-grouped query, or the note is decoration rather than a disclosure.
    const op = await renderList("op_airline_id");
    expect(op.container.textContent).not.toContain("Listed by operating carrier as filed");
  });

  // THE SECOND OPERAND. The test above varies only the GROUPING, so it passes just as well
  // against a gate keyed on `g=ml` alone -- which is what shipped, and which printed "Listed by
  // operating carrier as filed" on a list of AIRFRAMES. `g=ml` rewrites the carrier column and
  // nothing else, so an aircraft_type list is byte-identical under both groupings and the
  // sentence describes nothing on the page. Asserted alongside a positive check that the list
  // really rendered, so a 404 or an empty page cannot satisfy the absence vacuously.
  it("says nothing about operating carriers on a mainline-grouped list that has none", async () => {
    const ML = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=ml";
    const { container } = await renderList("aircraft_type", ML);
    expect(container.querySelectorAll(".mp-list a").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Listed by operating carrier as filed");
  });

  // The either-end dimension is enumerated through origin/dest AIRPORT, so it carries no
  // carriers either -- and its slug is not `op_airline_id`, which is why the gate reads the
  // RENDERED sources rather than the slug.
  it("says nothing about operating carriers on a mainline-grouped either-end list", async () => {
    const ML = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=ml";
    const { container } = await renderList("endpoint_airport_id", ML);
    expect(container.querySelectorAll(".mp-list a").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Listed by operating carrier as filed");
  });

  it("renders a composite dimension as a resolved pair and filters on <low>-<high>", async () => {
    const { container } = await renderList("route", ROUTE);
    const first = container.querySelector(".mp-list a")!;
    expect(first.textContent).toMatch(/^[A-Z0-9]{3}–[A-Z0-9]{3}/);
    expect(first.getAttribute("href")).toMatch(/f=route:\d+-\d+/);
  });

  it("says the list is truncated when it is, and only then", async () => {
    // 742 origins in this window against a limit of 100 -- truncated. 70 carriers -- not.
    const many = await renderList("origin_airport_id");
    expect(rows(many.container).length).toBe(FILTER_VALUE_LIMIT);
    expect(many.container.querySelector(".mp-note")).not.toBeNull();
    const few = await renderList("op_airline_id");
    expect(rows(few.container).length).toBeLessThan(FILTER_VALUE_LIMIT);
    expect(few.container.querySelector(".mp-note")).toBeNull();
  });

  // THE EXACTLY-AT-LIMIT CASE. `result.rows.length === limit` cannot distinguish "the largest
  // `limit` by seats, not every value" from "every value, and there are exactly `limit` of them"
  // -- a dimension with exactly `limit` distinct values would still claim to be a partial list,
  // which is false. No real dimension in this warehouse happens to carry exactly
  // FILTER_VALUE_LIMIT (100) values, so this drives the boundary by lowering the effective limit
  // to a count the live data actually reaches, via `renderSource`'s own `limit` parameter --
  // self-measuring against `op_airline_id`'s TRUE distinct count for this window, so the test does
  // not rot the next time the warehouse's carrier count changes.
  it("pins the exactly-at-limit boundary: truncated is false at the true count, true one below it", async () => {
    const allowlist = await loadAllowlist();
    const query = decodeRequest(SEGMENT, allowlist);
    const entry = filterableDimensions(allowlist, query.grain).find(
      (e) => e.key === "op_airline_id",
    )!;
    const { sources } = valueSources(entry, allowlist);

    // A limit far above any real count establishes the TRUE total -- and pins that op_airline_id
    // is not itself truncated at 1000, which the boundary checks below assume.
    const full = await renderSource(query, entry, sources[0], null, 1000);
    expect(full.truncated).toBe(false);
    const total = full.values.length;
    expect(total).toBeGreaterThan(1);

    // Every value fits exactly -- there is no row beyond what's shown, so this must NOT claim to
    // be a partial list. This is the exact case the review finding names: the buggy
    // `rows.length === limit` form reports `true` here, since the query itself was limited to
    // `limit` rows and got back exactly that many.
    const atLimit = await renderSource(query, entry, sources[0], null, total);
    expect(atLimit.values.length).toBe(total);
    expect(atLimit.truncated).toBe(false);

    // One under the true count -- a real row exists beyond the shown page, so this MUST claim to
    // be a partial list.
    const belowLimit = await renderSource(query, entry, sources[0], null, total - 1);
    expect(belowLimit.values.length).toBe(total - 1);
    expect(belowLimit.truncated).toBe(true);
  });

  // `endpoint_airport_id` is `filter_only`: `renderPivot` refuses it as a grouping key, so a
  // one-dimension pivot on itself is a PivotError and a 500 under an hour of shared cache.
  it("lists the filter-only dimension from BOTH ends, without summing them", async () => {
    const { container } = await renderList("endpoint_airport_id");
    const legends = [...container.querySelectorAll(".mp-legend")].map((n) => n.textContent);
    expect(legends).toContain("Origin");
    expect(legends).toContain("Destination");
    expect(container.querySelectorAll(".mp-list").length).toBe(2);
    // Every anchor writes the EITHER-END filter, whichever end its list came from.
    const hrefs = [...container.querySelectorAll(".mp-list a")].map((a) => a.getAttribute("href")!);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((h) => h.includes("f=endpoint_airport_id:"))).toBe(true);
    expect(container.textContent).toContain("either end");
    expect(container.querySelector(".mp-refusal")).toBeNull();
  });

  it("404s an unknown dimension", async () => {
    expect(await catchDigest("not_a_dimension")).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  // A DIFFERENT finding from the one above, and the fixture has to differ too: `aircraft_type`
  // IS filterable at segment grain, so the same slug against the SEGMENT permalink renders. Only
  // the route-grain permalink makes this 404, which is what stops this from being test 1 again.
  it("404s a real dimension that is not filed at this grain", async () => {
    expect(await catchDigest("aircraft_type", ROUTE)).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
    const { container } = await renderList("aircraft_type");
    expect(container.querySelectorAll(".mp-list li").length).toBeGreaterThan(0);
  });

  it("renders a named refusal, not a 404 and not a 500, when the permalink is unreadable", async () => {
    const { container } = await renderList("op_airline_id", "v=1&k=seg&d=junk&m=seats&t=2025-05:2026-04&n=5&g=op");
    expect(container.textContent).toContain("unknown dimension");
    expect(container.querySelector(".mp-list")).toBeNull();
  });
});

describe("valueSources", () => {
  it("maps every filter-only dimension in the LIVE catalog to a groupable source per column", async () => {
    // The exhaustiveness gate, in `RESOLVER_FILE`'s idiom: a filter-only dimension nobody wired
    // a source for would silently render a shorter page with every other test still green.
    const allowlist = await loadAllowlist();
    const filterOnly = [...allowlist.dims.values()].filter((e) => e.filterOnly);
    expect(filterOnly.length).toBeGreaterThan(0);
    for (const entry of filterOnly) {
      const { sources, unlistable } = valueSources(entry, allowlist);
      expect(unlistable).toEqual([]);
      expect(sources.length).toBe(entry.columnExpr.split(",").length);
    }
  });

  it("enumerates every OTHER filterable dimension from itself, at both grains", async () => {
    const allowlist = await loadAllowlist();
    for (const grain of ["segment", "route"]) {
      for (const entry of filterableDimensions(allowlist, grain)) {
        if (entry.filterOnly) continue;
        const { sources, unlistable } = valueSources(entry, allowlist);
        expect(unlistable).toEqual([]);
        expect(sources.map((s) => s.key)).toEqual([entry.key]);
      }
    }
  });
});

describe("readValue", () => {
  const CARRIER = {
    key: "op_airline_id",
    label: "Carrier",
    columnExpr: "op_airline_id",
    grain: "both",
    joinDim: "dim_carrier",
    joinKey: "airline_id",
    filterOnly: false,
    filterMode: null,
    valueType: "INTEGER",
  } as const;

  // NULL is absence: `x IN (NULL)` matches nothing, so there is no filter to write and the page
  // must not emit `f=op_airline_id:null`. No dimension carries a NULL in the current warehouse,
  // which is a point-in-time fact rather than an invariant -- hence a direct test of the guard.
  it("refuses a row whose dimension value is NULL rather than stringifying it", () => {
    expect(readValue(CARRIER, { op_airline_id: null, seats: 1 }, new Map())).toBeNull();
  });

  it("falls back to the raw id when the resolver had no row for it", () => {
    expect(readValue(CARRIER, { op_airline_id: 19790 }, new Map())).toEqual({
      value: "19790",
      display: "19790",
    });
  });

  it("shows the resolved code while keeping the id as the filter value", () => {
    const resolved = new Map<string, Resolved>([
      [resolutionKey("op_airline_id", 19790), { code: "DL", name: "Delta Air Lines Inc." }],
    ]);
    expect(readValue(CARRIER, { op_airline_id: 19790 }, resolved)).toEqual({
      value: "19790",
      display: "DL",
    });
  });
});
