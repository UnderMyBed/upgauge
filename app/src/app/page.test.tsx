// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import Home, { sampleHref, sampleQuery } from "@/app/page";
import { dataAsOf } from "@/lib/db";
import { decodeRequest } from "@/lib/pivot/bounds";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { recoveryHref } from "@/lib/pivot/recovery";
import { EARLIEST_MONTH, trailing12From } from "@/lib/entityFacts";

/**
 * THE FRONT DOOR'S SAMPLE PERMALINK (#145), AND THE COVERAGE THIS FILE INHERITED.
 *
 * `bounds.test.ts` scans for hand-spelled `/explore?` literals, pins how many remain, and used to
 * assert the server still admitted each one. #140 took that count from nine to one; this change
 * takes it to zero, because the last literal was this page's SAMPLE -- and it carried the same
 * frozen `t=2025-05:2026-04` the recovery query did, under the one sentence a first-time visitor
 * actually reads: "the top 25 carriers by seats over the trailing 12 months".
 *
 * THAT SCAN IS STILL THERE, now pinning the EMPTY SET over all of `app/src` -- an emptiness
 * assertion is falsifiable (add a literal and it fails), so it keeps catching a NEW one, which is
 * the half no per-query test can cover. What did go is its ADMISSIBILITY loop, which over an empty
 * corpus iterated nothing. That half is re-stated HERE, beside the query it describes: the exact
 * bytes, and that those bytes decode. `FIXTURE`, not `loadAllowlist()`, for the reason
 * `bounds.test.ts` used it -- the codec half must not need a warehouse.
 */
describe("the front door's Explorer sample", () => {
  // TWO MONTHS, for `recovery.test.ts`'s reason: `2026-04` alone is the string this page shipped,
  // so a frozen implementation passes it. The second month is what asserts the window MOVES.
  it("is the trailing 12 ending at asOf, and moves when asOf does", () => {
    expect(sampleHref("2026-04")).toBe(
      "/explore?v=1&k=seg&d=op_airline_id&m=seats,departures_performed,load_factor,avg_gauge" +
        "&t=2025-05:2026-04&s=-seats&n=25&g=op",
    );
    expect(sampleHref("2026-05")).toBe(
      "/explore?v=1&k=seg&d=op_airline_id&m=seats,departures_performed,load_factor,avg_gauge" +
        "&t=2025-06:2026-05&s=-seats&n=25&g=op",
    );
  });

  // The other half of the deleted scan: the app must not serve a permalink the app refuses. Swept
  // over a range of `asOf` rather than asserted once, because the window is now computed per
  // request -- admissibility is a property of the derivation, not of one string.
  it("is admitted by the server's own bounds at every asOf the dataset can reach", () => {
    for (const asOf of ["2015-12", "2020-07", "2026-01", "2026-05", `${new Date().getUTCFullYear()}-12`]) {
      const href = sampleHref(asOf);
      expect(() => decodeRequest(href.slice(href.indexOf("?") + 1), FIXTURE), href).not.toThrow();
    }
  });

  // WHAT MAKES IT A SHOWCASE RATHER THAN AN ESCAPE HATCH, and the property a sweep would quietly
  // delete. The prose beside this link promises the gauge rail and the reason-code gutter; the
  // recovery query selects `m=seats` alone and renders neither. A mutant collapsing SAMPLE onto
  // `recoveryHref` produces a working link under a sentence that has stopped being true, which is
  // exactly the class of failure nothing looks wrong for.
  it("selects the four measures its own prose promises, unlike the recovery query", () => {
    expect(sampleQuery("2026-05").measures).toEqual([
      "seats",
      "departures_performed",
      "load_factor",
      "avg_gauge",
    ]);
    expect(sampleHref("2026-05")).not.toBe(recoveryHref("2026-05"));
  });

  // The same floor the recovery query has, for the same reason and one surface earlier: this is
  // the link on the FRONT DOOR, so a window off the front of the dataset would 500 the first
  // thing a visitor clicks. `sampleQuery` and `recoveryQuery` share the floor, not a copy of it.
  it("never offers a window before the dataset starts, however early asOf is", () => {
    for (const asOf of ["2015-01", "2015-06", "2015-11"]) {
      expect(sampleQuery(asOf).timeFrom, `asOf=${asOf}`).toBe(EARLIEST_MONTH);
      const href = sampleHref(asOf);
      expect(() => decodeRequest(href.slice(href.indexOf("?") + 1), FIXTURE), href).not.toThrow();
    }
  });

  // THE LIVE HALF, against the real warehouse: the rendered page's own link, not the helper's
  // return value re-derived. This is the assertion that was FALSE before this change -- the served
  // href ended 2026-04 against a dataset whose newest month is later.
  it("renders a link whose window really is the live trailing 12", async () => {
    const asOf = await dataAsOf();
    const { container } = render(await Home());
    const href = [...container.querySelectorAll("a")]
      .map((a) => a.getAttribute("href") ?? "")
      .find((h) => h.startsWith("/explore?"));
    expect(href, "no Explorer link on the front door at all").toBeDefined();
    expect(href).toContain(`t=${trailing12From(asOf)}:${asOf}`);
  });
});
