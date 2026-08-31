import { exploreHref } from "@/lib/pivot/builder";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";

/**
 * THE RECOVERY QUERY: the one known-valid Explorer permalink every dead-end surface offers.
 *
 * ONE CONSTANT, because eight surfaces spelled this same query out by hand -- `/search`'s no-match
 * state, `/explore`'s and `/explore/filter/:dim`'s unreadable-permalink states, and the five 404s
 * (`/route`, `/carrier`, `/airport`, `/aircraft`, `/watch`). Every one of them is shown to a
 * reader who has ALREADY hit a dead end, so a copy that drifts out of admissibility sends them
 * from one error to another -- and a copy that drifts into a DIFFERENT valid query is worse,
 * because nothing looks wrong. This product has already paid for that shape once: a correction
 * landed in six places and was left standing in the one sentence a visitor reads.
 *
 * `sort: "seats"` with `sortDesc` -- i.e. `s=-seats` -- rather than a null sort: this is the query
 * offered to someone whose permalink did not parse, so every key it demonstrates should be one
 * they can see the effect of and edit. `filters: []` for the same reason, and because
 * `/explore`'s error state seeds its builder from this constant with an empty `resolved` map,
 * which is exact only while there is no filter id to resolve.
 *
 * WHERE THIS IS GUARDED, and the division is deliberate:
 *   - `recovery.test.ts` pins both hrefs to their exact strings and asserts the server ADMITS
 *     them, so a codec change or an edit here is red beside the constant.
 *   - `app/src/app/recoveryLink.callsites.test.tsx` renders every dead-end surface and asserts
 *     each one emits exactly these hrefs -- the guard for one call site drifting to a different
 *     but still valid query, which no admissibility check can see.
 *   - `lib/pivot/bounds.test.ts` scans `app/src/app` for hand-spelled permalink literals and
 *     pins how many remain, so a NINTH copy appearing is red rather than silent.
 */
export const RECOVERY_QUERY: PivotQuery = normalizeQuery({
  grain: "segment",
  dimensions: ["op_airline_id"],
  measures: ["seats"],
  timeFrom: "2025-05",
  timeTo: "2026-04",
  filters: [],
  sort: "seats",
  sortDesc: true,
  limit: 25,
  grouping: "operating",
});

/** The permalink for `RECOVERY_QUERY`, built once. Through `exploreHref` -- never a second
 *  hand-spelled `` `/explore?${encode(q)}` `` -- because a private copy of that one line is the
 *  duplication the four entity pages already centralised away, and a future change to what a
 *  valid `/explore` permalink requires must reach every holder of this href. */
export const RECOVERY_HREF = exploreHref(RECOVERY_QUERY);

/** `/aircraft`'s variant: the same recovery query grouped by aircraft type instead of carrier.
 *
 *  DELIBERATE, and derived rather than spelled out. The escape hatch from an aircraft dead end
 *  should land on aircraft types -- `/aircraft/CE-180` cannot resolve, and a reader who got there
 *  is looking for a type, not a carrier -- so this is not drift to be collapsed. Deriving it from
 *  `RECOVERY_QUERY` is what keeps the divergence to the ONE key it is about: a change to the
 *  window, the limit, the sort or the measure reaches this href automatically, and only `d`
 *  differs. `recoveryLink.callsites.test.tsx` asserts `/aircraft` emits THIS href specifically,
 *  not merely some Explorer link, so a mutant collapsing it to `RECOVERY_HREF` is red. */
export const AIRCRAFT_RECOVERY_HREF = exploreHref(
  normalizeQuery({ ...RECOVERY_QUERY, dimensions: ["aircraft_type"] }),
);
