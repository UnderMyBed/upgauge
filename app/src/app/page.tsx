import Link from "next/link";
import { dataAsOf } from "@/lib/db";
import { TopBar } from "@/components/TopBar";

// The front door reads its freshness from the data like every other view -- CLAUDE.md makes
// `DATA AS OF` a first-class element on every data view, and the lag is the credibility.
// Reading it is a request-time database call, so this page is dynamic for the same reason
// /explore is. It replaced the create-next-app scaffold, which shipped a Vercel logo, a
// "Deploy Now" link, utm_campaign=create-next-app URLs, and `dark:`/`bg-foreground` utility
// classes that stopped resolving when Task 3 deleted the dark block from globals.css.
export const dynamic = "force-dynamic";

// One real query, not a placeholder: the same permalink /explore's error page offers as its
// known-valid starting point, so the two can never drift into recommending different things.
const SAMPLE =
  "/explore?v=1&k=seg&d=op_airline_id&m=seats,departures_performed,load_factor,avg_gauge" +
  "&t=2025-05:2026-04&s=-seats&n=25&g=op";

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
          <a href={SAMPLE}>Open the Explorer</a> &mdash; the top 25 carriers by seats over the
          trailing 12 months, with the gauge rail and the reason-code gutter.
        </p>
        {/* Final whole-branch review (M6), Important #2: the front door linked only /explore,
            so /watch -- four leaderboards, the product's editorial surface -- was reachable
            only by typing its URL. TopBar carries the standing link on every page; this is the
            front door naming it in prose, where a first-time visitor is actually reading. */}
        {/* `Link`, not `<a>`, for the identical reason TopBar's wordmark is one:
            `@next/next/no-html-link-for-pages` fires on a statically-resolvable internal href
            (verified -- this shipped as an `<a>` and `make app-check` rejected it). The
            `SAMPLE` link above is a plain `<a>` only because its href is a computed constant
            the rule cannot statically resolve. `prefetch={false}` for the same cost reason:
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
