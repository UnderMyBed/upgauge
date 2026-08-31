import { describe, expect, it } from "vitest";
import { decodeRequest } from "@/lib/pivot/bounds";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { trailing12From } from "@/lib/entityFacts";
import { aircraftRecoveryHref, recoveryHref, recoveryQuery } from "@/lib/pivot/recovery";

/**
 * THE COVERAGE `bounds.test.ts` USED TO CARRY FOR EIGHT HAND-SPELLED LITERALS.
 *
 * That scan read `app/src/app` for `/explore?` literals and asserted the server still admits
 * each one. #140 moved those eight onto one constant, which is out of the scan's reach by
 * construction -- an interpolated href is skipped there deliberately -- so both halves of the
 * property it guaranteed are re-stated here instead: the exact bytes, and that those bytes decode.
 *
 * #145 then made the WINDOW derived rather than frozen, so "the exact bytes" is now stated as a
 * function of `asOf` rather than as one string. That is a strengthening, not a loosening: the
 * pins below fix the derivation at named months, so they stay green with no `data/` and no
 * `upgauge.duckdb` -- which is where the codec gates run -- while the LIVE window is pinned
 * separately, against the real warehouse, by `app/src/app/recoveryLink.callsites.test.tsx`.
 *
 * `FIXTURE`, not `loadAllowlist()`, for the reason `bounds.test.ts` uses it. The REAL catalog's
 * verdict on this same query is asserted separately, by `app/explore/page.test.tsx`'s "offers a
 * recovery query the server actually admits".
 *
 * WHAT THIS FILE CANNOT SEE, and the division is the whole point of #140: nothing here notices
 * one call site drifting to a DIFFERENT query that also decodes. That is
 * `app/src/app/recoveryLink.callsites.test.tsx`.
 */
describe("the recovery permalink", () => {
  // TWO MONTHS, AND BOTH ARE LOAD-BEARING -- this is the discrimination point of the whole fix.
  //
  // `2026-04` alone is satisfied by the frozen constant this replaced: it IS the string the app
  // shipped, so an implementation that ignores `asOf` and returns `t=2025-05:2026-04` passes it.
  // A fixture that exercises one of two asserted properties is the vacuous fixture wearing half a
  // disguise (CLAUDE.md), so the second month is what actually asserts the window MOVES, and the
  // first is what asserts the derivation still reproduces the value the product shipped.
  it("is the trailing 12 ending at asOf, and moves when asOf does", () => {
    expect(recoveryHref("2026-04")).toBe(
      "/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op",
    );
    expect(recoveryHref("2026-05")).toBe(
      "/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-06:2026-05&s=-seats&n=25&g=op",
    );
  });

  // THE WINDOW HAS ONE DEFINITION. A private `monthsBefore` copy here would be a fourth
  // computation of the trailing 12 in this repo, and an off-by-one in it is invisible on screen:
  // a 13-month "trailing 12" renders a perfectly plausible table. The January cases are the ones
  // a same-year fixture cannot see.
  it("takes its window from entityFacts's trailing12From, never a second computation", () => {
    for (const asOf of ["2026-05", "2026-01", "2020-07", "2015-12"]) {
      expect(recoveryQuery(asOf).timeFrom, `timeFrom at asOf=${asOf}`).toBe(trailing12From(asOf));
      expect(recoveryQuery(asOf).timeTo, `timeTo at asOf=${asOf}`).toBe(asOf);
    }
  });

  // `/aircraft`'s deliberate variant. Pinned in full: asserting only that it differs from the
  // base href would pass for any difference at all, including a broken one.
  it("has an aircraft-type variant differing in d and nothing else", () => {
    expect(aircraftRecoveryHref("2026-05")).toBe(
      "/explore?v=1&k=seg&d=aircraft_type&m=seats&t=2025-06:2026-05&s=-seats&n=25&g=op",
    );
    // The property that makes it a VARIANT rather than a second query: one key apart. Asserted at
    // an asOf of its own so a variant that froze its window while the base moved is red here.
    expect(aircraftRecoveryHref("2026-05").replace("d=aircraft_type", "d=op_airline_id")).toBe(
      recoveryHref("2026-05"),
    );
  });

  // The recovery link offered to someone whose permalink did not parse must itself parse. Both
  // hrefs, because a variant that stopped decoding would send `/aircraft`'s readers from one
  // error page straight to another.
  //
  // NOW SWEPT OVER A RANGE OF `asOf` VALUES, which a frozen constant never needed: the window is
  // computed per request, so admissibility is a property of the DERIVATION, not of one string.
  // `checkBounds` bounds `t` by YEAR against `maxValidYear()` (wall-clock, self-updating), and
  // `checkSpelling` refuses any `%` in `t` -- both of which a computed `YYYY-MM:YYYY-MM` satisfies
  // by construction, and neither of which is allowed to be assumed here.
  it("is admitted by the server's own bounds at every asOf the dataset can reach", () => {
    for (const asOf of ["2015-12", "2020-07", "2026-01", "2026-05", `${new Date().getUTCFullYear()}-12`]) {
      for (const href of [recoveryHref(asOf), aircraftRecoveryHref(asOf)]) {
        const qs = href.slice(href.indexOf("?") + 1);
        expect(() => decodeRequest(qs, FIXTURE), `recovery permalink: ${href}`).not.toThrow();
      }
    }
  });

  // The builder `/explore`'s error state seeds from this query renders its filter chips from a
  // `resolved` map the page hands it EMPTY. That is exact only while the query carries no filter
  // to resolve; a filter added here would render a chip with an unresolved id in it.
  it("carries no filter, which is what lets the error state's builder pass an empty resolver", () => {
    expect(recoveryQuery("2026-05").filters).toEqual([]);
  });
});
