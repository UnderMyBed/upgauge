import type { PivotQuery } from "./pivot/types";
import type { PivotResult } from "./db";

/**
 * A SEAM FOR ROWS THE WAREHOUSE DOES NOT HAVE TO STILL BE CARRYING.
 *
 * Several rendering rules on the entity pages are about a SHAPE of result rather than a
 * subject: a group whose every filing was quarantined sums to NULL, and the page must render
 * absence, disclose the count, and withhold the legend groups that describe a chart or an arc
 * it never drew. Pinned to a live subject, such a fixture tests the rule only while some real
 * (airport | aircraft type | carrier x type) still has that shape INSIDE THE TRAILING 12 --
 * a window that moves every month, so the fixture stops exercising its path on a refresh and
 * nothing goes red at the moment it stops testing anything.
 *
 * Same argument, and the same answer, as `map/networkGolden.fixture.ts`: a constructed input
 * is the STRONGER guard, because it is stable across BTS refreshes.
 *
 * WHAT STAYS REAL, which is everything that is not the rows themselves. The stub runs the
 * REAL query first and keeps its `columns`, so a page that builds its table from
 * `result.columns` sees exactly the column list production hands it and a malformed synthetic
 * query fails here rather than rendering something no pivot could return. Ids in the
 * synthetic rows are resolved by the REAL `resolveRows` against the real dimension tables, so
 * the page renders carrier codes, not raw ids. Everything downstream of `runPivot` --
 * `toEndpointRows`' null handling, `sumColumn`, `classifyRouteRows`, `drawableRoutes`,
 * `quarantineClause`, `DataTable`, `LegendRail` -- is the production path, untouched. Only
 * the rows are constructed, which is the one thing a moving window can take away.
 *
 * FAIL LOUD IF THE FIXTURE NEVER FIRED: `hits` counts the queries the stub actually answered.
 * A test whose `answer` never matched is a test asserting against the live warehouse under a
 * synthetic name -- the vacuous fixture this mechanism exists to prevent -- so every test
 * here asserts its own hit count.
 */
export interface SyntheticPivot {
  /** Synthetic rows for the queries this test wants to answer; `null` runs the real query.
   *
   *  A ROW CARRIES ITS QUERY'S WHOLE COLUMN LIST, and the list is per QUERY, not per grain: the
   *  measures are whatever that query asked for (the derived pair appears only where a caller
   *  requested it), and `pivot_route.sql` emits no `quarantine_reasons` while
   *  `pivot_segment.sql` does -- so the two map queries, identical in dimension, differ in
   *  columns. Read the truth off `real.columns` (logging it is a three-line patch here) rather
   *  than copying a neighbouring fixture. A row missing a key renders the same as one carrying
   *  `null` today, which is exactly why the next test added to a describe inherits the defect
   *  instead of meeting it.
   *
   *  The COUNT columns are not free either. `quarantined_rows` and `active_months` are
   *  `count(...) FILTER` at segment grain (`sql/03_queries/pivot_segment.sql:40-44`) and, at
   *  route grain, a `sum` over those same counts (`pivot_route.sql:42-44`) -- neither can be
   *  NULL. `active_months` counts months with `NOT is_quarantined AND departures_performed > 0`,
   *  so over a wholly-quarantined group it is 0 and no other value is reachable. */
  answer: ((q: PivotQuery) => Record<string, unknown>[] | null) | null;
  /** How many queries `answer` replaced. Asserted by the test, never read by the page. */
  hits: number;
}

/** The `runPivot` a `vi.mock("@/lib/db")` factory installs: delegates to the real one and
 * substitutes rows only where the test says so. `quarantinedRowsOnPage` is recomputed by the
 * same expression `db.ts`'s own `runPivot` folds it with, over the substituted rows, because
 * a page reads that count off the result rather than off the rows it was handed.
 *
 * `resolveRows` is imported INSIDE the call, not at the top of this module, and it deadlocks
 * the whole run if it is not: `resolve.ts` imports `@/lib/db`, so a top-level import pulls the
 * mocked module back in from inside its own still-running factory. By call time the factory
 * has returned and the import resolves normally. */
export function syntheticRunPivot(
  actual: Pick<typeof import("./db"), "runPivot" | "loadAllowlist">,
  state: SyntheticPivot,
): (q: PivotQuery) => Promise<PivotResult> {
  return async (q: PivotQuery): Promise<PivotResult> => {
    const real = await actual.runPivot(q);
    const rows = state.answer === null ? null : state.answer(q);
    if (rows === null) return real;
    state.hits += 1;
    const { resolveRows } = await import("./resolve");
    return {
      columns: real.columns,
      rows,
      quarantinedRowsOnPage: rows.reduce((a, r) => a + Number(r.quarantined_rows ?? 0), 0),
      resolved: await resolveRows(rows, await actual.loadAllowlist()),
    };
  };
}
