import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No `next/link` `<Link>` in `app/src` renders without `prefetch={false}`.
 *
 * `Link`'s default is `auto`, which in a PRODUCTION build prefetches when the link enters the
 * viewport. Every one of those prefetches is an origin request: `proxy.ts` answers any request
 * carrying the `RSC` header `no-store`, unconditionally, so a prefetch is never served from the
 * CDN and always reaches the box (proxy.ts, § "The cost, accepted deliberately"). One unguarded
 * `<Link>` above the fold is therefore one extra DuckDB-backed render per page view.
 *
 * WHY THIS IS A GATE AND NOT A PREFERENCE (#113). The edge rate limit
 * (`deploy/cloudflare/rate-limit.json`) now matches `/airport/`, `/carrier/` and `/aircraft/`
 * whole. `docs/architecture/hosting.md` § "What this does not close" rests the affordability of
 * that widening on a measured property: an entity page view is EXACTLY ONE request against the
 * 10-per-10s bucket, because `DataTable` emits a plain `<a href>` and every asset the page pulls
 * is under the excluded `/_next/`. A `<Link>` added to an entity page without `prefetch={false}`
 * spends a second slot per view and falsifies that argument -- silently, because nothing renders
 * differently and no existing test would go red. That is the regression this file exists to catch.
 *
 * Read off the SOURCE, not the DOM. `prefetch` is a `Link` prop and leaves no attribute on the
 * rendered `<a>`, so rendering cannot tell a guarded link from an unguarded one
 * (`components/TopBar.test.tsx` records the same finding for its own two links).
 *
 * SCOPE, stated so it is not mistaken for more than it is: this scans `.tsx` files that import
 * from `next/link`, and matches an opening `<Link ...>` tag by reading to its first `>`. A prop
 * whose expression CONTAINS a `>` (an inline arrow function, a generic) would truncate that match
 * -- so the first test below counts `<Link` occurrences independently and fails on any
 * discrepancy rather than silently under-reporting. It does not see a `Link` aliased to another
 * name on import, nor one rendered through a wrapper component. Neither exists here today; if
 * either starts to, this gate needs widening rather than trusting.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sites that still take `Link`'s prefetching default. This is an EXACT list, not an allow-list:
 * the assertion is set equality, so fixing one of these without deleting its line here is just as
 * red as adding a new unguarded `<Link>`. It may only ever shrink.
 *
 * All three are on `/watch` paths, which the edge rate limit does NOT match -- so they cost an
 * origin render per view (the `proxy.ts` reasoning above) but do not spend a rate-limit slot.
 * They are UNFIXED, not exempt, and they are listed rather than quietly excluded so that the
 * count is visible to anyone reading this file. #113 did not have a scope grant covering
 * `app/src/app/watch/`.
 */
const KNOWN_PREFETCHING = [
  "app/watch/[preset]/not-found.tsx :: <Link href={`/watch/${s}`}>",
  'app/watch/[preset]/not-found.tsx :: <Link href="/watch/gauge">',
  "app/watch/page.tsx :: <Link href={`/watch/${slug}`}>",
];

type LinkSite = { key: string; guarded: boolean };

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith(".tsx") && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

function scan(): { sites: LinkSite[]; parseGaps: string[] } {
  const sites: LinkSite[] = [];
  const parseGaps: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const rel = path.relative(SRC, file);
    const text = readFileSync(file, "utf8");
    if (!/from "next\/link"/.test(text)) continue;
    const opens = [...text.matchAll(/<Link\b[^>]*>/g)];
    const occurrences = (text.match(/<Link\b/g) ?? []).length;
    if (opens.length !== occurrences) {
      parseGaps.push(`${rel}: ${occurrences} <Link occurrences, ${opens.length} parsed`);
    }
    for (const m of opens) {
      sites.push({ key: `${rel} :: ${m[0]}`, guarded: m[0].includes("prefetch={false}") });
    }
  }
  return { sites, parseGaps };
}

describe("every next/link <Link> opts out of prefetching", () => {
  it("parses every <Link> it can see, and sees at least one", () => {
    // Both halves are vacuity guards. Without the count check, a prop containing `>` would
    // truncate a match and hide an unguarded link; without `toBeGreaterThan(0)`, a scanner that
    // silently found nothing would pass the assertion below the moment KNOWN_PREFETCHING empties.
    const { sites, parseGaps } = scan();
    expect(parseGaps).toEqual([]);
    expect(sites.length).toBeGreaterThan(0);
  });

  it("leaves no <Link> on prefetch={false}'s default beyond the known-unfixed three", () => {
    const prefetching = scan()
      .sites.filter((s) => !s.guarded)
      .map((s) => s.key)
      .sort();
    expect(prefetching).toEqual([...KNOWN_PREFETCHING].sort());
  });
});
