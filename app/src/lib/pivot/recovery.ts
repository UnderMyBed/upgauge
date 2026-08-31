import { trailing12From } from "@/lib/entityFacts";
import { exploreHref } from "@/lib/pivot/builder";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";

/**
 * THE RECOVERY QUERY: the one known-valid Explorer permalink every dead-end surface offers.
 *
 * ONE DEFINITION, because nine surfaces spelled this same query out by hand -- `/search`'s
 * no-match state, `/explore`'s and `/explore/filter/:dim`'s unreadable-permalink states, and the
 * five 404s (`/route`, `/carrier`, `/airport`, `/aircraft`, `/watch`). Every one of them is shown
 * to a reader who has ALREADY hit a dead end, so a copy that drifts out of admissibility sends
 * them from one error to another -- and a copy that drifts into a DIFFERENT valid query is worse,
 * because nothing looks wrong. This product has already paid for that shape once: a correction
 * landed in six places and was left standing in the one sentence a visitor reads.
 *
 * A FUNCTION OF `asOf`, NOT A CONSTANT (#145), and this is the defect that forced the change
 * rather than a refactor for its own sake. These were module-load constants pinning
 * `t=2025-05:2026-04` in source. That window stays ADMISSIBLE as BTS advances -- it remains
 * inside the dataset's own window, so `checkBounds` never objects and no gate reddens -- while
 * silently ceasing to be **the trailing 12 months**, which is what the product calls it. Measured
 * when this was written: `dataAsOf()` was already `2026-05`, so the shipped recovery link was a
 * month stale on all nine surfaces and nothing anywhere was red.
 *
 * The window comes from `entityFacts.trailing12From` -- the SAME function every entity page and
 * every card already takes its trailing 12 from, never a private `monthsBefore` here. An
 * off-by-one in a fourth copy is invisible on screen: a 13-month "trailing 12" renders a
 * perfectly plausible table.
 *
 * WHY A PARAMETER AND NOT AN `await dataAsOf()` INSIDE. Every one of the nine call sites has
 * already awaited `dataAsOf()` before it renders -- it has to, because each one renders
 * `<TopBar asOf={...}>`, which this design system makes mandatory on a dead end. Reading it a
 * second time here would double the freshness query on exactly the surfaces that are already
 * failing, and `sql/03_queries/data_as_of.sql` forbids memoizing the caller (that read is also
 * `/api/health`'s only Parquet probe). It would also put a `throw` on a path whose entire job is
 * to avoid compounding an error the reader already hit. So the caller passes what it holds.
 *
 * WHERE THIS IS GUARDED, and the division is deliberate:
 *   - `recovery.test.ts` pins the DERIVATION at named months -- two of them, because one month
 *     alone is satisfied by the frozen constant this replaced -- and asserts the server admits
 *     the result across a range of `asOf`. No database, so it stays green in the codec gates.
 *   - `app/src/app/recoveryLink.callsites.test.tsx` renders every dead-end surface and asserts
 *     each one emits these hrefs at the LIVE `dataAsOf()` -- the guard both for one call site
 *     drifting to a different but still valid query, and for the window going stale again.
 */
export function recoveryQuery(asOf: string): PivotQuery {
  return normalizeQuery({
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats"],
    timeFrom: trailing12From(asOf),
    timeTo: asOf,
    // `sort: "seats"` with `sortDesc` -- i.e. `s=-seats` -- rather than a null sort: this is the
    // query offered to someone whose permalink did not parse, so every key it demonstrates should
    // be one they can see the effect of and edit. `filters: []` for the same reason, and because
    // `/explore`'s error state seeds its builder from this query with an empty `resolved` map,
    // which is exact only while there is no filter id to resolve.
    filters: [],
    sort: "seats",
    sortDesc: true,
    limit: 25,
    grouping: "operating",
  });
}

/** The permalink for `recoveryQuery(asOf)`. Through `exploreHref` -- never a second hand-spelled
 *  `` `/explore?${encode(q)}` `` -- because a private copy of that one line is the duplication the
 *  four entity pages already centralised away, and a future change to what a valid `/explore`
 *  permalink requires must reach every holder of this href. */
export function recoveryHref(asOf: string): string {
  return exploreHref(recoveryQuery(asOf));
}

/** `/aircraft`'s variant: the same recovery query grouped by aircraft type instead of carrier.
 *
 *  DELIBERATE, and derived rather than spelled out. The escape hatch from an aircraft dead end
 *  should land on aircraft types -- `/aircraft/CE-180` cannot resolve, and a reader who got there
 *  is looking for a type, not a carrier -- so this is not drift to be collapsed. Deriving it from
 *  `recoveryQuery` is what keeps the divergence to the ONE key it is about: a change to the
 *  window, the limit, the sort or the measure reaches this href automatically, and only `d`
 *  differs. `recoveryLink.callsites.test.tsx` asserts `/aircraft` emits THIS href specifically,
 *  not merely some Explorer link, so a mutant collapsing it to `recoveryHref` is red. */
export function aircraftRecoveryHref(asOf: string): string {
  return exploreHref(normalizeQuery({ ...recoveryQuery(asOf), dimensions: ["aircraft_type"] }));
}
