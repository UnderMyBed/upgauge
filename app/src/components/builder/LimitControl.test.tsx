// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { LimitControl } from "@/components/builder/LimitControl";
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

describe("LimitControl", () => {
  it("offers the app's own limit set and marks the current one", () => {
    const { container } = render(<LimitControl query={q({ limit: 50 })} />);
    expect([...container.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual([
      "25",
      "50",
      "100",
      "250",
      "1000",
    ]);
    expect(container.querySelector('[aria-current="page"]')!.textContent).toBe("50");
  });

  it("marks nothing current when the query carries a limit outside the set", () => {
    const { container } = render(<LimitControl query={q({ limit: 37 })} />);
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
  });
});
