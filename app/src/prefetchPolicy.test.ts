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
 * WHY THIS IS A GATE AND NOT A PREFERENCE (#113, widened by #117). The edge rate limit
 * (`deploy/cloudflare/rate-limit.json`) matches all FOUR entity prefixes whole -- `/route/`,
 * `/airport/`, `/carrier/` and `/aircraft/`. `docs/architecture/hosting.md` § "What this does not
 * close" rests the affordability of that on a measured property: an entity page view is EXACTLY
 * ONE request against the 10-per-10s bucket, because `DataTable` emits a plain `<a href>` and
 * every asset the page pulls is under the excluded `/_next/`.
 *
 * #117 brought the most-shared page type inside the rule, so that property was RE-MEASURED on a
 * route page rather than extended by assumption. Served `/route/JFK-LAX`, 2026-08-27: 5
 * serialized `<Link>` refs against 5 `"prefetch":false` props -- 1:1, so none takes the default --
 * plus 10 `/_next/` assets and one `/favicon.ico`. One slot per view, the same arithmetic #113
 * rested on. A `<Link>` added to an entity page without `prefetch={false}` spends a second slot
 * per view and falsifies that argument -- silently, because nothing renders differently and no
 * existing test would go red. That is the regression this file exists to catch.
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
 * It is EMPTY, and keeping it that way is the point. `#113` landed it holding the three
 * `/watch` links its scope grant did not cover; integration closed them in the same pass, so the
 * rule is now absolute rather than absolute-except-for-a-list. An exemption list that outlives
 * the change which created it is one that grows.
 */
const KNOWN_PREFETCHING: string[] = [];

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

  it("leaves no <Link> on prefetch={false}'s default", () => {
    const prefetching = scan()
      .sites.filter((s) => !s.guarded)
      .map((s) => s.key)
      .sort();
    expect(prefetching).toEqual([...KNOWN_PREFETCHING].sort());
  });
});
