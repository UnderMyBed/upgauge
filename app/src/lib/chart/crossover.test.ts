import { describe, expect, it } from "vitest";
import { findCrossover } from "@/lib/chart/crossover";
// The REAL row type, not a local restatement of it: crossover.ts declares only the four
// fields it reads, so this import is what proves the two agree. A rename in MixRow (or a
// field losing its type) fails this file at typecheck, which is the point.
import type { MixRow } from "@/lib/chart/aircraftMix";

const row = (year: string, code: string, seats: number): MixRow => ({
  month: `${year}-06`,
  code,
  label: code,
  seats,
  departures: 1,
});

describe("findCrossover", () => {
  it("returns the most recent crossover, not the first", () => {
    const rows = [
      row("2016", "A", 100),
      row("2016", "B", 10),
      row("2018", "A", 10),
      row("2018", "B", 100), // crossover A -> B
      row("2022", "A", 100),
      row("2022", "B", 10), // crossover B -> A, more recent
    ];
    // Falsifiable: an implementation returning the first crossover yields 2018.
    expect(findCrossover(rows)).toEqual({ year: "2022", from: "B", to: "A" });
  });

  it("orders years by value, not by the order rows arrive in", () => {
    // Same data as above, reversed. Falsifiable: an implementation that walks the input in
    // arrival order reads the years as 2022, 2018, 2016 and returns the 2016 boundary
    // ({ year: "2016", from: "B", to: "A" }) instead of the 2022 one. Pivot output is
    // ordered today; nothing in this function's contract says it must stay that way.
    const rows = [
      row("2022", "B", 10),
      row("2022", "A", 100),
      row("2018", "B", 100),
      row("2018", "A", 10),
      row("2016", "B", 10),
      row("2016", "A", 100),
    ];
    expect(findCrossover(rows)).toEqual({ year: "2022", from: "B", to: "A" });
  });

  it("returns null when one type leads every year", () => {
    // Strengthened past the brief's version, which had a single type present. That fixture
    // could not distinguish "no change in the leader" from "no change in anything": here the
    // runner-up changes identity every year (B -> C -> D) and every type's seats move, so an
    // implementation keying on the type SET, on the full ordering, or on seats moving at all
    // reports a crossover. Only one that compares the #1 alone returns null.
    const rows = [
      row("2016", "A", 100),
      row("2016", "B", 90),
      row("2017", "A", 70),
      row("2017", "C", 60),
      row("2018", "A", 80),
      row("2018", "D", 79),
    ];
    expect(findCrossover(rows)).toBeNull();
  });

  it("returns null for a single-type route", () => {
    expect(findCrossover([row("2016", "A", 100)])).toBeNull();
  });

  it("returns null for no rows at all", () => {
    // A route with no scheduled service in the window: /route already renders an empty state
    // for it, but the annotation must not throw on the way there.
    expect(findCrossover([])).toBeNull();
  });

  it("does not treat a tie as a crossover, in either input order", () => {
    // The brief supplied only the first ordering. That is not falsifiable for the reason it
    // claims: the naive `sort by seats desc, take [0]` breaks this tie toward whichever row
    // came first, which in that ordering is A -- the same leader as 2016 -- so a flapping
    // implementation passes by accident of fixture order. Running BOTH orderings pins it:
    // arbitrary tie-breaking must return { year: "2017", from: "A", to: "B" } for one of the
    // two, since the two differ in nothing but which tied row is seen first.
    const aFirst = [row("2016", "A", 100), row("2017", "A", 50), row("2017", "B", 50)];
    const bFirst = [row("2016", "A", 100), row("2017", "B", 50), row("2017", "A", 50)];
    expect(findCrossover(aFirst)).toBeNull();
    expect(findCrossover(bFirst)).toBeNull();
  });

  it("does not let a tied year erase a real change on either side of it", () => {
    // The tie year has no leader, so it emits nothing itself -- but A led before it and B
    // leads after it, which is a genuine crossover and is exactly what one looks like
    // mid-transition. Falsifiable: an implementation that compares only ADJACENT years
    // returns null, because 2017 has no leader to compare against on either side.
    const rows = [
      row("2016", "A", 100),
      row("2017", "A", 50),
      row("2017", "B", 50),
      row("2018", "B", 100),
      row("2018", "A", 10),
    ];
    expect(findCrossover(rows)).toEqual({ year: "2018", from: "A", to: "B" });
  });

  it("sums a type's seats across the months of a year before ranking", () => {
    // Falsifiable: an implementation ranking individual rows rather than yearly totals sees
    // B's single 100-seat month as 2017's largest row and reports a crossover to B, when A
    // in fact flew 120 seats that year. The chart's rows are monthly (136 of them), so this
    // is the shape the real input has -- not a contrived one.
    const rows = [
      row("2016", "A", 300),
      { ...row("2017", "A", 40), month: "2017-01" },
      { ...row("2017", "A", 40), month: "2017-02" },
      { ...row("2017", "A", 40), month: "2017-03" },
      { ...row("2017", "B", 100), month: "2017-04" },
    ];
    expect(findCrossover(rows)).toBeNull();
  });

  it("names the types by display label, not by the catalog code", () => {
    // The annotation is read by a human ("A321nXLR overtakes B757-2"). Falsifiable: an
    // implementation returning the grouping key reports { from: "622", to: "699" }. `code`
    // is useless for display -- 612 is the 737-700, not the A321 (an M4a finding).
    const rows = [
      { month: "2016-06", code: "622", label: "B757-2", seats: 100, departures: 1 },
      { month: "2017-06", code: "699", label: "A321nXLR", seats: 100, departures: 1 },
    ];
    expect(findCrossover(rows)).toEqual({
      year: "2017",
      from: "B757-2",
      to: "A321nXLR",
    });
  });

  it("compares consecutive years that are present, across a gap in the window", () => {
    // A route can go unserved for years. Falsifiable: an implementation stepping year + 1
    // and requiring the next year to exist finds no pair at all and returns null.
    const rows = [row("2016", "A", 100), row("2021", "B", 100)];
    expect(findCrossover(rows)).toEqual({ year: "2021", from: "A", to: "B" });
  });

  it("does not make a zero-seat filing the leader of its year", () => {
    // T-100 carries ordinary no-service filings with seats = 0 (CLAUDE.md, data gotchas);
    // 2017 here is a year in which nothing flew. Falsifiable: an implementation taking the
    // max without requiring it to be positive crowns B on 0 seats and reports a crossover
    // A -> B -- an annotation about an aircraft that carried nobody.
    const rows = [row("2016", "A", 100), row("2017", "B", 0)];
    expect(findCrossover(rows)).toBeNull();
  });

  it("returns null for JFK-LAX, which has no crossover in the window", () => {
    // Measured against the built upgauge.duckdb: the A321nXLR is the #1 type by seats in
    // every year 2015-2026 on JFK-LAX, so the flagship route this project demos carries NO
    // annotation. Only 12,416 of 22,919 routes (54%) ever change their #1 type, so null is
    // the common case.
    //
    // The fixture is the measured top TWO types per year, each year's annual total collapsed
    // into one month (the function aggregates by year, so that is faithful to what it
    // computes). Row 1 of each pair is the true #1 in the source. The runner-up churns --
    // B757-2, A320-1/2, B767-4, B767-3/R -- which is what makes this more than a
    // constant-input test: an implementation watching anything but the #1 fires here.
    const jfkLax: MixRow[] = (
      [
        ["2015", "699", "A321nXLR", 1695791, "622", "B757-2", 948650],
        ["2016", "699", "A321nXLR", 1843738, "694", "A320-1/2", 618911],
        ["2017", "699", "A321nXLR", 1901501, "694", "A320-1/2", 610850],
        ["2018", "699", "A321nXLR", 1977105, "624", "B767-4", 471088],
        ["2019", "699", "A321nXLR", 2005276, "626", "B767-3/R", 546898],
        ["2020", "699", "A321nXLR", 886189, "626", "B767-3/R", 691298],
        ["2021", "699", "A321nXLR", 922535, "624", "B767-4", 621812],
        ["2022", "699", "A321nXLR", 1581153, "626", "B767-3/R", 907163],
        ["2023", "699", "A321nXLR", 1669213, "626", "B767-3/R", 1000292],
        ["2024", "699", "A321nXLR", 1383179, "626", "B767-3/R", 1097623],
        ["2025", "699", "A321nXLR", 1234724, "626", "B767-3/R", 816064],
        ["2026", "699", "A321nXLR", 384870, "626", "B767-3/R", 249287],
      ] as const
    ).flatMap(([year, topCode, topLabel, topSeats, nextCode, nextLabel, nextSeats]) => [
      { month: `${year}-06`, code: topCode, label: topLabel, seats: topSeats, departures: 1 },
      {
        month: `${year}-06`,
        code: nextCode,
        label: nextLabel,
        seats: nextSeats,
        departures: 1,
      },
    ]);
    expect(findCrossover(jfkLax)).toBeNull();
  });
});

