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
 * moved from `span.mark` to `a.mark` (`Link` renders an `<a>` under the hood). */
export function Wordmark() {
  return (
    <Link className="mark" href="/">
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
