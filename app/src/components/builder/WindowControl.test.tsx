// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { WindowControl } from "@/components/builder/WindowControl";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";

const ASOF = "2026-04";
function q(over: Partial<PivotQuery> = {}): PivotQuery {
  return normalizeQuery({
    grain: "segment", dimensions: ["op_airline_id"], measures: ["seats"],
    timeFrom: "2025-05", timeTo: "2026-04", filters: [], sort: null,
    sortDesc: true, limit: 100, grouping: "operating", ...over,
  });
}

describe("WindowControl", () => {
  it("offers the three range presets against asOf, not against today", () => {
    const { container } = render(<WindowControl query={q()} asOf={ASOF} />);
    const href = (label: string) =>
      [...container.querySelectorAll(".chip")].find((n) => n.textContent === label)!.getAttribute("href");
    expect(href("Trailing 12")).toContain("t=2025-05:2026-04");
    expect(href("Trailing 24")).toContain("t=2024-05:2026-04");
    expect(href("Full window")).toContain("t=2015-01:2026-04");
  });

  it("marks the preset the query is already showing", () => {
    const { container } = render(<WindowControl query={q()} asOf={ASOF} />);
    expect(container.querySelector('[aria-current="page"]')!.textContent).toBe("Trailing 12");
  });

  it("clamps the partial asOf year rather than claiming a full one", () => {
    // 2026 has filed through April. A chip emitting t=2026-01:2026-12 would be refused by
    // checkBounds, and a chip that silently rendered it would be a dead link on the page.
    const { container } = render(<WindowControl query={q()} asOf={ASOF} />);
    const y2026 = [...container.querySelectorAll(".chip")].find((n) => n.textContent!.startsWith("2026"))!;
    expect(y2026.getAttribute("href")).toContain("t=2026-01:2026-04");
  });

  it("marks a full calendar year as partial in the label, never silently", () => {
    const { container } = render(<WindowControl query={q()} asOf={ASOF} />);
    const labels = [...container.querySelectorAll(".chip")].map((n) => n.textContent);
    expect(labels).toContain("2026*");
    expect(labels).toContain("2025");
  });

  it("emits a year chip for every year from 2015 to the asOf year", () => {
    const { container } = render(<WindowControl query={q()} asOf={ASOF} />);
    const rows = [...container.querySelectorAll(".chip-row")];
    expect(rows[1].querySelectorAll(".chip").length).toBe(12);
  });

  it("marks only the preset current when a December asOf makes Trailing 12 and the year coincide", () => {
    // Whenever asOf's month is December, Trailing 12's window IS the asOf year's own calendar
    // window -- both predicates fire on their own chip. Two aria-current="page" chips in one
    // control claims two different things are the current view; the preset row must win. Not
    // reachable with the ASOF fixture above (month 04), which is exactly why the earlier bug
    // shipped uncaught -- this fixture is deliberately a December asOf to pin the case.
    const DEC_ASOF = "2026-12";
    const query = q({ timeFrom: "2026-01", timeTo: "2026-12" });
    const { container } = render(<WindowControl query={query} asOf={DEC_ASOF} />);
    const current = [...container.querySelectorAll('[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe("Trailing 12");
  });
});
