// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { GrainControl } from "@/components/builder/GrainControl";
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

describe("GrainControl", () => {
  it("marks the current grain and offers the other as a real link", () => {
    const { container } = render(<GrainControl query={q()} allowlist={FIXTURE} />);
    const chips = [...container.querySelectorAll(".chip-row")][0];
    const current = chips.querySelector('[aria-current="page"]')!;
    expect(current.textContent).toBe("Segment");
    expect(chips.querySelector("a:not([aria-current])")!.getAttribute("href")).toContain("k=route");
  });

  it("the route link already carries the repaired dimension list", () => {
    // aircraft_type is segment-only. A link that kept it would 'unknown dimension' on click,
    // which is the whole class the round-trip property exists to prevent -- asserted here at
    // the CALL SITE, because a pinned function is not a pinned call site.
    const { container } = render(<GrainControl query={q()} allowlist={FIXTURE} />);
    const href = container.querySelector('a[href*="k=route"]')!.getAttribute("href")!;
    expect(href).not.toContain("aircraft_type");
  });

  it("offers both groupings, marking the active one", () => {
    const { container } = render(
      <GrainControl query={q({ grouping: "mainline" })} allowlist={FIXTURE} />,
    );
    const row = [...container.querySelectorAll(".chip-row")][1];
    expect(row.querySelector('[aria-current="page"]')!.textContent).toBe("Mainline");
  });
});
