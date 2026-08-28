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

    // THE HALF THAT MAKES THIS TEST'S OWN TITLE TRUE. A count plus an absence is satisfied by a
    // hardcoded array of the same 14 labels -- the exact bug the title forbids -- because a
    // hand-written list is precisely as long as the catalog it was copied from. Only a catalog
    // the hand-written version could not have known about discriminates. FIXTURE is a shared
    // module singleton, so this CLONES rather than mutates; a mutated fixture would leak into
    // every other test in the run.
    const widened = { ...FIXTURE, dims: new Map(FIXTURE.dims) };
    widened.dims.set("synthetic_dim", {
      key: "synthetic_dim", label: "Synthetic dim", columnExpr: "synthetic_dim", grain: "both",
      joinDim: null, joinKey: null, filterOnly: false, filterMode: null, valueType: "VARCHAR",
    });
    const grown = render(<DimensionChips query={q()} allowlist={widened} />);
    expect(grown.container.querySelectorAll(".chip").length).toBe(15);
    expect(texts(grown.container, ".chip")).toContain("Synthetic dim");
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
    // Fix round 2, Finding 3: the inert reason is now ALSO stated in visually-hidden text
    // (Chips.tsx), so textContent carries the label plus that reason -- not the bare label. The
    // reason string is identical for every grain-refused dimension, so appending it to each
    // expected label preserves the same sort order this test already relied on.
    expect(off.map((n) => n.textContent).sort()).toEqual(
      ["Aircraft group", "Aircraft type", "Dest state", "Distance group", "Origin state"].map(
        (label) => `${label} (not filed at route grain)`,
      ),
    );
    expect(off[0].getAttribute("title")).toContain("route grain");
  });

  it("renders the last remaining dimension inert, because removing it is a server rejection", () => {
    const { container } = render(<DimensionChips query={q({ dimensions: ["op_airline_id"] })} allowlist={FIXTURE} />);
    // Fix round 2, Finding 3: an inert chip's textContent now also carries its visually-hidden
    // reason (Chips.tsx), so this matches on the label prefix rather than exact equality.
    const carrier = [...container.querySelectorAll(".chip")].find((n) =>
      n.textContent?.startsWith("Carrier"),
    )!;
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
