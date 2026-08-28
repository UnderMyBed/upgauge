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
    // KEYED ON THE ROW'S OWN IDENTIFIER, not on its position. The property under test is the
    // pairing of a glyph with `data-limit`, which is a fact about a row and not about where it
    // sits -- and since #127 the two are genuinely independent: `PDX-AUS` is below floor, so the
    // floor partition renders it last rather than second. Indexing would have made this test
    // fail for a reason it does not care about, and, worse, would make it pass or fail on a
    // future ordering change while claiming to be about the palette.
    const gut = (route: string) => {
      const cell = [...container.querySelectorAll("tbody tr")]
        .find((tr) => tr.querySelector("td.id")?.textContent === route)
        ?.querySelector("td.gut");
      if (!cell) throw new Error(`no rendered row for ${route}`);
      return cell;
    };

    expect(gut("PDX–SEA").getAttribute("data-limit")).toBeNull();
    expect(gut("PDX–SEA").querySelector("abbr")).toBeNull();

    expect(gut("PDX–AUS").querySelector("abbr")?.textContent).toBe("n");
    expect(gut("PDX–AUS").getAttribute("data-limit")).toBeNull();

    expect(gut("PDX–PDX").querySelector("abbr")?.textContent).toBe("⌀");
    expect(gut("PDX–PDX").getAttribute("data-limit")).toBe("true");

    expect(gut("PDX–ZZZ").querySelector("abbr")?.textContent).toBe("Q");
    expect(gut("PDX–ZZZ").getAttribute("data-limit")).toBe("true");
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

// ---------------------------------------------------------------------------------------
// THE FLOOR PARTITION (#127). docs/design/system.md states, in two places, that below-floor
// rows sort below scored rows and are excluded from ranking. Nothing enforced it: the order
// came from the pivot's own ORDER BY, which ranks on a measure and knows nothing about the
// floor, and `/airport` does not even have one (its rows are folded and sorted in TypeScript,
// endpoints.ts). The rule was in the design system and in no code path.
//
// EVERY ASSERTION BELOW IS A SEQUENCE OR A POSITION, never a set or a count. "The below-floor
// rows are present" passes under the bug; only where they SIT distinguishes the two orderings.
//
// FIXTURE.  Modelled on the real defect, served from /airport/STT before this change:
//
//     12  3M    1,748 seats     38 dep
//     13  MQ      380 seats      5 dep   <- below floor
//     14  VD      115 seats    120 dep      120 departures. NOT below floor.
//     15  LF       60 seats      2 dep   <- below floor
//
// A scored row (VD) sandwiched between two below-floor rows, so the measure order and the
// partitioned order DISAGREE on where MQ goes. That is the property M4c's two-sort fixture
// lacked -- a fixture whose row ranks the same under both orderings cannot fail for the reason
// its name claims, and it passed against the bug it was written to catch.
const FLOOR_COLUMNS: ColumnSpec[] = [
  { key: "carrier", label: "Carrier", kind: "identifier" },
  { key: "seats", label: "Seats", kind: "seats" },
  { key: "departures_performed", label: "Dep.", kind: "count" },
];
// In measure order (seats desc), exactly as a pivot ORDER BY would hand them over.
const FLOOR_ROWS = [
  { carrier: "3M", seats: 1748, departures_performed: 38 },
  { carrier: "MQ", seats: 380, departures_performed: 5 },
  { carrier: "VD", seats: 115, departures_performed: 120 },
  { carrier: "LF", seats: 60, departures_performed: 2 },
];

/** The identifier cell of every rendered row, top to bottom. */
function renderedOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll("tbody td.id")].map((n) => n.textContent ?? "");
}

/** Each rendered row's identifier paired with whether it got the below-floor treatment, top to
 * bottom -- the two facts the partition is about, read off the DOM together so a test can assert
 * the PARTITION and the WITHIN-BLOCK ORDER as separate properties. Asserting the whole sequence
 * instead conflates them: one literal `toEqual` refuses every mutant, which reads as thorough and
 * means no single test names the defect it caught. */
function renderedRows(container: HTMLElement): { id: string; belowFloor: boolean }[] {
  return [...container.querySelectorAll("tbody tr")].map((tr) => ({
    id: tr.querySelector("td.id")?.textContent ?? "",
    belowFloor: tr.getAttribute("data-below-floor") === "true",
  }));
}

