// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DimensionChips } from "@/components/builder/DimensionChips";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";

function q(over: Partial<PivotQuery> = {}): PivotQuery {
  return normalizeQuery({
    grain: "segment", dimensions: ["op_airline_id"], measures: ["seats"],
    timeFrom: "2015-01", timeTo: "2015-12", filters: [], sort: null,
    sortDesc: true, limit: 100, grouping: "operating", ...over,
  });
}
const texts = (c: Element, sel: string) => [...c.querySelectorAll(sel)].map((n) => n.textContent);

describe("DimensionChips", () => {
  it("renders the catalog vocabulary, not a hand-written list", () => {
    const { container } = render(<DimensionChips query={q()} allowlist={FIXTURE} />);
    // 14 groupable of 15 catalog rows: endpoint_airport_id is filter_only.
    expect(container.querySelectorAll(".chip").length).toBe(14);
    expect(texts(container, ".chip")).not.toContain("Airport (either end)");
  });

  it("marks the selected dimensions and links the rest", () => {
    // The chip row is rendered in CATALOG order (FIXTURE / 300_meta_pivot_dimensions.sql),
    // never in query.dimensions (selection) order -- that is what lets the href-ordering test
    // below be the only one sensitive to a reversed toggleDimension. The catalog lists `year`
    // before `op_airline_id`, so that is the DOM order of the two aria-current chips here,
    // independent of the order the caller passed them in `dimensions`.
    const { container } = render(<DimensionChips query={q({ dimensions: ["op_airline_id", "year"] })} allowlist={FIXTURE} />);
    expect(texts(container, '[aria-current="page"]')).toEqual(["Year", "Carrier"]);
  });

  it("renders a segment-only dimension inert at route grain, with its reason", () => {
    // dimensions has TWO entries so the grain refusal is the only reason any chip is inert --
    // with one, the last-dimension refusal adds a sixth and the assertion below is about two
    // different rules at once.
    const { container } = render(<DimensionChips query={q({ grain: "route", dimensions: ["route", "year"] })} allowlist={FIXTURE} />);
    const off = [...container.querySelectorAll(".chip-off")];
    expect(off.map((n) => n.textContent).sort()).toEqual(
      ["Aircraft group", "Aircraft type", "Dest state", "Distance group", "Origin state"],
    );
    expect(off[0].getAttribute("title")).toContain("route grain");
  });

  it("renders the last remaining dimension inert, because removing it is a server rejection", () => {
    const { container } = render(<DimensionChips query={q({ dimensions: ["op_airline_id"] })} allowlist={FIXTURE} />);
    const carrier = [...container.querySelectorAll(".chip")].find((n) => n.textContent === "Carrier")!;
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier.getAttribute("title")).toContain("at least one");
  });

  it("preserves selection ORDER, because d is an ordered list and the table follows it", () => {
    // A set-based assertion passes under a reversed implementation; this is a geometry claim.
    const { container } = render(<DimensionChips query={q({ dimensions: ["year", "op_airline_id"] })} allowlist={FIXTURE} />);
    const add = [...container.querySelectorAll("a.chip")].find((n) => n.textContent === "Origin")!;
    expect(add.getAttribute("href")).toContain("d=year,op_airline_id,origin_airport_id");
  });
});
