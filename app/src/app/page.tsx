import Link from "next/link";
import { dataAsOf } from "@/lib/db";
import { EARLIEST_MONTH, trailing12From } from "@/lib/entityFacts";
import { exploreHref } from "@/lib/pivot/builder";
import { maxMonth } from "@/lib/pivot/recovery";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";
import { TopBar } from "@/components/TopBar";

// The front door reads its freshness from the data like every other view -- CLAUDE.md makes
// `DATA AS OF` a first-class element on every data view, and the lag is the credibility.
// Reading it is a request-time database call, so this page is dynamic for the same reason
// /explore is. It replaced the create-next-app scaffold, which shipped a Vercel logo, a
// "Deploy Now" link, utm_campaign=create-next-app URLs, and `dark:`/`bg-foreground` utility
// classes that stopped resolving when Task 3 deleted the dark block from globals.css.
export const dynamic = "force-dynamic";

/** One real query, not a placeholder -- and DELIBERATELY NOT the recovery query the product's
 * dead ends offer (`lib/pivot/recovery.ts`). That one selects seats alone; this one selects four
 * measures, because the prose below promises the gauge rail and the reason-code gutter and a
 * single-measure query renders neither. The front door is a showcase, not an escape hatch, so the
 * two are allowed to differ -- an earlier note here claimed they were the same permalink, which
 * they have never been.
 *
 * DERIVED FROM `asOf`, NOT WRITTEN OUT (#145). This was the LAST hand-spelled permalink literal
 * under `app/src/app`, and it froze `t=2025-05:2026-04` in source directly beneath the sentence
 * that calls it "the top 25 carriers by seats over the trailing 12 months". The window stayed
 * admissible as BTS advanced, so nothing went red -- it just stopped being the trailing 12, and
 * the front door went on saying it was. Measured when this changed: `dataAsOf()` was `2026-05`,
 * so the link a first-time visitor clicked was already a month short of its own caption.
 *
 * `trailing12From` and `exploreHref`, never a local month subtraction or a hand-built
 * `/explore?...` -- the window and the permalink each have exactly one owner in this repo.
 *
 * Exported so `page.test.tsx` can pin the two properties this literal used to get from
 * `bounds.test.ts`'s hand-spelled-permalink scan -- the exact bytes, and that the server admits
 * them -- beside the query they describe. That scan is still there and still enforcing: it now
 * pins the EMPTY SET over all of `app/src`, so re-introducing a literal here (or anywhere) is red
 * without anyone updating a count. */
export function sampleQuery(asOf: string): PivotQuery {
  return normalizeQuery({
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats", "departures_performed", "load_factor", "avg_gauge"],
    // Floored for the reason recovery.ts states in full, and through ITS helper rather than a
    // second comparison: an `asOf` in the dataset's first year would otherwise put the front
    // door's own link outside the window the server admits.
    timeFrom: maxMonth(trailing12From(asOf), EARLIEST_MONTH),
    timeTo: asOf,
    filters: [],
    sort: "seats",
    sortDesc: true,
    limit: 25,
    grouping: "operating",
  });
}

export function sampleHref(asOf: string): string {
  return exploreHref(sampleQuery(asOf));
}

export default async function Home() {
  const asOf = await dataAsOf();
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>Is this route healthy, and what is the airline about to do to it?</h1>
        <p>
          A structural intelligence layer over US DOT / BTS T-100 Segment data. Not a flight
          search tool, not a fare tracker, not real-time &mdash; every number here is filed by
          the carrier that actually operated the metal, and every derived measure is computed
          at query time from summed numerators and denominators, never averaged.
        </p>
        <p>
          <a href={sampleHref(asOf)}>Open the Explorer</a> &mdash; the top 25 carriers by seats
          over the trailing 12 months, with the gauge rail and the reason-code gutter.
        </p>
        {/* Final whole-branch review (M6), Important #2: the front door linked only /explore,
            so /watch -- four leaderboards, the product's editorial surface -- was reachable
            only by typing its URL. TopBar carries the standing link on every page; this is the
            front door naming it in prose, where a first-time visitor is actually reading. */}
        {/* `Link`, not `<a>`, for the identical reason TopBar's wordmark is one:
            `@next/next/no-html-link-for-pages` fires on a statically-resolvable internal href
            (verified -- this shipped as an `<a>` and `make app-check` rejected it). The
            sample link above is a plain `<a>`; TopBar.tsx's note has the rule and why a
            query string is not what exempts it. `prefetch={false}` for the same cost reason:
            `/watch` is `force-dynamic` and queries `dataAsOf()` on every request. */}
        <p>
          <Link href="/watch" prefetch={false}>
            Gauge Watch
          </Link>{" "}
          &mdash; four leaderboards: which routes got a bigger plane this year, which are flying
          empty, which just came back, and which are in trouble on every axis at once.
        </p>
      </main>
    </div>
  );
}
