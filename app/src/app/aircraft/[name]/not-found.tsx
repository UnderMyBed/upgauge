import Link from "next/link";
import { headers } from "next/headers";
import { dataAsOf, runPivot } from "@/lib/db";
import { rawPathFromHeaders } from "@/lib/rawPath";
import { aircraftSlugFromPath, resolveAircraftSlug } from "@/lib/aircraftSlug";
import { encode } from "@/lib/pivot/urlstate";
import { AIRCRAFT_RECOVERY_HREF } from "@/lib/pivot/recovery";
import { displayValue, resolutionKey } from "@/lib/resolve";
import { TopBar } from "@/components/TopBar";

// Same reasoning as the page's own export of this constant: DATA AS OF must never be frozen at
// build time, even on the 404 path. proxy.ts sets `no-store` on this response for the same
// reason one level out, at the CDN.
export const dynamic = "force-dynamic";

const EARLIEST_MONTH = "2015-01";

/** One of the airframes a colliding slug names, with the permalink that CAN show it. */
interface Candidate {
  id: string;
  name: string;
}

type Outcome =
  | { kind: "reason"; slug: string; reason: string }
  | { kind: "ambiguous"; slug: string; candidates: Candidate[] }
  | { kind: "generic" };

/** The Explorer permalink for ONE BTS aircraft code. This is what makes the disambiguation
 * page a real answer rather than an apology: `/aircraft/CE-180` cannot resolve, but the
 * Explorer is keyed on the BTS code, so each airframe's rows are one click away. */
function candidateHref(id: string, asOf: string): string {
  return `/explore?${encode({
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats", "passengers", "departures_performed", "load_factor", "avg_gauge"],
    timeFrom: EARLIEST_MONTH,
    timeTo: asOf,
    filters: [["aircraft_type", [id]]],
    sort: "seats",
    sortDesc: true,
    limit: 50,
    grouping: "operating",
  })}`;
}

/** Why this slug is not an aircraft type, in `aircraftSlug.ts`'s own words.
 *
 * Re-running the resolution rather than receiving the page's result is forced by the framework:
 * `notFound()` takes no argument and `not-found.js` accepts no props, so there is no channel
 * between the two renders. It is one extra read of a dimension-sized table on a request that has
 * already decided it has nothing else to do.
 *
 * The ambiguous branch resolves the candidate CODES to their full designations through the
 * ordinary resolver -- no new SQL, and the same three-way display contract every other page
 * uses. 'CESSNA 180' and 'CESSNA 180A/B' is the whole content of the answer; a page that named
 * only '030' and '031' would be technically complete and practically useless. */
async function outcomeFor(pathname: string, asOf: string): Promise<Outcome> {
  const slug = aircraftSlugFromPath(pathname);
  if (slug === null) return { kind: "generic" };
  const resolved = await resolveAircraftSlug(slug);
  if (resolved.kind === "notFound") return { kind: "reason", slug, reason: resolved.reason };
  if (resolved.kind === "ambiguous") {
    // The resolver takes rows and reads the dimension's own column, so the ids are handed to it
    // in exactly the shape a pivot result would carry them -- as strings, never Number()-ed
    // (CLAUDE.md: '030' becomes 30 and the join breaks silently, which here would render two
    // candidates with no names at all).
    const names = await runPivot({
      grain: "segment",
      dimensions: ["aircraft_type"],
      measures: ["seats"],
      timeFrom: EARLIEST_MONTH,
      timeTo: asOf,
      filters: [["aircraft_type", resolved.ids]],
      sort: null,
      sortDesc: true,
      limit: resolved.ids.length,
      grouping: "operating",
    });
    return {
      kind: "ambiguous",
      slug: resolved.slug,
      // SORTED, not in the order the error carries them. AmbiguousCodeError preserves driver
      // row order by design (resolve.ts), which is the right thing for an error message and the
      // wrong thing for a rendered page: the same URL would list the two airframes in either
      // order across restarts. `code` is the only stable identity available, exactly as it is
      // for toBands' tiebreak.
      candidates: [...resolved.ids].sort().map((id) => ({
        id,
        // The resolver's `name`, not its `code`: the codes are what collided, so repeating
        // 'CE-180' twice would tell a reader nothing. Falls back to the id rather than a dash
        // -- absence of a name is not absence of data (lib/format.ts's opening rule).
        name:
          names.resolved.get(resolutionKey("aircraft_type", id))?.name ??
          displayValue(undefined, id),
      })),
    };
  }
  // A slug that resolves on the second call is unreachable in practice (this file only renders
  // because the page threw notFound() for it) but is not asserted away: it degrades to the
  // generic sentence rather than rendering an empty one.
  return { kind: "generic" };
}

/** Next's `not-found.js` convention: rendered when `notFound()` is thrown from a page in this
 * route segment. Matches route/[pair]/not-found.tsx's structure (wrap > TopBar + main.error-page
 * > h1 + p[role=alert] + a recovery link) so the two "this URL didn't work" pages read as one
 * system, and takes its one request-derived value as a prop so the whole page is renderable in a
 * test without mocking a framework seam.
 *
 * The ambiguous case is why this page carries more than a sentence. `/aircraft/CE-180` is a
 * REACHABLE URL whose honest answer is "this names two airframes and we will not pick one for
 * you" -- with both of them named and linked, or the refusal is just a dead end. */
export async function NotFoundView({ pathname }: { pathname: string }) {
  const asOf = await dataAsOf();
  const outcome = await outcomeFor(pathname, asOf);

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>
          {outcome.kind === "ambiguous" ? "More than one aircraft type" : "Aircraft type not found"}
        </h1>
        <p role="alert">
          {outcome.kind === "reason" ? (
            <>
              We can&rsquo;t show &lsquo;{outcome.slug}&rsquo;: {outcome.reason}.
            </>
          ) : outcome.kind === "ambiguous" ? (
            <>
              &lsquo;{outcome.slug}&rsquo; names more than one aircraft type in the BTS reference,
              and both of them really flew. We won&rsquo;t pick one for you.
            </>
          ) : (
            <>We don&rsquo;t recognize this page.</>
          )}
        </p>
        {outcome.kind === "ambiguous" ? (
          <ul>
            {outcome.candidates.map((c) => (
              <li key={c.id}>
                {`${c.name} — BTS aircraft type ${c.id}. `}
                <a href={candidateHref(c.id, asOf)}>See its rows in the Explorer</a>
              </li>
            ))}
          </ul>
        ) : null}
        <p>
          {/* eslint-plugin-next flags a literal <a href> against this dynamic route
              ([name]) as "use next/link instead"; the Explorer links above carry a query
              string and are not flagged.
              `prefetch={false}` is load-bearing here, not style -- TopBar.tsx's own note
              has the why in full, and prefetchPolicy.test.ts enforces it repo-wide. */}
          Try <Link href="/aircraft/B737-8" prefetch={false}>B737-8</Link>, or start from{" "}
          <a href={AIRCRAFT_RECOVERY_HREF}>
            the Explorer
          </a>
          .
        </p>
      </main>
    </div>
  );
}

export default async function NotFound() {
  const requestHeaders = await headers();
  // Fails loudly if proxy.ts did not run, exactly as /route and /explore do for their own
  // headers. There is deliberately no fallback: a 404 page that quietly stops naming the
  // offending slug, with every gate green, is the precise failure this header exists to make
  // impossible. NOTE for the proxy: `/aircraft/:name` must be in its matcher, or this throws.
  return <NotFoundView pathname={rawPathFromHeaders(requestHeaders)} />;
}
