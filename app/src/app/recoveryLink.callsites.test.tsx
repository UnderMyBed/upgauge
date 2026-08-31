// @vitest-environment jsdom
//
// EVERY DEAD-END SURFACE IN THE PRODUCT, PINNED ON THE RECOVERY PERMALINK IT OFFERS (#140).
//
// WHY THIS FILE EXISTS RATHER THAN NINE MORE PAGE ASSERTIONS. Eight surfaces spelled the same
// recovery permalink out by hand. `bounds.test.ts` scanned for those literals and asserted the
// server still ADMITTED each one -- a real guard, and blind to the failure that actually costs a
// reader something: one call site drifting to a DIFFERENT query that decodes perfectly well.
// Nothing looks wrong on such a page. The link works. It just no longer offers what the other
// seven offer, and the copy beside it -- "start from a known-valid query" -- stays true while the
// product stops having one answer to it.
//
// So the constant is asserted at every CALL SITE, not once at its definition. A call site is
// invisible to every test that does not look at THAT call site: `floorPartition.callsites.test.tsx`
// measured the same thing for `DataTable`'s partition prop, where adding the divergence to any of
// five sites left all 1,483 tests green.
//
// DIVISION OF LABOUR, and neither half substitutes for the other:
//
//   this file            a known site drifts to a different-but-still-valid query
//   bounds.test.ts       a NINTH hand-spelled literal appears (its count pin goes 1 -> 2), or
//                        one of these eight reverts to its byte-identical literal
//   recovery.test.ts     the constant itself is re-spelled, or stops decoding
//
// These are REAL renders of the REAL views against the REAL warehouse -- no mocks. Each view
// takes its request-derived value as a prop precisely so this is possible (`lib/rawPath.ts`).
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AIRCRAFT_RECOVERY_HREF, RECOVERY_HREF } from "@/lib/pivot/recovery";
import { SearchView } from "@/app/search/page";
import { ExploreView } from "@/app/explore/page";
import { FilterListView } from "@/app/explore/filter/[dim]/page";
import { NotFoundView as FilterNotFound } from "@/app/explore/filter/[dim]/not-found";
import { NotFoundView as RouteNotFound } from "@/app/route/[pair]/not-found";
import { NotFoundView as CarrierNotFound } from "@/app/carrier/[code]/not-found";
import { NotFoundView as AirportNotFound } from "@/app/airport/[code]/not-found";
import { NotFoundView as AircraftNotFound } from "@/app/aircraft/[name]/not-found";
import { NotFoundView as WatchNotFound } from "@/app/watch/[preset]/not-found";

const GOOD = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op";
const UNREADABLE = "v=1&k=seg&d=nope&m=seats&t=2025-05:2026-04&n=5&g=op";

/** Every Explorer-permalink href this render emitted, in document order.
 *
 *  ANTI-VACUITY IS IN HERE, not in each caller: a selector that stops matching -- a renamed
 *  class, an anchor turned into something else, a view that quietly stopped rendering its
 *  recovery paragraph -- must redden every case below rather than let each one pass on an empty
 *  array. `/explore/filter/:dim` hrefs are not permalinks and are excluded by the `?`. */
async function permalinksOf(view: Promise<React.ReactElement>): Promise<string[]> {
  const { container } = render(await view);
  const hrefs = [...container.querySelectorAll("a")]
    .map((a) => a.getAttribute("href") ?? "")
    .filter((h) => h.startsWith("/explore?"));
  expect(hrefs.length, "no Explorer permalink on this surface at all").toBeGreaterThan(0);
  return hrefs;
}

describe("every dead-end surface offers the one recovery permalink", () => {
  it("/search's no-match state", async () => {
    expect(await permalinksOf(SearchView({ q: "zzzznotarealthing9999" }))).toEqual([
      RECOVERY_HREF,
    ]);
  });

  it("/explore/filter/:dim's unreadable-permalink state", async () => {
    expect(
      await permalinksOf(FilterListView({ rawQuery: UNREADABLE, dim: "op_airline_id" })),
    ).toEqual([RECOVERY_HREF]);
  });

  it("/explore/filter/:dim's 404", async () => {
    expect(
      await permalinksOf(
        FilterNotFound({ pathname: "/explore/filter/not_a_dimension", rawQuery: GOOD }),
      ),
    ).toEqual([RECOVERY_HREF]);
  });

  it("/route's 404", async () => {
    expect(await permalinksOf(RouteNotFound({ pathname: "/route/ZZZZ-LAX" }))).toEqual([
      RECOVERY_HREF,
    ]);
  });

  it("/carrier's 404", async () => {
    expect(await permalinksOf(CarrierNotFound({ pathname: "/carrier/ZZ" }))).toEqual([
      RECOVERY_HREF,
    ]);
  });

  it("/airport's 404", async () => {
    expect(await permalinksOf(AirportNotFound({ pathname: "/airport/ZZZZ" }))).toEqual([
      RECOVERY_HREF,
    ]);
  });

  // THE BRANCH, NOT THE PAGE. `/watch/nope` renders the four-preset list and NO Explorer link at
  // all -- a fixture pointed there would assert nothing while looking like it asserted something.
  // The recovery paragraph is the null-slug branch, which a non-`/watch` path reaches.
  it("/watch's 404, on the branch that actually offers a way out", async () => {
    expect(await permalinksOf(WatchNotFound({ pathname: "/explore" }))).toEqual([RECOVERY_HREF]);
  });

  // `/aircraft` OFFERS ITS OWN VARIANT, AND THAT IS DELIBERATE (lib/pivot/recovery.ts): a reader
  // who reached an aircraft dead end is looking for a type, not a carrier. Asserted as ITSELF --
  // an assertion that merely found "some Explorer link" would pass for the base href, i.e. for
  // exactly the mutant that collapses the variant away.
  it("/aircraft's 404 offers the aircraft-type variant", async () => {
    expect(await permalinksOf(AircraftNotFound({ pathname: "/aircraft/NOPE-1" }))).toEqual([
      AIRCRAFT_RECOVERY_HREF,
    ]);
  });

  // The ambiguous slug, where the page carries per-candidate permalinks too. Those are a
  // different query by design -- each one filtered to one BTS code -- so this asserts the
  // recovery link is still there and still the variant, AND that the candidate links were not
  // swept into the constant along with it.
  it("/aircraft's ambiguous 404 keeps its candidate permalinks distinct from the recovery one", async () => {
    const hrefs = await permalinksOf(AircraftNotFound({ pathname: "/aircraft/CE-180" }));
    expect(hrefs.at(-1)).toBe(AIRCRAFT_RECOVERY_HREF);
    const candidates = hrefs.slice(0, -1);
    expect(candidates.length).toBe(2);
    for (const c of candidates) {
      expect(c).toContain("f=aircraft_type:");
      expect(c).not.toBe(AIRCRAFT_RECOVERY_HREF);
      expect(c).not.toBe(RECOVERY_HREF);
    }
  });

  // `/explore`'s own error state is the surface the other eight were copied from, so it belongs
  // in the matrix -- but its selector cannot be the shared one: the builder rendered beside the
  // escape link emits a permalink per chip, all of them legitimate. Scoped to the first anchor in
  // the error page, which is the escape link, exactly as `explore/page.test.tsx` reads it.
  it("/explore's unreadable-permalink state", async () => {
    const { container } = render(await ExploreView({ rawQuery: UNREADABLE }));
    const escape = container.querySelector(".error-page a");
    expect(escape, "no escape link on the error page").not.toBeNull();
    expect(escape!.getAttribute("href")).toBe(RECOVERY_HREF);
  });
});
