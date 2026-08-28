// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SortControl } from "@/components/builder/SortControl";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";

function q(over: Partial<PivotQuery> = {}): PivotQuery {
  return normalizeQuery({
    grain: "segment",
    dimensions: ["aircraft_type"],
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

describe("SortControl", () => {
  it("does not offer a composite dimension, which render.ts cannot sort on", () => {
    const { container } = render(
      <SortControl
        query={q({ grain: "route", dimensions: ["route", "year"], measures: ["seats"] })}
        allowlist={FIXTURE}
      />,
    );
    expect([...container.querySelectorAll(".chip")].map((c) => c.textContent?.trim())).toEqual([
      "Year",
      "Seats",
    ]);
  });

  it("offers every selected column and no unselected one", () => {
    const { container } = render(
      <SortControl
        query={q({ dimensions: ["op_airline_id"], measures: ["seats", "passengers"] })}
        allowlist={FIXTURE}
      />,
    );
    expect([...container.querySelectorAll(".chip")].map((c) => c.textContent?.trim())).toEqual([
      "Carrier",
      "Seats",
      "Passengers",
    ]);
  });

  it("re-clicking the active sort key flips the direction in the href", () => {
    const { container } = render(
      <SortControl
        query={q({ measures: ["seats"], sort: "seats", sortDesc: true })}
        allowlist={FIXTURE}
      />,
    );
    // Descending today, so the chip for `seats` must offer ASCENDING -- `s=seats`, no minus.
    const href = container.querySelector('[aria-current="page"]')!.getAttribute("href")!;
    expect(href).toContain("s=seats&");
    expect(href).not.toContain("s=-seats");
  });
});
