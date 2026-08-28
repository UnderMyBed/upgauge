// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterChips } from "@/components/builder/FilterChips";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";
import { loadAllowlist, runPivot } from "@/lib/db";
import { decodeRequest } from "@/lib/pivot/bounds";

function q(over: Partial<PivotQuery> = {}): PivotQuery {
  return normalizeQuery({
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats"],
    timeFrom: "2015-01",
    timeTo: "2015-12",
    filters: [],
    sort: null,
    sortDesc: true,
    limit: 100,
    grouping: "operating",
    ...over,
  });
}

/**
 * The resolver payload as `runPivot` ACTUALLY emits it, never hand-built.
 *
 * A hand-built map is keyed the way the reader of this component would guess -- by dimension key
 * -- and `resolveRows` keys by FACT COLUMN. That fixture passed while the shipped page rendered
 * `Carrier = 19790`, `Route = 12478-12892` and `Airport (either end) = 12892`, which is the exact
 * shape review found. So every display assertion below runs a real pivot and uses its own map;
 * the structural assertions (counts, hrefs) stay on the catalog fixture, where no resolver is
 * involved.
 */
async function realResult(rawQuery: string) {
  const allowlist = await loadAllowlist();
  const query = decodeRequest(rawQuery, allowlist);
  const { resolved } = await runPivot(query);
  return { allowlist, query, resolved };
}

function hrefs(container: HTMLElement, selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((n) => n.getAttribute("href") ?? "");
}

