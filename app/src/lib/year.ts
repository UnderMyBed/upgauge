/** `/airport/<code>?y=<year>` selects one calendar year's network instead of the page's
 * default trailing-12-month view (docs/design/system.md § The map). This file owns the three
 * things that view needs: parsing `y` into a closed outcome, the calendar-year window a valid
 * year maps to, and the track of year links the page renders under the map.
 *
 * `y` is NOT a slider (the design system originally specified an animated 2015->2026 slider,
 * "the one orchestrated motion moment" -- superseded on measurement: this map is
 * server-rendered SVG with no client charting library, so animating it means shipping every
 * year's geometry in one response. ORD's arcs alone are ~64,287 bytes for ONE year -- M7 Task
 * 8 -- so twelve years would be roughly a megabyte, doubled again because this project's
 * charts ship twice per response, body + RSC payload, docs/architecture/hosting.md § "The SVG
 * is emitted twice per response"). One server-rendered permalink per year is what the rest of
 * this product already does -- "URL-encoded query state on every view; permalinks are the
 * entire growth mechanic" -- and it works with JS off, like every other view here.
 *
 * `y`'s legitimate value set is CLOSED -- the calendar years this dataset actually covers --
 * which is exactly what makes validating it the right answer instead of `/search`'s blanket
 * `no-store`: `q` is unbounded free text with no set of correct answers to check against, so
 * there is nothing to validate it against; `y` has one. `proxy.ts` reads this file's verdict
 * to decide cacheability BEFORE the page runs (docs/architecture/hosting.md § "What proxy.ts
 * owns"), so `parseYear` is deliberately synchronous and touches no database -- it is a pure
 * structural/range check, safe to run on the request hot path with no query cost at all. */

/** The earliest year this dataset covers. Matches the `EARLIEST_MONTH = "2015-01"` constant
 * every entity page and /explore already hardcode (CLAUDE.md's Status section: "data/raw/
 * holds the full 2015-2026 window") -- not re-derived from the warehouse, because the
 * project-wide convention is already to hardcode this specific bound: BTS's earliest T-100
 * filing this pipeline ingests does not move forward with an ingest the way the LATEST month
 * does, so there is nothing for a future rebuild to silently disagree with here. */
export const EARLIEST_YEAR = 2015;

/** An upper bound for `parseYear`'s range check that is NOT the hardcoded "2026" the task
 * brief explicitly warns against (a fixed literal here would start rejecting a real, in-window
 * year the moment `dataAsOf()` crosses it, and nothing would fail loudly to say so). BTS files
 * after the fact, so the dataset's `data_as_of` can never be ahead of the wall-clock calendar --
 * "this real year" is therefore always at least as large as any year this dataset could
 * legitimately contain, and it advances on its own every January with no code change.
 * `parseYear` cannot ask `dataAsOf()` directly (that call is async; a database read on this
 * function's synchronous, pre-page-render path is exactly what the doc comment above rules
 * out), so wall-clock time is the only self-updating signal available to it.
 *
 * Exported for `lib/pivot/bounds.ts` (#52), which bounds `/explore`'s `t` to the same window
 * and needs this figure to STATE the range in its rejection message -- the range check itself
 * goes through `parseYear` below rather than re-deriving one. `y` on `/airport/:code` and `t`
 * on `/explore` are two spellings of one question, and one owner is what stops them
 * disagreeing about which months this dataset covers. */
export function maxValidYear(): number {
  return new Date().getUTCFullYear();
}

export type ParsedYear =
  | { kind: "default" }
  | { kind: "year"; year: number }
  | { kind: "invalid"; raw: string };

/** `null` (no `y` at all) is the page's own default, trailing-12-month view -- distinct from
 * `invalid`, which is a `y` that was PROVIDED and rejected. A four-digit numeral outside
 * `[EARLIEST_YEAR, maxValidYear()]`, and anything not a bare four-digit numeral at all
 * (`"nonsense"`, `"2019.5"`, `"20199"`), are both `invalid` -- the same outcome, so that
 * `?y=<anything the dataset doesn't recognize>` cannot mint a shared-cache entry
 * (`proxy.ts`'s cacheability predicate is `parseYear(y).kind !== "invalid"`, the allow-list
 * shape CLAUDE.md requires, never `!== "default"`, which would treat every rejected value as
 * cacheable by omission). */
export function parseYear(raw: string | null): ParsedYear {
  if (raw === null) return { kind: "default" };
  if (!/^\d{4}$/.test(raw)) return { kind: "invalid", raw };
  const year = Number(raw);
  if (year < EARLIEST_YEAR || year > maxValidYear()) return { kind: "invalid", raw };
  return { kind: "year", year };
}

/** The calendar-year window a valid year maps to -- plain `YYYY-01` -> `YYYY-12`, not clamped
 * to `dataAsOf()`. Clamping is the CALLER's job, not this function's: `yearWindow` is a pure
 * function of `year` alone (no `asOf` parameter -- matching the interface this file commits
 * to), and a query run over months past `asOf` simply returns no rows for them, the same
 * harmless "no filing yet" shape every other query in this app already handles. */
export function yearWindow(year: number): { from: string; to: string } {
  return { from: `${year}-01`, to: `${year}-12` };
}

/** One entry per calendar year from `EARLIEST_YEAR` through `asOf`'s own year, each marked
 * `partial` when it is NOT a complete Jan-Dec year in the data -- which is true for exactly one
 * year, the year `asOf` itself falls in, and only when `asOf`'s month is before December. A
 * `2026-04` `asOf` marks 2026 partial and every earlier year (2015-2025) complete: T-100 has
 * been filed continuously since 2015 (CLAUDE.md's Status section), so nothing before the
 * CURRENT year can be a partial year the way M6's "First appearance since 2015" bug proves this
 * project cannot assume without checking -- the check here IS the asOf-year comparison, not an
 * assumption. Presenting a four-month year identically to a twelve-month one is the same class
 * of false claim: "First appearance since 2015" told visitors about rows that had filed for
 * years; a 2026 tick with no partial marker would claim a full year that does not exist yet. */
export function yearTrack(asOf: string): { year: number; partial: boolean }[] {
  const [asOfYearStr, asOfMonthStr] = asOf.split("-");
  const asOfYear = Number(asOfYearStr);
  const asOfMonth = Number(asOfMonthStr);
  const track: { year: number; partial: boolean }[] = [];
  for (let year = EARLIEST_YEAR; year <= asOfYear; year++) {
    track.push({ year, partial: year === asOfYear && asOfMonth < 12 });
  }
  return track;
}
