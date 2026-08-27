// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    // City market has no entity page (entityLink.ts's ENTITY_PREFIX carries no city-market
    // entry), so the name must render bare, not as the label of a link to nowhere.
    expect(document.querySelector("a")).toBeNull();
  });

  // M5 "connect the graph", Step 1(a): a linkable dimension cell wraps the CODE in an <a
  // href>, and the abbr carrying the full name nests INSIDE that anchor rather than being
  // replaced by it -- a keyboard user reaches the name through the abbr's title regardless of
  // whether the cell also links. One assertion covers both facts: the anchor exists at the
  // href entityHref would compute (CARRIER_PREFIX + code) AND its content is the abbr with
  // the expected title.
  it("wraps a linkable cell's code in <a href>, nesting the abbr name expansion inside it", () => {
    const { container } = render(<DataTable columns={COLS} rows={ROWS} resolved={RESOLVED} />);
    const link = container.querySelector('a[href="/carrier/DL"]');
    expect(link?.querySelector("abbr[title='Delta Air Lines Inc.']")?.textContent).toBe("DL");
  });

  // Step 1(b): a non-linkable cell renders exactly what it renders today -- no <a> for an
  // unresolved id (there is no code to build a URL from, even though the dimension itself has
  // an entity page).
  it("does not link an unresolved id, even though op_airline_id has an entity page", () => {
    const { container } = render(<DataTable columns={COLS} rows={ROWS} resolved={new Map()} />);
    expect(screen.getByText("19790")).toBeDefined();
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("DataTable: non-dimension identifier cells (e.g. explore's synthetic __route)", () => {
  // Fix round 1, Important 2: IdentifierCell's link is a typed `ColumnSpec.href` accessor,
  // not a naming convention on row data (`row["${key}Href"]`) -- there is nothing to spell
  // wrong and no collision surface with a row's own fields. route's column_expr spans two
  // columns, so it is not a single-dimension resolution and never goes through
  // DimensionCell/entityHref at all.
  const linkedCols: ColumnSpec[] = [
    {
      key: "__route",
      label: "Route",
      kind: "identifier",
      href: (row) => (row.__route === "IFP–IAH" ? "/route/IAH-IFP" : null),
    },
  ];

  it("links via the column's href accessor", () => {
    const rows = [{ __route: "IFP–IAH" }];
    const { container } = render(<DataTable columns={linkedCols} rows={rows} />);
    const link = container.querySelector('a[href="/route/IAH-IFP"]');
    expect(link?.textContent).toBe("IFP–IAH");
  });

  it("renders plain text when the accessor returns null for this row (one half didn't resolve)", () => {
    const rows = [{ __route: "19790–SEA" }];
    const { container } = render(<DataTable columns={linkedCols} rows={rows} />);
    expect(screen.getByText("19790–SEA")).toBeDefined();
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders plain text, exactly as before, for a column with no href accessor at all", () => {
    const bareCols: ColumnSpec[] = [{ key: "__route", label: "Route", kind: "identifier" }];
    const rows = [{ __route: "PDX–SEA" }];
    const { container } = render(<DataTable columns={bareCols} rows={rows} />);
    expect(screen.getByText("PDX–SEA")).toBeDefined();
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("DataTable: rank column", () => {
  it("renders a leading rank column, sequential from 1, when rank is set", () => {
    // The bug this catches: rendering the row INDEX (0-based), or re-deriving rank from a
    // sort the component does not own. Asserting 'a rank column exists' would pass on both.
    // Asserting the SEQUENCE is what distinguishes them.
    const rows = [{ k: "a", seats: 3 }, { k: "b", seats: 2 }, { k: "c", seats: 1 }];
    const columns: ColumnSpec[] = [
      { key: "k", label: "K", kind: "identifier" },
      { key: "seats", label: "Seats", kind: "seats" },
    ];
    render(<DataTable columns={columns} rows={rows} resolved={new Map()} rank />);
    const cells = screen.getAllByTestId("rank-cell").map((n) => n.textContent);
    expect(cells).toEqual(["1", "2", "3"]);
  });

  it("renders no rank column by default", () => {
    const rows = [{ k: "a", seats: 3 }];
    const columns: ColumnSpec[] = [{ key: "k", label: "K", kind: "identifier" }];
    render(<DataTable columns={columns} rows={rows} resolved={new Map()} />);
    expect(screen.queryAllByTestId("rank-cell")).toHaveLength(0);
  });
});

// Fix round 1, Important 1: Tailwind's preflight resets `a { color: inherit; text-decoration:
// inherit }`, so a new <a> in a data-table cell is pixel-identical to plain text without an
// explicit rule -- jsdom computes no styles (no layout engine), so nothing above this line can
// catch that CSS rule being deleted or never written; this test cannot see the rendered
// pixels either, only the source text. It is deliberately weak, stated here rather than
// implied: it proves the selector and a non-colour channel are IN THE STYLESHEET, not that a
// browser paints them as intended. That is still worth having -- it turns a silent CSS
// deletion into a red test instead of a link only a screen reader or a diff of globals.css
// would notice.
it("globals.css styles a data-table link with a non-colour channel, not colour alone", () => {
  // Relative to THIS file, not process.cwd() -- vitest.setup.ts chdirs the test process to
  // the repo root (UPGAUGE_ROOT), not app/, so a cwd-relative path would silently resolve
  // one directory short and this test would need to know that setup detail to pass.
  const globalsCssPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../app/globals.css",
  );
  const css = readFileSync(globalsCssPath, "utf8");
  const rule = css.match(/\.data-table td\.id a\s*\{[^}]*\}/);
  expect(rule).not.toBeNull();
  const body = rule![0];
  expect(body).toMatch(/color:\s*var\(--signal\)/);
  // Colour is never the sole channel (docs/design/system.md, Quality floor) -- underline is
  // the second.
  expect(body).toMatch(/text-decoration:\s*underline/);
});

// A data table is the widest thing this app renders, and it sits in `.body`'s
// `minmax(0, 1fr)` grid column beside a 214px sticky legend rail. Three CSS facts compose
// into a bug: a table cannot lay out narrower than its own min-content width; `minmax(0, 1fr)`
// explicitly PERMITS its column to shrink below that; and nothing was clipping or scrolling
// the overflow. So past the width where the columns stop fitting, the table simply paints
// outside its column and over the legend. /watch shows it first because it is the widest --
// fifteen measure columns against /route's and /airport's four -- but every page that renders
// a DataTable shares the mechanism, which is why the container belongs to the COMPONENT and
// not to one page's stylesheet.
//
// Deliberately not fixed by choosing a breakpoint or a min-width: those pin the layout to
// particular window sizes, and the next column added moves the threshold again without
// anything going red. A scroll container is width-independent -- it is correct at every
// viewport, including ones nobody measured.
describe("a wide table scrolls inside its column rather than over the legend", () => {
  it("wraps the table in a scroll container, so overflow can never reach the legend rail", () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} />);
    const table = container.querySelector("table.data-table");
    expect(table).not.toBeNull();
    // The table must not be the outermost node: something has to own the overflow.
    const wrapper = table!.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("table-scroll");
  });

  // Same deliberate weakness as the link-colour test above, and stated for the same reason:
  // jsdom computes no layout, so this proves the rule is IN the stylesheet, not that a browser
  // honours it. Without it the wrapper above is a plain div and the bug is unchanged -- which
  // is exactly the failure a structural assertion alone cannot see.
  it("globals.css makes that container actually scroll horizontally", () => {
    const globalsCssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../app/globals.css",
    );
    const css = readFileSync(globalsCssPath, "utf8");
    const rule = css.match(/\.table-scroll\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toMatch(/overflow-x:\s*auto/);
  });
});

// ---------------------------------------------------------------------------------------
// Issue #118 design review: the gauge rail is a COLUMN-wide instrument, not a per-row one.
//
// `system.md` § The data table, written in this same change, forbids a blank cell -- "a blank
// cell reads as a rendering fault" -- and one cell to the right of the em dash the rail was
// returning an empty div for a null gauge, deleting the shared 0-260 axis for that row and
// punching a hole through the instrument the rows above and below are read against.
describe("the gauge rail with nothing to mark", () => {
  const COLS: ColumnSpec[] = [
    { key: "op_airline_id", label: "Carrier", kind: "identifier" },
    { key: "seats", label: "Seats", kind: "seats" },
  ];
  const unknowable = [
    { op_airline_id: "8V", seats: null, avg_gauge: null, quarantined_rows: 1 },
  ];

  it("keeps the axis when the gauge is unknowable", () => {
    // MUTANT: `if (gauge === null) return <div className="rail" aria-hidden="true" />;`
    // (the pre-#118 form) -> zero bands, zero gridlines, red.
    const { container } = render(<DataTable columns={COLS} rows={unknowable} />);
    const rail = container.querySelector(".rail");
    expect(rail).not.toBeNull();
    expect(rail!.querySelectorAll(".band").length).toBe(2);
    expect(rail!.querySelectorAll(".grid").length).toBe(5);
  });

  it("marks no position on it", () => {
    // The other half: an axis drawn WITH a tick would be a fabricated gauge, which is the same
    // defect as the fabricated zero one column to the left. Asserting the axis alone would pass
    // for an implementation that drew a tick at 0.
    // MUTANT: render the tick unconditionally (e.g. `pct(gauge ?? 0)`) -> red.
    const { container } = render(<DataTable columns={COLS} rows={unknowable} />);
    expect(container.querySelectorAll(".rail .tick").length).toBe(0);
  });

  it("draws NOTHING for a row that never queried the gauge", () => {
    // THE REGRESSION THIS PAIR EXISTS FOR. `num()` maps an absent key and a queried null to the
    // same `null`, so drawing the axis on `null` alone put every row of any permalink that did
    // not select `avg_gauge` into the wholly-quarantined visual state -- measured on a served
    // build, all 25 rows of the default top-25 `/explore` view, none of them quarantined. The
    // pivot templates emit only the measures a query selected; a row without the column makes
    // no claim about the gauge, exactly as `isBelowFloor` already says for the departure count.
    // MUTANT: `gauge={num(row.avg_gauge)}` at the call site -> red.
    const { container } = render(
      <DataTable columns={COLS} rows={[{ op_airline_id: "DL", seats: 100 }]} />,
    );
    expect(container.querySelectorAll(".rail").length).toBe(1);
    expect(container.querySelectorAll(".rail .band").length).toBe(0);
    expect(container.querySelectorAll(".rail .grid").length).toBe(0);
    expect(container.querySelectorAll(".rail .tick").length).toBe(0);
  });

  it("still marks a position when the gauge is known", () => {
    // The positive control: an implementation that dropped every tick passes both tests above.
    const { container } = render(
      <DataTable columns={COLS} rows={[{ op_airline_id: "DL", seats: 100, avg_gauge: 130 }]} />,
    );
    expect(container.querySelectorAll(".rail .tick").length).toBe(1);
  });
});
