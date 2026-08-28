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
// A behavioural row-order test is the better instrument WHERE ONE CAN BE WRITTEN, and on two
// call sites one cannot. It can only distinguish partitioned from unpartitioned where the two
// orderings disagree -- where, in the pivot's own order, a SCORED row appears after a below-floor
// one. Re-swept over all 114 fact-present carriers and 110 aircraft short names through the real
// queries and limits:
//
//     CARRIER-TYPETABLE        6 below-floor rows over  4 pages -- 0 disagreements
//     CARRIER-TOPROUTES      141 below-floor rows over 24 pages -- 2 (2O, F4)
//     CARRIER-TOPORIGINS      85 below-floor rows over 22 pages -- 1 (F4)
//     AIRCRAFT-CARRIERTABLE    6 below-floor rows over  6 pages -- 0 disagreements
//
// So /airport, /route and BOTH of /carrier's Top-N tables carry row-order tests, and only the
// aircraft-type table and /aircraft's carrier table rest on this file alone.
//
// AN EARLIER REVISION OF THIS COMMENT CLAIMED Top origins was untestable too, and deleted a test
// on that basis. The claim came from a proxy -- "some below-floor row out-seats some scored one"
// -- which cannot see the case that actually occurs on `/carrier/F4`: `seats DESC` is NULLS LAST,
// so a scored row whose seats are NULL (every filing quarantined) sorts BELOW a below-floor row
// holding a stated 0. Zero does not out-seat NULL and the orderings disagree anyway. Asserting
// through a proxy that the buggy case also satisfies is this project's signature failure; it is
// written here rather than quietly corrected because the proxy is what was seductive.
//
// So those call sites are pinned on the PROP instead: render the real page and read back what it
// actually handed the component. This is a pinned CALL SITE, not a pinned function -- it invokes
// the real caller and reads its output -- and it holds no matter what the data does. The
// behavioural proof that the prop MEANS something lives in DataTable.test.tsx and in the
// row-order tests on /airport and /route.
//
// It also generalises: this asserts over EVERY DataTable each page below renders, so a further
// call site added to one of them is covered the day it appears rather than the day someone
// remembers to add a test for it. All eight in the product are here -- /airport, /route,
// /aircraft, /carrier x3, /watch and /explore.
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
import { WatchPresetView } from "@/app/watch/[preset]/page";
import { presetBySlug } from "@/lib/watch";
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
    // row-order test can catch it: on every one of the 110 aircraft short names the two orderings
    // agree, so this file is the only thing standing under this call site.
    const ps = await partitionsOf(() => aircraft("AS350-B2"));
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every(partitioned)).toBe(true);
  });

  it("/carrier takes the partition at ALL THREE of its tables", async () => {
    // The aircraft-type table and both Top-N tables, in one assertion over the whole set --
    // CLAUDE.md's enumerate-per-CALL-SITE rule, and the shape that caught a gate shipped on one
    // call site with its ungated twin one file over, inside one commit.
    //
    // MUTANT: `partition={false}` at ANY of the three -> red here. Both Top-N tables also carry
    // a row-order test of their own (carrier/[code]/page.test.tsx, on 2O and F4); the
    // aircraft-type table has no discriminating page in the warehouse and rests on this.
    const ps = await partitionsOf(() => carrier("4W"));
    expect(ps.length).toBe(3);
    expect(ps.every(partitioned)).toBe(true);
  });

  it("/watch takes the partition", async () => {
    // THE EIGHTH CALL SITE, which an earlier revision of this file's header claimed to cover
    // while having no entry for it. /watch is a structural no-op for the partition -- its rows
    // carry `t12_departures_performed` and never `departures_performed`, so no preset row ever
    // claims the floor -- but "the prop is unnecessary here" and "the prop is asserted here" are
    // different statements, and only the second survives someone adding a table.
    //
    // The props union already refuses `partition={false}` beside `rank`, so a future RANKED
    // table here cannot decline it. An UNRANKED one could, and that is the door this closes.
    const preset = presetBySlug("gauge");
    if (preset === null) throw new Error("expected the gauge preset to resolve");
    const ps = await partitionsOf(() => WatchPresetView({ preset }));
    expect(ps.length).toBeGreaterThan(0);
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