describe("DataTable: below-floor rows sort last", () => {
  it("puts every below-floor row after every scored row", () => {
    // THE PARTITION, asserted as a partition and nothing else: once a below-floor row appears,
    // no scored row may follow it. Deliberately NOT a literal sequence -- a `toEqual` over all
    // four ids refuses the two mutants below as well, and then neither test names the defect it
    // caught (CLAUDE.md: assert WHICH check refuses a fixture).
    //
    // MUTANT M1, the shipped bug: `orderRows` returns `rows` unchanged -> MQ lands at index 1
    // with VD scored behind it -> RED here, and GREEN on "keeps the measure order", because an
    // unpartitioned list does preserve its own input order. Verified, not assumed.
    // MUTANT M9, `partition` defaulting to false -> RED here for the same reason.
    const { container } = render(<DataTable columns={FLOOR_COLUMNS} rows={FLOOR_ROWS} />);
    const flags = renderedRows(container).map((r) => r.belowFloor);
    const firstSparse = flags.indexOf(true);
    expect(firstSparse).toBeGreaterThanOrEqual(0); // the fixture still discriminates
    expect(flags.slice(firstSparse).includes(false)).toBe(false);
  });

  it("keeps the measure order inside each block", () => {
    // STABILITY, asserted independently of the partition: each block read off by its own flag,
    // so the claim is "the incoming relative order survived", not "the rows are in this order".
    //
    // MUTANT M2: sort the sparse bucket by seats ascending -> ["LF","MQ"], RED here, and GREEN
    // on the partition test above, which still holds. MUTANT M3: reverse the scored bucket ->
    // ["VD","3M"], RED here, GREEN above. Both verified.
    const { container } = render(<DataTable columns={FLOOR_COLUMNS} rows={FLOOR_ROWS} />);
    const rows = renderedRows(container);
    expect(rows.filter((r) => !r.belowFloor).map((r) => r.id)).toEqual(["3M", "VD"]);
    expect(rows.filter((r) => r.belowFloor).map((r) => r.id)).toEqual(["MQ", "LF"]);
  });

  it("does not sort down a row whose departure count was never queried", () => {
    // MUTANT M4: the partition reads the absence as zero -- `(num(row.departures_performed) ??
    // 0) < DEPARTURE_FLOOR` -- and Y joins the sparse bucket, leaving the order ["X","Y"].
    //
    // This is issue #118's defect re-introduced one layer down, at the ORDERING rather than at
    // the treatment, and the existing `data-below-floor` tests cannot see it: they count
    // dashed rows, and a partition with its own predicate leaves that count at 0 either way.
    // X is below floor and Y makes no claim, so the correct order INVERTS the measure order --
    // under the mutant it does not move at all.
    const rows = [
      { carrier: "X", seats: 500, departures_performed: 5 },
      { carrier: "Y", seats: 100 },
    ];
    const { container } = render(<DataTable columns={FLOOR_COLUMNS} rows={rows} />);
    expect(renderedOrder(container)).toEqual(["Y", "X"]);
    // ...and the two signals stay independent: Y is neither dashed nor glyphed.
    expect(container.querySelectorAll("tr[data-below-floor='true']").length).toBe(1);
    expect(container.querySelectorAll("tbody td.gut abbr").length).toBe(1);
  });

  it("sorts down a below-floor row whose gutter glyph is Q, not n", () => {
    // MUTANT M5: partition on `reasonFor(row) === "belowFloor"` instead of `isBelowFloor(row)`.
    // Quarantine outranks the floor in the glyph's severity pick, so B's reason is
    // "quarantined" and it never enters the sparse bucket -- order stays ["A","B","C"], red.
    //
    // The re-coupling `reasonFor`'s own comment exists to prevent, one layer down. Measured, it
    // is the LIKELY mutant rather than a contrived one: 97.7% of zero-pax rows are also below
    // floor (docs/design/system.md), so gating on the winning glyph misplaces nearly the whole
    // class. B stays dashed and still shows Q -- the treatment and the glyph are unchanged;
    // only its position moves.
    const rows = [
      { carrier: "A", seats: 900, departures_performed: 6810 },
      { carrier: "B", seats: 400, departures_performed: 5, quarantined_rows: 2 },
      { carrier: "C", seats: 100, departures_performed: 120 },
    ];
    const { container } = render(<DataTable columns={FLOOR_COLUMNS} rows={rows} />);
    expect(renderedOrder(container)).toEqual(["A", "C", "B"]);
    // B sits last AND still shows Q: the glyph is chosen by severity and the position by the
    // floor, and this test is the one that would notice them being re-collapsed into one.
    const last = [...container.querySelectorAll("tbody tr")][2];
    expect(last?.querySelector("td.gut abbr")?.textContent).toBe("Q");
    expect(last?.getAttribute("data-below-floor")).toBe("true");
  });

  it("sorts down a below-floor row whose gutter glyph is the zero-pax mark", () => {
    // MUTANT M5, the other branch that outranks the floor: zero-pax also wins the glyph, so the
    // same `reasonFor` partition leaves B at position 2. Two branches, two fixtures -- asserting
    // only the Q case would leave the zero-pax branch of the same mutant green, and that branch
    // is the one carrying 97.7% overlap with the floor.
    const rows = [
      { carrier: "A", seats: 900, departures_performed: 6810 },
      { carrier: "B", seats: 400, departures_performed: 5, load_factor: 0 },
      { carrier: "C", seats: 100, departures_performed: 120 },
    ];
    const { container } = render(<DataTable columns={FLOOR_COLUMNS} rows={rows} />);
    expect(renderedOrder(container)).toEqual(["A", "C", "B"]);
    const last = [...container.querySelectorAll("tbody tr")][2];
    expect(last?.querySelector("td.gut abbr")?.textContent).toBe("⌀");
    expect(last?.getAttribute("data-below-floor")).toBe("true");
  });
});

