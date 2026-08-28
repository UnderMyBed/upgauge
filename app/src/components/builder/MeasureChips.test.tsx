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

    // A COUNT ALONE CANNOT SEE THE BUG THIS TEST IS NAMED FOR: a hardcoded array of the same
    // twelve measures is exactly twelve long. Rendering a catalog the hand-written version could
    // not have known about is the only assertion that separates them. Cloned, never mutated --
    // FIXTURE is a shared module singleton.
    const widened = { ...FIXTURE, meas: new Map(FIXTURE.meas) };
    widened.meas.set("synthetic_measure", {
      key: "synthetic_measure", label: "Synthetic measure", isAdditive: true,
      expr: "SUM(synthetic) FILTER (WHERE NOT is_quarantined)",
    });
    const grown = render(<MeasureChips query={q()} allowlist={widened} />);
    expect(grown.container.querySelectorAll(".chip").length).toBe(13);
    expect(
      [...grown.container.querySelectorAll(".chip")].map((n) => n.textContent),
    ).toContain("Synthetic measure");
  });

  it("marks a derived measure as derived and an additive one as not", () => {
    const { container } = render(<MeasureChips query={q()} allowlist={FIXTURE} />);
    // Fix round 2, Finding 3: "Seats" is the sole selected measure in this fixture, so it is the
    // last-remaining-measure INERT chip -- its textContent now also carries the visually-hidden
    // reason (Chips.tsx), so this matches on the label prefix rather than exact equality. "Load
    // factor" stays a plain toggle-on link, exact-matched as before.
    const chip = (label: string) =>
      [...container.querySelectorAll(".chip")].find((n) => n.textContent?.startsWith(label))!;
    expect(chip("Load factor").className).toContain("chip-derived");
    expect(chip("Seats").className).not.toContain("chip-derived");
  });

  it("renders the last remaining measure inert", () => {
    const { container } = render(<MeasureChips query={q({ measures: ["seats"] })} allowlist={FIXTURE} />);
    const seats = [...container.querySelectorAll(".chip")].find((n) =>
      n.textContent?.startsWith("Seats"),
    )!;
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
