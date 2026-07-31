/** The subset of `MixRow` (app/src/lib/chart/aircraftMix.ts) this module reads. Declared
 * structurally rather than imported so the annotation has no dependency on how the chart
 * series are built; a `MixRow[]` satisfies it. */
type CrossoverRow = {
  month: string;
  code: string;
  label: string;
  seats: number;
};

/** A change of the #1 aircraft type, named for the chart annotation:
 * `${to} overtakes ${from} · ${year}`. */
export type Crossover = {
  year: string;
  from: string;
  to: string;
};

type Leader = { code: string; label: string; seats: number };

/** The most recent year in which the #1 aircraft type by seats differs from the previous
 * year's, or `null` when there is no such year.
 *
 * `docs/design/system.md`: "Annotations must be derived, never hand-written. A hand-typed
 * annotation rots silently the first month the data moves." This is that derivation.
 *
 * **`null` is the common case, not an edge case.** Measured on the built database: only
 * 12,416 of 22,919 routes (54%) ever change their #1 type, and JFK-LAX -- the flagship
 * route -- is not one of them (the A321/LR leads every year 2015-2026, even as its share
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
    if (running) running.seats += seats;
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

/** The single largest type by seats, or `null` if the year is tied at the top or flew
 * nothing at all. */
function unambiguousLeader(types: Leader[]): Leader | null {
  let best: Leader | null = null;
  let tied = false;
  for (const type of types) {
    if (!best || type.seats > best.seats) {
      best = type;
      tied = false;
    } else if (type.seats === best.seats) {
      tied = true;
    }
  }
  if (!best || tied || best.seats <= 0) return null;
  return best;
}
