import { headers } from "next/headers";
import { TopBar } from "@/components/TopBar";
import { dataAsOf, loadAllowlist } from "@/lib/db";
import type { Allowlist } from "@/lib/pivot/allowlist";
import {
  filterDimFromPath,
  filterListHref,
  filterableDimensions,
  setGrain,
} from "@/lib/pivot/builder";
import { decodeRequest } from "@/lib/pivot/bounds";
import { recoveryHref } from "@/lib/pivot/recovery";
import { GRAINS, type Grain, type PivotQuery } from "@/lib/pivot/types";
import { rawPathFromHeaders } from "@/lib/rawPath";
import { rawQueryFromHeaders } from "@/lib/rawQuery";

// DATA AS OF must never be frozen at build time, even on the 404 path -- the same reason the
// page carries this export. proxy.ts sets `no-store` on this response one level out.
export const dynamic = "force-dynamic";

/** One dimension this query COULD be filtered by, with the link that shows its values. */
interface Candidate {
  key: string;
  label: string;
  href: string;
}

/**
 * TWO DIFFERENT FINDINGS, AND THEY ARE NOT COLLAPSED.
 *
 * `wrongGrain` -- the slug names a real catalog dimension that this query's grain does not
 * carry (`aircraft_type` at `k=route`: T-100 files no aircraft type on a route-grain row). The
 * answer is a repair, not an apology, and the repair is `setGrain`, so the grain switch drags
 * the query's dimensions and filters along with it exactly as the builder's own control does.
 *
 * `unknown` -- the slug names nothing in the catalog. Different finding, different sentence, and
 * the candidates are listed for `/aircraft/CE-180`'s reason: a refusal that names nothing is a
 * dead end.
 */
type Outcome =
  | { kind: "wrongGrain"; slug: string; label: string; grain: string; at: string; href: string }
  | { kind: "unknown"; slug: string; candidates: Candidate[] }
  | { kind: "generic"; candidates: Candidate[] };

function candidatesFor(query: PivotQuery, allowlist: Allowlist): Candidate[] {
  return filterableDimensions(allowlist, query.grain).map((e) => ({
    key: e.key,
    label: e.label,
    href: filterListHref(query, e.key),
  }));
}

/** The grain at which `entry` IS offered, or null when it is offered at none -- which cannot
 *  happen for a catalog entry whose `grain` is a real grain or `both`, but is not asserted away:
 *  a catalog row with a typo'd grain degrades to the generic sentence rather than a broken link. */
function grainOffering(key: string, query: PivotQuery, allowlist: Allowlist): Grain | null {
  return GRAINS.find((g) => filterableDimensions(allowlist, g).some((e) => e.key === key)) ?? null;
}

/**
 * Re-running the resolution rather than receiving the page's result is forced by the framework:
 * `notFound()` takes no argument and `not-found.js` accepts no props, so there is no channel
 * between the two renders. Both request headers are read here for the same reason `/aircraft`'s
 * reads one: the slug is the whole content of the answer, and the query is what makes the
 * wrong-grain repair a link instead of an instruction.
 */
export async function outcomeFor(
  pathname: string,
  rawQuery: string,
  allowlist: Allowlist,
): Promise<Outcome> {
  const slug = filterDimFromPath(pathname);
  if (slug === null) return { kind: "generic", candidates: [] };

  let query: PivotQuery;
  try {
    query = decodeRequest(rawQuery, allowlist);
  } catch {
    // The permalink is unreadable, so the grain is unknown and no candidate link can be built.
    // The page still names the slug -- that half needs no query.
    return { kind: "unknown", slug, candidates: [] };
  }

  if (filterableDimensions(allowlist, query.grain).some((e) => e.key === slug)) {
    // Reachable only if the catalog changed between the page's render and this one. Not a
    // sentence about the slug, because there is no longer anything wrong with it.
    return { kind: "generic", candidates: candidatesFor(query, allowlist) };
  }

  const entry = allowlist.dims.get(slug);
  const at = entry === undefined ? null : grainOffering(slug, query, allowlist);
  if (entry !== undefined && at !== null) {
    return {
      kind: "wrongGrain",
      slug,
      label: entry.label,
      grain: query.grain,
      at,
      // `setGrain`, never a spread of `{ ...query, grain }`. Measured against TODAY's catalog
      // the two emit the same string for this direction -- every dimension is `both` or
      // `segment`, so there is no route-only one for a route->segment switch to drop, and every
      // route-valid filter is segment-valid. The helper is used anyway because dropping what the
      // new grain cannot carry is ITS job: a catalog that gains a route-only dimension must not
      // also need an edit here, and the spread is the shape that would quietly emit a dead link
      // when it does. What IS load-bearing today is the grain itself -- a spread that forgot it
      // would link this 404 straight back to itself.
      href: filterListHref(setGrain(query, at, allowlist), slug),
    };
  }
  return { kind: "unknown", slug, candidates: candidatesFor(query, allowlist) };
}

/** Matches `aircraft/[name]/not-found.tsx`'s structure (wrap > TopBar + main.error-page > h1 +
 *  p[role=alert] + candidates + a recovery link) so the two "this URL didn't work" pages read as
 *  one system, and takes its request-derived values as props so the whole page is renderable in
 *  a test without mocking a framework seam. */
export async function NotFoundView({
  pathname,
  rawQuery,
}: {
  pathname: string;
  rawQuery: string;
}) {
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();
  const outcome = await outcomeFor(pathname, rawQuery, allowlist);

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>
          {outcome.kind === "wrongGrain"
            ? "Not filed at this grain"
            : outcome.kind === "unknown"
              ? "No such dimension"
              : "Not a value list"}
        </h1>
        <p role="alert">
          {outcome.kind === "wrongGrain" ? (
            <>
              {outcome.label} (&lsquo;{outcome.slug}&rsquo;) is filed at {outcome.at} grain.
              This query is at {outcome.grain} grain, which carries no {outcome.label} to filter
              on.
            </>
          ) : outcome.kind === "unknown" ? (
            <>
              &lsquo;{outcome.slug}&rsquo; is not a dimension in this dataset&rsquo;s pivot
              catalog. Nothing was guessed from it.
            </>
          ) : (
            <>This is not a value list for any dimension.</>
          )}
        </p>
        {outcome.kind === "wrongGrain" ? (
          <p>
            <a href={outcome.href}>
              Switch this query to {outcome.at} grain and list {outcome.label}
            </a>
            . Dimensions and filters the new grain does not carry are dropped.
          </p>
        ) : null}
        {outcome.kind !== "wrongGrain" && outcome.candidates.length > 0 ? (
          <ul>
            {outcome.candidates.map((c) => (
              <li key={c.key}>
                <a href={c.href}>
                  {c.label} — {c.key}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <p>
          Start from{" "}
          <a href={recoveryHref(asOf)}>
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
  // Fails loudly if proxy.ts did not run, exactly as /explore and the four entity pages do.
  // NOTE for the proxy: `/explore/filter/:dim` must be in its matcher, or this throws and the
  // 404 loses its entire message -- see docs/architecture/hosting.md § "What omitting one
  // actually costs".
  return (
    <NotFoundView
      pathname={rawPathFromHeaders(requestHeaders)}
      rawQuery={rawQueryFromHeaders(requestHeaders)}
    />
  );
}
