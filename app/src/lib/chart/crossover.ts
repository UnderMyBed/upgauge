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
 * **`null` is the common case, not an edge case.** Measured on the built database: only
 * 12,416 of 22,919 routes (54%) ever change their #1 type, and JFK-LAX -- the flagship
 * route -- is not one of them (the A321nXLR leads every year 2015-2026, even as its share
 * falls 44.8% -> 35.2%, which is a real upgauge story but not a crossover). So the caller
 * renders no annotation at all on nearly half of routes. This function must never
 * manufacture one, and must never fall back to naming the largest type: that is not an
 * event, it would appear on every chart, and it would teach readers to ignore annotations.
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
 * Measured: 302 route pairs carry such a cell, across 503 pair-years, out of 23,041 pairs --
 * and ATL-MCO, whose annotation `app/smoke.sh` pins, carries none. */
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
