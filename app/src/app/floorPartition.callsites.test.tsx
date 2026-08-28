// @vitest-environment jsdom
//
// EVERY `DataTable` CALL SITE IN THE PRODUCT, PINNED ON THE ONE PROP THAT DECIDES THE FLOOR
// PARTITION (#127, review finding 1).
//
// WHY THIS FILE EXISTS RATHER THAN SIX MORE PAGE ASSERTIONS. `partition` defaults to true and
// `/explore` opts out, so it is a real axis, and a per-call-site `partition={false}` is invisible
// to every test that does not look at THAT call site -- measured: adding it to any of the five
// non-/airport partitioned sites left all 1,483 tests green.
//
// The obvious fix -- assert each page's rendered row order -- CANNOT WORK on three of them, and
// that is a property of the data, not of the test. A behavioural assertion can only distinguish
// partitioned from unpartitioned where some below-floor row out-seats some scored row, i.e.
// where the two orderings disagree. Measured across the whole trailing-12 warehouse, that is
// true for `/airport` and `/route` and for NO carrier's aircraft-type table, NO carrier's Top
// origin airports table, and NO aircraft type's carrier table: seats and departures correlate
// tightly enough within those groupings that the sparse rows are already last. Writing a
// row-order test there anyway would be the vacuous-fixture defect CLAUDE.md names -- it would
// pass against the bug, which is exactly what the first draft of this work did.
//
// So those call sites are pinned on the PROP instead: render the real page and read back what it
// actually handed the component. This is a pinned CALL SITE, not a pinned function -- it invokes
// the real caller and reads its output -- and it holds no matter what the data does. The
// behavioural proof that the prop MEANS something lives in DataTable.test.tsx and in the
// row-order tests on /airport and /route.
//
// It also generalises: this asserts over EVERY DataTable a page renders, so a seventh call site
// added to any of these pages is covered the day it appears rather than the day someone
// remembers to add a test for it.
import { describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({
  calls: [] as { partition: unknown; rank: unknown }[],
}));

vi.mock("@/components/DataTable", () => ({
  DataTable: (props: { partition?: unknown; rank?: unknown }) => {
    spy.calls.push({ partition: props.partition, rank: props.rank });
    return null;
  },
}));

vi.mock("next/headers", async () => {
  const { RAW_QUERY_HEADER } = await import("@/lib/rawQuery");
  return { headers: vi.fn(async () => new Headers({ [RAW_QUERY_HEADER]: "" })) };
});

import { render } from "@testing-library/react";
import { AirportView } from "@/app/airport/[code]/page";
import { CarrierView } from "@/app/carrier/[code]/page";
import { RouteView } from "@/app/route/[pair]/page";
import { AircraftView } from "@/app/aircraft/[name]/page";
import { ExploreView } from "@/app/explore/page";
import { resolveAirportCode } from "@/app/airport/[code]/resolveAirport";
import { resolveCarrier } from "@/lib/carrier";
import { resolveAircraftSlug } from "@/lib/aircraftSlug";

/** The `partition` prop of every DataTable the given view rendered, in render order. */
async function partitionsOf(view: () => Promise<React.ReactElement>): Promise<unknown[]> {
  spy.calls.length = 0;
  render(await view());
  return spy.calls.map((c) => c.partition);
}

async function airport(code: string) {
  const r = await resolveAirportCode(code);
  if (r.kind !== "ok") throw new Error(`expected ${code} to resolve`);
  return AirportView({ airport: r.airport });
}

async function carrier(code: string) {
  const r = await resolveCarrier(code);
  if (r.kind !== "ok") throw new Error(`expected ${code} to resolve`);
  return CarrierView({ carrier: r.carrier, filterValue: String(r.carrier.id) });
}

async function route(pair: [string, string]) {
  const [a, b] = pair;
  const lo = await resolveAirportCode(a);
  const hi = await resolveAirportCode(b);
  if (lo.kind !== "ok" || hi.kind !== "ok") throw new Error("expected both airports to resolve");
  return RouteView({
    low: lo.airport,
    high: hi.airport,
    canonical: `${a}-${b}`,
    filterValue: `${lo.airport.id}-${hi.airport.id}`,
  });
}

async function aircraft(slug: string) {
  const r = await resolveAircraftSlug(slug);
  if (r.kind !== "ok") throw new Error(`expected ${slug} to resolve`);
  return AircraftView({ type: r.type, canonical: r.canonical });
}

/** The rule, as a predicate: a partitioned call site passes `undefined` (taking the default) or
 * an explicit `true`. Anything else -- `false` -- is a surface that has silently left the rule. */
function partitioned(v: unknown): boolean {
  return v === undefined || v === true;
}

describe("every DataTable call site declares the floor partition it means", () => {
  it("/airport takes the partition", async () => {
    const ps = await partitionsOf(() => airport("STT"));
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every(partitioned)).toBe(true);
  });

  it("/route takes the partition", async () => {
    const ps = await partitionsOf(() => route(["MKE", "ORD"]));
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every(partitioned)).toBe(true);
  });

  it("/aircraft takes the partition", async () => {
    // MUTANT: `partition={false}` at aircraft/[name]/page.tsx's DataTable -> red here. No
    // row-order test can catch it: no aircraft type in the warehouse has a below-floor carrier
    // out-seating a scored one, so both orderings agree on every page this route can serve.
    const ps = await partitionsOf(() => aircraft("AS350-B2"));
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every(partitioned)).toBe(true);
  });

  it("/carrier takes the partition at ALL THREE of its tables", async () => {
    // The aircraft-type table and both Top-N tables, in one assertion over the whole set --
    // CLAUDE.md's enumerate-per-CALL-SITE rule, and the shape that caught a gate shipped on one
    // call site with its ungated twin one file over, inside one commit.
    //
    // MUTANT: `partition={false}` at ANY of the three -> red here. Only the Top routes table has
    // a row-order test that can also see it; the type table and Top origins have no
    // discriminating data anywhere in the warehouse.
    const ps = await partitionsOf(() => carrier("4W"));
    expect(ps.length).toBe(3);
    expect(ps.every(partitioned)).toBe(true);
  });

  it("/explore, and only /explore, declines it", async () => {
    // The exemption asserted as an exemption. Without this, deleting `partition={false}` from
    // explore/page.tsx is caught by exactly one test; with it, the intent is stated where the
    // rule for every other surface is stated, so the two cannot drift apart silently.
    const ps = await partitionsOf(() =>
      ExploreView({
        rawQuery: "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=5&g=op",
      }),
    );
    expect(ps).toEqual([false]);
  });
});
