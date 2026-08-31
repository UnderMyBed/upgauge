import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { dataAsOf } from "@/lib/db";
import { search, SEARCH_RESULT_CAP, type SearchGroup } from "@/lib/search";
import { formatCount } from "@/lib/format";
import { TopBar } from "@/components/TopBar";
import { recoveryHref } from "@/lib/pivot/recovery";

// Same reasoning as every other page here: this page's content depends on live warehouse
// state (dataAsOf(), and the resolution itself -- a code that's ambiguous today might not be
// tomorrow), so a statically cached /search would keep serving a stale DATA AS OF badge and
// stale resolutions forever.
export const dynamic = "force-dynamic";

// Search-result pages are the canonical thing crawlers are asked to skip (task brief, step
// 1f): the query space is unbounded, and every real answer already has its own canonical
// entity page for a crawler to index instead. `{ index: false }` renders
// `<meta name="robots" content="noindex">`. Static, not `generateMetadata` -- this does not
// depend on `q` or anything else request-derived, so there is nothing to resolve per request.
// Task 5 keeps this page out of the sitemap; Task 8 gives it `Disallow` in robots.txt and
// `no-store` on the response -- this file owns only the tag.
export const metadata: Metadata = { robots: { index: false } };

/** `q` was never typed -- not an error, and not the same as "no match" (`NoneState` below).
 * Renders what the omnibox actually searches, with one worked example per resolvable shape,
 * so a first-time visitor to `/search` with no query learns what to type rather than staring
 * at a blank panel. */
function EmptyBody() {
  return (
    <div className="empty-state">
      <p>
        Search resolves an airport code, a carrier code, an aircraft type, a route pair, or a
        name -- across airports, carriers, and aircraft types.
      </p>
      <ul>
        <li>
          Airport code -- <code>PDX</code>
        </li>
        <li>
          Carrier code -- <code>DL</code>
        </li>
        <li>
          Aircraft type -- <code>B737-8</code>
        </li>
        <li>
          Route pair -- <code>PDX-AUS</code>
        </li>
        <li>
          Name -- <code>Alaska</code>, <code>Portland</code>
        </li>
      </ul>
    </div>
  );
}

/** A well-formed query that matched nothing in any of the three namespaces. Names the query
 * and the namespaces checked -- CLAUDE.md's empty-result rule ("state the query in words,
 * never a blank panel") applied to free text instead of a pivot.
 *
 * `asOf` IS A PROP HERE, and it is the whole cost of #145 at this call site -- the only one of
 * the nine that did not already hold it. The recovery permalink's window is the trailing 12
 * ending at the dataset's newest month, so it needs the same `asOf` the top bar is already
 * stamped with; `SearchView` has it awaited two components up. Reading it again here would be a
 * second warehouse query on a page that has already answered "nothing matched".
 *
 * ONE template string for the alert sentence, not adjacent JSX text/expression children.
 * React's SSR emits `<!-- -->` between two adjacent TEXT-ish children with no element between
 * them, which would put comment markers inside the sentence in the served HTML -- every unit
 * test here still passes (`textContent` skips comment nodes) while a `grep`/`curl` check over
 * the served bytes would stop matching (CLAUDE.md, `/carrier`'s `grainNote`). Curly quotes are
 * literal Unicode characters, not `&lsquo;`/`&rsquo;` entities -- entities only decode in JSX
 * text, not inside a plain JS string. */
function NoneBody({ query, asOf }: { query: string; asOf: string }) {
  const sentence =
    `Nothing named, coded, or paired with ‘${query}’ -- checked airport codes, ` +
    "carrier codes, aircraft-type short names, route pairs, and names across all three.";
  return (
    <div className="error-page">
      <h1>No matches</h1>
      <p role="alert">{sentence}</p>
      <p>
        Start from <a href={recoveryHref(asOf)}>a known-valid query</a> in the Explorer instead.
      </p>
    </div>
  );
}

/** Take at most `cap` hits total ACROSS groups, in group order, preserving each group's own
 * relative order -- not `cap` per group. Slicing per group would let a query whose top hits
 * span three namespaces render 3x the disclosed cap; this keeps what's rendered and what
 * `truncated`'s cap-and-count disclosure describes the same set. Groups that lose every hit
 * to the cap are dropped rather than rendered with an empty list. */
function capGroups(groups: SearchGroup[], cap: number): SearchGroup[] {
  let remaining = cap;
  const out: SearchGroup[] = [];
  for (const g of groups) {
    if (remaining <= 0) break;
    const hits = g.hits.slice(0, remaining);
    remaining -= hits.length;
    out.push({ ...g, hits });
  }
  return out;
}

