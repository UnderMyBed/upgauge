import { addSum } from "@/lib/nullSum";

/** The subset of `MixRow` (app/src/lib/chart/aircraftMix.ts) this module reads. Declared
 * structurally rather than imported so the annotation has no dependency on how the chart
 * series are built; a `MixRow[]` satisfies it. */
type CrossoverRow = {
  month: string;
  code: string;
  label: string;
  /** NULL when every filing behind this cell was quarantined -- see `MixRow.seats`. */
  seats: number | null;
};

/** A change of the #1 aircraft type, named for the chart annotation:
 * `${to} overtakes ${from} · ${year}`. */
export type Crossover = {
  year: string;
  from: string;
  to: string;
};

type Leader = { code: string; label: string; seats: number | null };

/** The most recent year in which the #1 aircraft type by seats differs from the previous
 * year's, or `null` when there is no such year.
 *
 * `docs/design/system.md`: "Annotations must be derived, never hand-written. A hand-typed
 * annotation rots silently the first month the data moves." This is that derivation.
 *
 * **`null` is an ordinary outcome, not an edge case.** The predicate is this function's own --
 * the #1 type by seats in a year differs from the previous LED year's -- and the POPULATION is
 * the routes that reach it. `prepareMixPlot` returns early on `!mixChartDraws(rows)`, so a
 * route whose chart does not draw never calls this at all, and sizing the null branch against
 * all 22,635 routes understates it by more than half. Measured on the built database over the
 * full window, of the 16,345 routes whose chart draws,
 * 12,193 carry an annotation and 4,152 (25.4%) do not
 * -- JFK-LAX among them: the A321nXLR leads that route every year 2015-2026, even as its
 * share of the route's seats falls, which is a real upgauge story but not a crossover. This
 * function must never manufacture an annotation, and must never fall back to naming the
 * largest type: that is not an event, it would appear on every chart, and it would teach
 * readers to ignore annotations.
 *
 * Two rules decide what counts as a leader, both of which suppress annotations that would
 * otherwise flap or mislead:
 *
 * - **A tie has no leader.** Breaking a tie by input order, code, or label would emit an
 *   annotation whose direction depends on nothing the reader can see, and would flip when
 *   the row order changed.
 * - **A leader must have flown.** T-100 carries ordinary no-service filings with `seats =
 *   0` (CLAUDE.md, data gotchas); a year in which nothing flew has no dominant type.
 *
 * A year with no leader is skipped, not treated as a wall: A leading, then a tied year, then
 * B leading is a genuine crossover -- it is what one looks like mid-transition -- and is
 * reported against the later year, the one B actually leads. */
export function findCrossover(rows: readonly CrossoverRow[]): Crossover | null {
  const led = leadersByYear(rows);

  // Walk backwards from the most recent led year: the FIRST difference found is the most
  // recent crossover, so multiple crossovers resolve to the latest without scanning on.
  for (let i = led.length - 1; i > 0; i--) {
    const [year, leader] = led[i];
    const previous = led[i - 1][1];
    if (leader.code !== previous.code) {
      return { year, from: previous.label, to: leader.label };
    }
  }
  return null;
}

/** Years that have an unambiguous #1 type, ascending. Years without one are absent. */
function leadersByYear(rows: readonly CrossoverRow[]): [string, Leader][] {
  const totals = new Map<string, Map<string, Leader>>();
  for (const { month, code, label, seats } of rows) {
    const year = month.slice(0, 4);
    let types = totals.get(year);
    if (!types) totals.set(year, (types = new Map()));
    const running = types.get(code);
    // `addSum`, not `+=` (#121): `null + 5` is `5`, so a running total on `+` would report a
    // type whose every cell was quarantined as having flown 0 seats -- and then rule it out as
    // a leader by the `<= 0` test below, which is the right answer reached from a fabricated
    // fact. The two must stay distinguishable, because an UNKNOWN size cannot be ruled out.
    if (running) running.seats = addSum(running.seats, seats);
    else types.set(code, { code, label, seats });
  }

  const led: [string, Leader][] = [];
  // Sorted by year, not taken in arrival order: nothing in the contract says the pivot rows
  // reach us chronologically, and reading them out of order silently mislabels which
  // crossover is the most recent.
  for (const year of [...totals.keys()].sort()) {
    const leader = unambiguousLeader([...totals.get(year)!.values()]);
    if (leader) led.push([year, leader]);
  }
  return led;
}

/** The single largest type by seats, or `null` if the year is tied at the top, flew nothing at
 * all, or contains a type whose size cannot be stated.
 *
 * THE THIRD REFUSAL IS #121's, and it is the same refusal as the other two. A type whose every
 * filing that year was quarantined has an UNKNOWN total, not a small one, so no other type can
 * be shown to have beaten it -- and "B overtakes A in 2018" is a claim about which type was
 * biggest. Ranking the unknowable one last (or, worse, as 0) would emit an annotation whose
 * direction rests on a number nobody has. This is the same silent-pick the `/carrier/PA` split
 * exists to refuse, in a sentence printed on the chart.
 *
 * A year with no leader is SKIPPED, not treated as a wall (see findCrossover), so this degrades
 * to naming the crossover from the years that CAN be ranked rather than to no annotation at all.
 * MEASURED AT YEAR x TYPE GRAIN, which is the grain this function refuses at: a type's WHOLE-YEAR
 * total must be null, i.e. every cell it filed that year was quarantined. That is a strictly
 * smaller set than "pairs carrying an unstateable cell" (778 cells / 305 pairs), and quoting the
 * cell figure here would be measuring a different question -- the refusal fires on **215 pairs
 * across 273 pair-years** of 23,167.
 *
 * WHAT A READER ACTUALLY SEES CHANGE is smaller again, because most refused years were never the
 * year the annotation named: the rendered annotation differs on **18 pairs** -- 6 lose it, 12
 * move year or direction. `ATL-MCO`, whose `B757-2 overtakes A321nXLR · 2018` `app/smoke.sh`
 * pins, carries no such year and is unmoved. */
function unambiguousLeader(types: Leader[]): Leader | null {
  let best: Leader | null = null;
  let tied = false;
  for (const type of types) {
    if (type.seats === null) return null;
    if (best === null || best.seats === null || type.seats > best.seats) {
      best = type;
      tied = false;
    } else if (type.seats === best.seats) {
      tied = true;
    }
  }
  if (!best || best.seats === null || tied || best.seats <= 0) return null;
  return best;
}
