// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataTable, type ColumnSpec } from "@/components/DataTable";

const COLUMNS: ColumnSpec[] = [
  { key: "route", label: "Route", kind: "identifier" },
  { key: "seats", label: "Seats", kind: "seats" },
  { key: "load_factor", label: "Load factor", kind: "loadFactor", derived: true },
  { key: "avg_gauge", label: "Gauge", kind: "gauge", derived: true },
  { key: "departures_performed", label: "Dep.", kind: "count" },
];

const ROWS = [
  { route: "PDX–SEA", seats: 501089, load_factor: 0.7782, avg_gauge: 73.58, departures_performed: 6810 },
  { route: "PDX–PDX", seats: 2780, load_factor: 0, avg_gauge: 73.2, departures_performed: 38 },
  { route: "PDX–AUS", seats: 190, load_factor: 0.9789, avg_gauge: 190, departures_performed: 1 },
];

describe("DataTable", () => {
  it("formats every numeric to its fixed decimals", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText("501,089")).toBeDefined();
    expect(screen.getByText("77.82%")).toBeDefined();
    expect(screen.getByText("73.6")).toBeDefined();
  });

  it("renders a zero load factor as 0.00%, not as absent", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    // It flew 38 departures and carried nobody. That is a measurement, not a gap.
    expect(screen.getByText("0.00%")).toBeDefined();
  });

  it("marks rows below the 30-departure floor without hiding them", () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} />);
    const thin = container.querySelectorAll("tr[data-below-floor='true']");
    expect(thin.length).toBe(1); // only PDX–AUS, at 1 departure
    expect(screen.getByText("PDX–AUS")).toBeDefined(); // still rendered
  });

  it("marks derived measure headers so they are labelled as computed", () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(container.querySelectorAll("th[data-derived='true']").length).toBe(2);
  });

  it("right-aligns numerics via the tabular class", () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(container.querySelectorAll("td.num").length).toBe(3 * 4);
  });
});
