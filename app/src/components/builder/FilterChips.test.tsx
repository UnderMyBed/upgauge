// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterChips } from "@/components/builder/FilterChips";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";
import type { Resolved } from "@/lib/resolve";
import { resolutionKey } from "@/lib/resolve";

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

const RESOLVED = new Map<string, Resolved>([
  [resolutionKey("op_airline_id", "19790"), { code: "DL", name: "Delta Air Lines Inc." }],
  [resolutionKey("op_airline_id", "19393"), { code: "WN", name: "Southwest Airlines Co." }],
]);

function hrefs(container: HTMLElement, selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((n) => n.getAttribute("href") ?? "");
}

describe("FilterChips", () => {
  it("renders an active filter with its RESOLVED display value, not the raw id", () => {
    const { container } = render(
      <FilterChips
        query={q({ filters: [["op_airline_id", ["19790"]]] })}
        allowlist={FIXTURE}
        resolved={RESOLVED}
      />,
    );
    expect(container.querySelector(".chip")!.textContent).toContain("DL");
    expect(container.querySelector(".chip")!.textContent).not.toContain("19790");
  });

  it("an active filter's link REMOVES it", () => {
    const { container } = render(
      <FilterChips
        query={q({ filters: [["op_airline_id", ["19790"]]] })}
        allowlist={FIXTURE}
        resolved={RESOLVED}
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
        resolved={RESOLVED}
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
        resolved={RESOLVED}
      />,
    );
    const href = container.querySelector(".filter-list a")!.getAttribute("href")!;
    expect(href).toContain("f=op_airline_id:19790");
    expect(href).toContain("k=route");
  });
});
