// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MeasureChips } from "@/components/builder/MeasureChips";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";

function q(over: Partial<PivotQuery> = {}): PivotQuery {
  return normalizeQuery({
    grain: "segment", dimensions: ["op_airline_id"], measures: ["seats"],
    timeFrom: "2015-01", timeTo: "2015-12", filters: [], sort: null,
    sortDesc: true, limit: 100, grouping: "operating", ...over,
  });
}

describe("MeasureChips", () => {
  it("renders all twelve catalog measures", () => {
    const { container } = render(<MeasureChips query={q()} allowlist={FIXTURE} />);
    expect(container.querySelectorAll(".chip").length).toBe(12);
  });

  it("marks a derived measure as derived and an additive one as not", () => {
    const { container } = render(<MeasureChips query={q()} allowlist={FIXTURE} />);
    const chip = (label: string) => [...container.querySelectorAll(".chip")].find((n) => n.textContent === label)!;
    expect(chip("Load factor").className).toContain("chip-derived");
    expect(chip("Seats").className).not.toContain("chip-derived");
  });

  it("renders the last remaining measure inert", () => {
    const { container } = render(<MeasureChips query={q({ measures: ["seats"] })} allowlist={FIXTURE} />);
    const seats = [...container.querySelectorAll(".chip")].find((n) => n.textContent === "Seats")!;
    expect(seats.tagName).toBe("SPAN");
    expect(seats.getAttribute("title")).toContain("at least one");
  });

  it("the link that removes the sorted measure already carries the re-pointed sort", () => {
    const { container } = render(
      <MeasureChips query={q({ measures: ["seats", "passengers"], sort: "seats" })} allowlist={FIXTURE} />,
    );
    const seats = [...container.querySelectorAll("a.chip")].find((n) => n.textContent === "Seats")!;
    expect(seats.getAttribute("href")).toContain("s=-passengers");
  });
});
