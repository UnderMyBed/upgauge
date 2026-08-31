import Link from "next/link";

/** docs/design/mockups/table.html's `.mark`: "UP" in `--ink`, "GAUGE" in `--signal`. Exported
 * so a page that only wants the wordmark (none exist today, but the split matches the other
 * shared components in this directory) is not forced to render the search form and the
 * `DATA AS OF` badge to get it.
 *
 * Final whole-branch review, F5: a link back to the front door, not a bare `<span>` -- once a
 * visitor lands on any entity page (which is most of the product's reachable set) there was
 * previously no way back at all. `next/link`'s `Link`, not a plain `<a>`
 * (`@next/next/no-html-link-for-pages` -- an internal `<a href="/">` bypasses Next's router
 * and forces a full page reload): `Link` still renders as a real `<a href="/">` in the served
 * HTML and works with JS off (app/AGENTS.md), the same as everywhere else in this product;
 * only client-side transitions are extra, not required. `.mark` keeps its own CSS class
 * regardless of tag, so `globals.css` needs no change; only its selector in the existing test
 * moved from `span.mark` to `a.mark` (`Link` renders an `<a>` under the hood).
 *
 * `prefetch={false}` is LOAD-BEARING, not a micro-optimisation. `Link`'s default (`auto`)
 * prefetches when the link enters the viewport, in production. This wordmark is above the fold
 * on every page, and the CDN cannot absorb that prefetch -- NOT because `/` is uncached (it is in
 * `proxy.ts`'s matcher and gets `HTML_CACHE`), but because `proxy.ts` answers ANY request carrying
 * the `RSC` header `no-store`, unconditionally. A prefetch is such a request, so it always reaches
 * the origin: the default would add one uncached origin request per page view, on a single
 * always-on box whose entire cost control is the caching (CLAUDE.md, "the caching is the cost
 * control, not the hosting tier").
 *
 * Internal links here are plain `<a>` by default; this one is a `Link` because
 * `@next/next/no-html-link-for-pages` fires on a LITERAL internal href, which `href="/"` is. The
 * rule strips the query before matching (`utils/url.js`), so a query string exempts nothing --
 * what it never inspects is an href built from an expression (`href.value.type !== 'Literal'`
 * returns early). Found by M5's final re-review; the mechanism corrected in #145. */
export function Wordmark() {
  return (
    <Link className="mark" href="/" prefetch={false}>
      UP<span className="accent">GAUGE</span>
    </Link>
  );
}

/** The chrome every page in the product shares: the wordmark, the `DATA AS OF` badge -- a
 * first-class element in the accent colour on every data view (CLAUDE.md) -- and the
 * site-wide search field M5 adds.
 *
 * Extracted from **ten** copy-pasted bodies: nine identical `function TopBar({ asOf })`
 * definitions (explore, route × 2, airport × 2, carrier × 2, aircraft × 2 -- the page and the
 * not-found for each entity) plus `app/page.tsx`'s inline `<div className="top">…</div>`,
 * which rendered the identical markup without going through a named `TopBar` function at all.
 * All ten were byte-identical (diffed before writing this component, not assumed) -- see
 * `task-2-report.md` for the diff. `layout.tsx` is a bare `<html>/<body>` shell with no
 * chrome, so this lives in `components/`, not the layout: the search field needs exactly one
 * home, or it drifts across ten call sites the way the rest of this markup already had.
 *
 * The form is a plain `method="GET"` submission to `/search?q=…` (Task 4) -- **no
 * `"use client"`, no `onChange`, no state.** Every other view in this product renders and
 * works with JavaScript off (app/AGENTS.md; the pivot permalinks, the entity pages' error
 * states, all of it is server-rendered HTML), and the search box is not the one place that
 * gets to require a script to submit. */
export function TopBar({ asOf }: { asOf: string }) {
  return (
    <div className="top">
      <Wordmark />
      {/* Final whole-branch review (M6), Important #2: `/watch` shipped with ZERO inbound
          internal links -- reachable only by typing the URL or through /sitemap.xml, which is
          exactly the "crawlable but not browsable" island M5's own final review named
          (docs/product/features.md § the two links outside the tables) and M6 re-created one
          milestone later. The top bar is the strongest available fix because it is the one
          surface every page in the product renders; a home-page link alone would leave every
          entity page still dead-ended.

          `Link` with `prefetch={false}`, for exactly the two reasons the wordmark above states:
          `@next/next/no-html-link-for-pages` fires on a statically-resolvable internal `<a>`,
          and `Link`'s default viewport prefetch would add an origin request per page view for
          a link that is above the fold on all eleven pages. `/watch` is `force-dynamic` and
          runs a `dataAsOf()` query on every request.

          The label is "Watch", not "Gauge Watch": the latter is BOTH the /watch index's own
          <h1> AND the title of the `gauge` preset, so a nav item carrying it made
          `screen.getByText("Gauge Watch")` ambiguous in two existing tests -- a real signal
          that the label was ambiguous for a reader too, not just for a query. */}
      <nav className="nav">
        <Link href="/watch" prefetch={false}>
          Watch
        </Link>
      </nav>
      <form className="search" method="GET" action="/search" role="search">
        <input
          type="search"
          name="q"
          placeholder="Search carriers, airports, routes, aircraft"
          aria-label="Search carriers, airports, routes, aircraft"
        />
        <button type="submit">Search</button>
      </form>
      <span className="asof">DATA AS OF {asOf}</span>
    </div>
  );
}
