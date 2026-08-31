import { describe, expect, it } from "vitest";
import { decodeRequest } from "@/lib/pivot/bounds";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import {
  AIRCRAFT_RECOVERY_HREF,
  RECOVERY_HREF,
  RECOVERY_QUERY,
} from "@/lib/pivot/recovery";

/**
 * THE COVERAGE `bounds.test.ts` USED TO CARRY FOR EIGHT HAND-SPELLED LITERALS.
 *
 * That scan reads `app/src/app` for `/explore?` literals and asserts the server still admits
 * each one. #140 moved those eight onto one constant, which is out of the scan's reach by
 * construction -- an interpolated href is skipped there deliberately -- so both halves of the
 * property it guaranteed are re-stated here against the constant instead: the exact bytes, and
 * that those bytes decode.
 *
 * `FIXTURE`, not `loadAllowlist()`, for the reason `bounds.test.ts` uses it: this must stay
 * green in an environment with no `data/` and no `upgauge.duckdb`, which is where the codec
 * gates run. The REAL catalog's verdict on this same query is asserted separately, by
 * `app/explore/page.test.tsx`'s "offers a recovery query the server actually admits".
 *
 * WHAT THIS FILE CANNOT SEE, and the division is the whole point of #140: nothing here notices
 * one call site drifting to a DIFFERENT query that also decodes. That is
 * `app/src/app/recoveryLink.callsites.test.tsx`.
 */
describe("the recovery permalink", () => {
  // Pinned to the exact string, so a codec change or an edit to RECOVERY_QUERY is red HERE --
  // beside the constant -- rather than discovered as a dead recovery link by the one reader
  // who was already stuck when they were offered it.
  it("encodes to the string the app spelled by hand at eight call sites", () => {
    expect(RECOVERY_HREF).toBe(
      "/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op",
    );
  });

  // `/aircraft`'s deliberate variant. Pinned separately and in full: asserting only that it
  // differs from RECOVERY_HREF would pass for any difference at all, including a broken one.
  it("has an aircraft-type variant differing in d and nothing else", () => {
    expect(AIRCRAFT_RECOVERY_HREF).toBe(
      "/explore?v=1&k=seg&d=aircraft_type&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op",
    );
    // The property that makes it a VARIANT rather than a second query: one key apart.
    expect(AIRCRAFT_RECOVERY_HREF.replace("d=aircraft_type", "d=op_airline_id")).toBe(
      RECOVERY_HREF,
    );
  });

  // The recovery link offered to someone whose permalink did not parse must itself parse.
  // Both hrefs, because a variant that stopped decoding would send `/aircraft`'s readers from
  // one error page straight to another.
  it("is admitted by the server's own bounds", () => {
    for (const href of [RECOVERY_HREF, AIRCRAFT_RECOVERY_HREF]) {
      const qs = href.slice(href.indexOf("?") + 1);
      expect(() => decodeRequest(qs, FIXTURE), `recovery permalink: ${href}`).not.toThrow();
    }
  });

  // The builder `/explore`'s error state seeds from this query renders its filter chips from a
  // `resolved` map the page hands it EMPTY. That is exact only while the query carries no
  // filter to resolve; a filter added here would render a chip with an unresolved id in it.
  it("carries no filter, which is what lets the error state's builder pass an empty resolver", () => {
    expect(RECOVERY_QUERY.filters).toEqual([]);
  });
});
