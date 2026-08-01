import Link from "next/link";
import { dataAsOf } from "@/lib/db";
import { PRESETS, presetBySlug } from "@/lib/watch";
import { TopBar } from "@/components/TopBar";

// Same reasoning as every other page in this product: DATA AS OF must never be frozen at
// build time.
export const dynamic = "force-dynamic";

/** The index: four presets, each with its editorial frame (system.md: "the only place on the
 * site with a voice") and a link into its own leaderboard. No table, no query, no DB read
 * beyond `dataAsOf()` -- the four presets themselves are a fixed, in-memory registry
 * (lib/watch.ts's `REGISTRY`), not warehouse state. */
export default async function WatchIndexPage() {
  const asOf = await dataAsOf();
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <h1>Gauge Watch</h1>
        {/* NOT "four saved Explorer queries" -- that sentence shipped here and in
            docs/product/features.md through M6, and M6's own headline correction (topn.ts,
            system.md, pipeline.md, CLAUDE.md) is that the presets CANNOT be Explorer queries:
            every meta_pivot_measures row is a single-window aggregate, no pivot measure
            expresses a delta, and these presets rank on deltas against the prior 12 months that
            only mart_route_health computes. The correction landed in six places and missed the
            one copy a visitor actually reads. What IS true is the second half: every row links
            back into the Explorer for the raw monthly rows behind it (rawRowsPermalink). */}
        <p className="frame watch-list-intro">
          Four leaderboards over the route-health mart, editorially framed. Not saved Explorer
          queries &mdash; these rank on year-over-year deltas, which no Explorer measure
          computes. Every row still links back into the Explorer for the raw monthly rows
          behind it.
        </p>
        <ul className="watch-list">
          {PRESETS.map((slug) => {
            const preset = presetBySlug(slug)!;
            return (
              <li key={slug}>
                <h2>
                  <Link href={`/watch/${slug}`}>{preset.title}</Link>
                </h2>
                <p>{preset.frame}</p>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