describe("a rival whose size cannot be stated blocks the claim", () => {
  // "B overtakes A in 2018" is a claim about which type was BIGGEST that year. A type whose every
  // filing that year was quarantined has an UNKNOWN total, so no other type can be shown to have
  // beaten it -- and ranking it last, or as 0, would emit an annotation resting on a number
  // nobody has. Same silent-pick the `/carrier/PA` split refuses, printed on a chart.
  //
  // MUTANT: `if (type.seats === null) continue;` (skip the unknowable rival instead of refusing)
  // -> 2019 gets a leader and the annotation appears -> red.
  // MUTANT: fold the year totals with `+=` instead of `addSum` -> the unknowable type totals 0,
  // is ruled out by the `<= 0` test, and the annotation appears for a fabricated reason -> red.
  it("names no crossover in a year holding an unstateable type", () => {
    const rows = [
      { month: "2018-01", code: "A", label: "A", seats: 100 },
      { month: "2018-02", code: "B", label: "B", seats: 50 },
      { month: "2019-01", code: "A", label: "A", seats: 50 },
      { month: "2019-02", code: "B", label: "B", seats: 100 },
      // The unstateable rival, in the year the crossover would otherwise be reported against.
      { month: "2019-03", code: "C", label: "C", seats: null },
    ];
    expect(findCrossover(rows)).toBeNull();
  });

  // The control: the identical data with C stateable and small still reports the crossover, so
  // the test above fails for the NULL and not for C's presence.
  it("still names the crossover when the same rival can be stated", () => {
    const rows = [
      { month: "2018-01", code: "A", label: "A", seats: 100 },
      { month: "2018-02", code: "B", label: "B", seats: 50 },
      { month: "2019-01", code: "A", label: "A", seats: 50 },
      { month: "2019-02", code: "B", label: "B", seats: 100 },
      { month: "2019-03", code: "C", label: "C", seats: 1 },
    ];
    expect(findCrossover(rows)).toEqual({ year: "2019", from: "A", to: "B" });
  });
});
