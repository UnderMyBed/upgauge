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
        <p className="frame">
          Four saved Explorer queries, editorially framed. Every row links back into the
          Explorer with its filters already applied.
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