describe("DataTable: below-floor rows are excluded from ranking", () => {
  it("numbers scored rows 1..k and withholds a rank from every below-floor row", () => {
    // MUTANT M7: rank stays `i + 1` over the partitioned array -> ["1","2","3","4"], red.
    // MUTANT M8: rank taken BEFORE the partition, so a scored row keeps its measure position ->
    // ["1","3","—","—"], red. That is the "rank jumps" defect; asserting only "starts at 1"
    // (which app/smoke.sh does for /watch) passes under BOTH.
    const { container } = render(<DataTable columns={FLOOR_COLUMNS} rows={FLOOR_ROWS} rank />);
    const ranks = [...container.querySelectorAll('[data-testid="rank-cell"]')].map(
      (n) => n.textContent,
    );
    expect(ranks).toEqual(["1", "2", "—", "—"]);
    // The rank column tracks the RENDERED order, not the input order.
    expect(renderedOrder(container)).toEqual(["3M", "VD", "MQ", "LF"]);
  });

  it("ranks every row when no row makes a claim about the floor", () => {
    // The positive control for the pair above: an implementation that withheld every rank, or
    // one that withheld none, passes exactly one of these two. /watch is this case for real --
    // mart_route_health carries `t12_departures_performed` and displayRows deliberately does not
    // alias it to `departures_performed` (watch/[preset]/page.tsx), so no preset row ever
    // claims the floor and all four leaderboards number straight through.
    const rows = [{ carrier: "A", seats: 3 }, { carrier: "B", seats: 2 }, { carrier: "C", seats: 1 }];
    const { container } = render(<DataTable columns={FLOOR_COLUMNS} rows={rows} rank />);
    const ranks = [...container.querySelectorAll('[data-testid="rank-cell"]')].map(
      (n) => n.textContent,
    );
    expect(ranks).toEqual(["1", "2", "3"]);
    expect(renderedOrder(container)).toEqual(["A", "B", "C"]);
  });
});

describe("DataTable: the partition is the default, and /explore is the exemption", () => {
  it("partitions without being asked to", () => {
    // MUTANT M9: flip the default to `partition = false` -> red here, and red on the /explore
    // exemption test below only in the sense that it goes GREEN for the wrong reason -- which is
    // exactly why the exemption is asserted separately rather than inferred from this one.
    // Every surface but /explore relies on this default; none of them passes `partition`.
    const { container } = render(<DataTable columns={FLOOR_COLUMNS} rows={FLOOR_ROWS} />);
    expect(renderedOrder(container)).toEqual(["3M", "VD", "MQ", "LF"]);
  });

  it("renders the caller's own order when the partition is declined", () => {
    // MUTANT M10: ignore the prop and partition unconditionally -> ["3M","VD","MQ","LF"], red.
    // Without this the exemption is silently deletable: with only the test above, removing
    // `partition={false}` from /explore's call site breaks nothing.
    const { container } = render(
      <DataTable columns={FLOOR_COLUMNS} rows={FLOOR_ROWS} partition={false} />,
    );
    expect(renderedOrder(container)).toEqual(["3M", "MQ", "VD", "LF"]);
    // The TREATMENT is unaffected by the exemption -- /explore still dashes and mutes its
    // below-floor rows, it just does not move them. Only the ORDER is the visitor's.
    expect(container.querySelectorAll("tr[data-below-floor='true']").length).toBe(2);
  });
});