/** One or more matches -- either a genuine name-substring search, or the "a code named more
 * than one entity" collision `search.ts`'s `exactHits` refuses to pick a winner from (LNY,
 * NEW, WST are real, measured examples -- task brief step 1(b)). Both shapes render
 * identically: grouped by entity kind, in the RANKED order `search()` already computed --
 * never re-sorted here, so a collision's two groups keep whichever order made the guard fire
 * (airport before carrier, per `exactHits`) and a name search keeps step 1(d)'s
 * starts-with-first ranking. */
function ResultsBody({
  q,
  groups,
  truncated,
}: {
  q: string;
  groups: SearchGroup[];
  truncated: boolean;
}) {
  const total = groups.reduce((n, g) => n + g.hits.length, 0);
  const shown = capGroups(groups, SEARCH_RESULT_CAP);
  // ONE template string for the heading and the truncation footer, for the same reason as
  // NoneBody's sentence above -- both interpolate a value between two runs of literal text.
  const heading = `Results for ‘${q}’`;
  const truncatedNote =
    `Showing the first ${formatCount(SEARCH_RESULT_CAP)} of ${formatCount(total)} matches. ` +
    "Narrow the search to see the rest.";
  return (
    <div className="search-results">
      <h1>{heading}</h1>
      {shown.map((g) => (
        <section key={g.kind} className="search-group">
          <h2>{g.label}</h2>
          <ul>
            {g.hits.map((h) => (
              // `h.href` alone is not a unique key: aircraftExactHits' AmbiguousCodeError
              // path (lib/search.ts, CE-180's shape) gives two hits the SAME code and href --
              // both BTS codes 030/031 share the short name "CE-180" -- so `name` is the only
              // field that still tells them apart. Two candidates could in principle also
              // share a name, so the pair is what's actually unique, not `name` alone.
              <li key={`${h.href} ${h.name}`}>
                <a href={h.href}>
                  <code>{h.code}</code>
                </a>
                {` ${h.name}`}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {truncated && <p className="foot">{truncatedNote}</p>}
    </div>
  );
}

/** The page's whole render, taking the query as a plain string -- unlike `/explore` and
 * `/api/pivot`, `q` is free text with no delimiters this format needs to protect (task brief:
 * "a single free-text `q` has no such structure"), so this reads it from `searchParams` like
 * an ordinary Next.js page rather than through `proxy.ts`'s raw-header machinery. Split out
 * from the default export for the same reason every other view here is: a test can drive a
 * real, live-database render with a plain string, no framework seam to mock. */
export async function SearchView({ q }: { q: string }) {
  const asOf = await dataAsOf();
  const result = await search(q);

  if (result.kind === "redirect") {
    // Temporary (307), not `permanentRedirect`'s 308: unlike `/carrier/dl` -> `/carrier/DL`,
    // this is not a second spelling of one fixed canonical URL -- it is today's answer to a
    // free-text query, and a code that resolves uniquely today is not guaranteed to keep
    // doing so (task brief step 1(b) is exactly a case where a second namespace gaining a
    // colliding code would change the answer). A 307 also matches this page never being
    // cached (Task 8 gives `/search` `no-store`), where a 308 would invite a client to treat
    // the mapping as permanent regardless.
    redirect(result.to);
  }

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        {result.kind === "empty" ? (
          <EmptyBody />
        ) : result.kind === "none" ? (
          <NoneBody query={result.query} asOf={asOf} />
        ) : (
          <ResultsBody q={q} groups={result.groups} truncated={result.truncated} />
        )}
      </main>
    </div>
  );
}

/** Thin wrapper: the ONLY job here is reading `q` off `searchParams`. `TopBar`'s form
 * (Task 2) submits a plain `method="GET"` to `/search?q=...`, so `q` is always either absent,
 * a single string, or -- if someone hand-edits the URL to repeat the key -- an array; the last
 * case folds to its first element rather than being rejected, since a repeated free-text key
 * has no ambiguity worth a named error the way a repeated permalink key does on `/explore`.
 *
 * Calls `SearchView` directly rather than returning `<SearchView q={q} />`: this codebase's
 * tests render the result of `await SearchPage(...)` through react-dom's ordinary client
 * renderer, which -- unlike Next's RSC renderer -- cannot await a nested async component
 * reached via JSX, and cannot observe a `redirect()` thrown from inside one either (same note
 * as route/[pair]/page.tsx's `RoutePage`/`RouteView` split). Equivalent under Next's real
 * RSC rendering either way. */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = params.q;
  const q = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return await SearchView({ q });
}