describe("FilterChips", () => {
  // AGAINST A REAL PIVOT RESULT. `runPivot`'s map is keyed by fact column, so a dimension-keyed
  // lookup misses and `displayValue` falls back to the raw id -- which is what shipped.
  it("renders an active filter with its RESOLVED display value, not the raw id", async () => {
    const { allowlist, query, resolved } = await realResult(
      "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&f=op_airline_id:19790&s=-seats&n=25&g=op",
    );
    const { container } = render(
      <FilterChips query={query} allowlist={allowlist} resolved={resolved} />,
    );
    expect(container.querySelector(".chip")!.textContent).toContain("DL");
    expect(container.querySelector(".chip")!.textContent).not.toContain("19790");
  });

  // `route`'s value is COMPOSITE and its two halves resolve under `route_key_low`/`route_key_high`
  // -- there is no `route` key in the map at all, so this is the case a dimension-keyed lookup
  // can never get right. 12478-12892 is JFK-LAX.
  it("renders a composite filter as its two resolved codes", async () => {
    const { allowlist, query, resolved } = await realResult(
      "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&f=route:12478-12892&s=-seats&n=25&g=op",
    );
    const { container } = render(
      <FilterChips query={query} allowlist={allowlist} resolved={resolved} />,
    );
    const label = container.querySelector(".chip")!.textContent!;
    expect(label).toContain("JFK\u2013LAX");
    expect(label).not.toContain("12478");
  });

  // `endpoint_airport_id` names TWO columns and its value is ONE id sitting in either of them,
  // so the lookup has to try both. 12892 is LAX; the pivot groups by origin, so the hit is under
  // `origin_airport_id` and a `dest_airport_id`-only lookup would miss it.
  it("renders an either-end filter from whichever column carries the id", async () => {
    const { allowlist, query, resolved } = await realResult(
      "v=1&k=seg&d=origin_airport_id&m=seats&t=2025-05:2026-04&f=endpoint_airport_id:12892&s=-seats&n=25&g=op",
    );
    const { container } = render(
      <FilterChips query={query} allowlist={allowlist} resolved={resolved} />,
    );
    const label = container.querySelector(".chip")!.textContent!;
    expect(label).toContain("LAX");
    expect(label).not.toContain("12892");
  });

  // THE HALF THE KEYING FIX CANNOT REACH, pinned so it is a known degradation rather than a
  // surprise. `runPivot` resolves only ids present in its ROWS, so filtering on a dimension you
  // do not group by resolves nothing -- measured here as `resolved.size === 0`. The chip must
  // then show the raw id, never a dash: absence of a NAME is not absence of DATA. The page that
  // mounts this component has to resolve its filter values itself (see the component docstring).
  it("falls back to the raw id when the filtered dimension is not also grouped", async () => {
    const { allowlist, query, resolved } = await realResult(
      "v=1&k=seg&d=year_month&m=seats&t=2025-05:2026-04&f=op_airline_id:19790&s=-seats&n=25&g=op",
    );
    expect(resolved.size).toBe(0);
    const { container } = render(
      <FilterChips query={query} allowlist={allowlist} resolved={resolved} />,
    );
    const label = container.querySelector(".chip")!.textContent!;
    expect(label).toContain("19790");
    expect(label).not.toContain("—");
  });

  it("an active filter's link REMOVES it", () => {
    const { container } = render(
      <FilterChips
        query={q({ filters: [["op_airline_id", ["19790"]]] })}
        allowlist={FIXTURE}
        resolved={new Map()}
      />,
    );
    expect(container.querySelector("a.chip")!.getAttribute("href")).not.toContain(
      "f=op_airline_id",
    );
  });

  // The discriminating case for `removeFilterValue`: dropping the whole `f` chunk passes the
  // single-value test above and is wrong here. Two values on ONE key, and each chip must remove
  // only its own -- so the href still carries the key, carrying the OTHER value.
  it("removes ONE value of a two-value filter, not the whole key", () => {
    const { container } = render(
      <FilterChips
        query={q({ filters: [["op_airline_id", ["19790", "19393"]]] })}
        allowlist={FIXTURE}
        resolved={new Map()}
      />,
    );
    // The FIRST `.chip-row` is the active-filter half; the second is inside `.filter-list`.
    const active = container.querySelectorAll(".chip-row")[0] as HTMLElement;
    const [first, second] = hrefs(active, "a.chip");
    expect(first).toContain("f=op_airline_id:19393");
    expect(first).not.toContain("19790");
    expect(second).toContain("f=op_airline_id:19790");
    expect(second).not.toContain("19393");
  });

  it("says so when nothing is filtered, rather than rendering an empty row", () => {
    const { container } = render(
      <FilterChips query={q()} allowlist={FIXTURE} resolved={new Map()} />,
    );
    expect(container.querySelector(".chip-off")!.textContent).toBe("none");
  });

  it("offers a value list for every filterable dimension, including the filter_only one", () => {
    const { container } = render(
      <FilterChips query={q()} allowlist={FIXTURE} resolved={new Map()} />,
    );
    const list = hrefs(container, ".filter-list a");
    expect(list.some((h) => h.startsWith("/explore/filter/endpoint_airport_id?"))).toBe(true);
    expect(list.length).toBe(15);
  });

  it("omits segment-only dimensions from the value lists at route grain", () => {
    const { container } = render(
      <FilterChips
        query={q({ grain: "route", dimensions: ["route"] })}
        allowlist={FIXTURE}
        resolved={new Map()}
      />,
    );
    const list = hrefs(container, ".filter-list a");
    expect(list.length).toBe(10);
    expect(list.some((h) => h.includes("aircraft_type"))).toBe(false);
  });

  it("carries the current query into the value-list href, so the list scopes to this window", () => {
    const { container } = render(
      <FilterChips
        query={q({ timeFrom: "2025-05", timeTo: "2026-04" })}
        allowlist={FIXTURE}
        resolved={new Map()}
      />,
    );
    expect(container.querySelector(".filter-list a")!.getAttribute("href")).toContain(
      "t=2025-05:2026-04",
    );
  });

  // The value-list href must carry the query the reader is LOOKING at, including its filters --
  // otherwise the list ranks values against a query nobody asked for. The grain is asserted
  // beside the filter because a `filterListHref` built from a spread of a DEFAULT query would
  // still carry `k=route` and get that half right by accident.
  it("carries the active filters into the value-list href too", () => {
    const { container } = render(
      <FilterChips
        query={q({ grain: "route", dimensions: ["route"], filters: [["op_airline_id", ["19790"]]] })}
        allowlist={FIXTURE}
        resolved={new Map()}
      />,
    );
    const href = container.querySelector(".filter-list a")!.getAttribute("href")!;
    expect(href).toContain("f=op_airline_id:19790");
    expect(href).toContain("k=route");
  });
});
