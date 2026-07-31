// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { resolutionKey } from "@/lib/resolve";

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

  // Fix round 1, CRITICAL 1: the gutter glyph and the below-floor row treatment used to be
  // gated on the same collapsed `reason` value, so a row that was both below-floor and
  // zero-pax lost its below-floor treatment entirely (measured: 97.7% of zero-pax rows are
  // also below floor -- see docs/design/system.md). They must now be independent.
  it("applies below-floor row treatment even when the gutter shows a different, more severe glyph", () => {
    const OVERLAP_ROW = {
      route: "PDX–BOI",
      seats: 800,
      load_factor: 0,
      avg_gauge: 78.4,
      departures_performed: 5, // below the 30-departure floor AND zero-pax
    };
    const { container } = render(<DataTable columns={COLUMNS} rows={[OVERLAP_ROW]} />);
    const row = container.querySelector("tbody tr");
    expect(row?.getAttribute("data-below-floor")).toBe("true");
    expect(row?.querySelector("td.gut abbr")?.textContent).toBe("⌀"); // zero-pax outranks "n"
    expect(row?.querySelector(".rail .tick")?.getAttribute("data-muted")).toBe("true");
  });

  // Fix round 1, IMPORTANT 2: nothing previously inspected data-limit, so an inverted
  // palette (--limit on "n", or missing it on "⌀"/"Q") would have passed every test.
  it("gutter: `n` never carries --limit; `⌀` and `Q` always do", () => {
    const GUTTER_ROWS = [
      { route: "PDX–SEA", seats: 501089, load_factor: 0.7782, avg_gauge: 73.58, departures_performed: 6810 }, // no reason
      { route: "PDX–AUS", seats: 190, load_factor: 0.9789, avg_gauge: 190, departures_performed: 1 }, // belowFloor -> "n"
      { route: "PDX–PDX", seats: 2780, load_factor: 0, avg_gauge: 73.2, departures_performed: 38 }, // zeroPax -> "⌀"
      { route: "PDX–ZZZ", seats: 100, load_factor: 0.5, avg_gauge: 100, departures_performed: 50, quarantined_rows: 2 }, // -> "Q"
    ];
    const { container } = render(<DataTable columns={COLUMNS} rows={GUTTER_ROWS} />);
    const gutCells = container.querySelectorAll("tbody td.gut");

    expect(gutCells[0].getAttribute("data-limit")).toBeNull();
    expect(gutCells[0].querySelector("abbr")).toBeNull();

    expect(gutCells[1].querySelector("abbr")?.textContent).toBe("n");
    expect(gutCells[1].getAttribute("data-limit")).toBeNull();

    expect(gutCells[2].querySelector("abbr")?.textContent).toBe("⌀");
    expect(gutCells[2].getAttribute("data-limit")).toBe("true");

    expect(gutCells[3].querySelector("abbr")?.textContent).toBe("Q");
    expect(gutCells[3].getAttribute("data-limit")).toBe("true");
  });

  // Whole-branch review, CRITICAL 2: the pivot templates emit only the measures the query
  // asked for (sql/03_queries/pivot_segment.sql), so `departures_performed` is absent from
  // every row of any permalink that did not select it -- including the error page's own
  // "a known-valid query" link (m=seats). `(num(...) ?? 0) < 30` read that absence as 0 and
  // marked 100% of rows below floor. Absence is not a measurement of zero (lib/format.ts:1);
  // a row whose departure count was never queried makes no claim about the floor at all.
  const NO_DEP_COLUMNS: ColumnSpec[] = [
    { key: "route", label: "Route", kind: "identifier" },
    { key: "seats", label: "Seats", kind: "seats" },
  ];
  const NO_DEP_ROWS = [
    { route: "PDX–SEA", seats: 501089 },
    { route: "PDX–AUS", seats: 190 },
  ];

  it("claims nothing about the floor when departures_performed was not selected", () => {
    const { container } = render(<DataTable columns={NO_DEP_COLUMNS} rows={NO_DEP_ROWS} />);
    expect(container.querySelectorAll("tr[data-below-floor='true']").length).toBe(0);
  });

  it("shows no gutter glyph when departures_performed was not selected", () => {
    const { container } = render(<DataTable columns={NO_DEP_COLUMNS} rows={NO_DEP_ROWS} />);
    expect(container.querySelectorAll("tbody td.gut abbr").length).toBe(0);
  });
});

describe("DataTable renders resolved display values", () => {
  const COLS: ColumnSpec[] = [
    { key: "op_airline_id", label: "Carrier", kind: "identifier", dimKey: "op_airline_id" },
    { key: "seats", label: "Seats", kind: "seats" },
  ];
  const ROWS = [{ op_airline_id: 19790, seats: 100 }];
  const RESOLVED = new Map([
    [resolutionKey("op_airline_id", 19790), { code: "DL", name: "Delta Air Lines Inc." }],
  ]);

  it("shows the code, not the id", () => {
    render(<DataTable columns={COLS} rows={ROWS} resolved={RESOLVED} />);
    expect(screen.getByText("DL")).toBeDefined();
    expect(screen.queryByText("19790")).toBeNull();
  });

  it("carries the name as the abbreviation's expansion", () => {
    const { container } = render(<DataTable columns={COLS} rows={ROWS} resolved={RESOLVED} />);
    expect(container.querySelector("abbr[title='Delta Air Lines Inc.']")).not.toBeNull();
  });

  it("falls back to the raw id when unresolved, never to a dash", () => {
    render(<DataTable columns={COLS} rows={ROWS} resolved={new Map()} />);
    // Absence of a NAME is not absence of DATA -- lib/format.ts's opening rule.
    expect(screen.getByText("19790")).toBeDefined();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("renders a market name directly, since a market has no code", () => {
    const cols: ColumnSpec[] = [
      { key: "origin_city_market_id", label: "Origin market", kind: "identifier", dimKey: "origin_city_market_id" },
    ];
    const resolved = new Map([
      [resolutionKey("origin_city_market_id", 30559), { code: null, name: "Seattle, WA" }],
    ]);
    render(<DataTable columns={cols} rows={[{ origin_city_market_id: 30559 }]} resolved={resolved} />);
    expect(screen.getByText("Seattle, WA")).toBeDefined();
  });
});
