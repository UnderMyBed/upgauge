# `app/` — the Upgauge server

Next.js 16 (App Router), TypeScript, Tailwind v4. Rendered server-side against
`upgauge.duckdb`, opened **read-only, in-process**. There is no database server and this app
never writes.

**Do not run `npm` here directly.** Every runtime is pinned in the repo root's `mise.toml`
and the Makefile shells through `mise exec`. Use the root targets:

| Command | What it does |
|---|---|
| `make dev` | Next dev server |
| `make app-check` | `tsc --noEmit` + `eslint` + `vitest run` |
| `make app-build` | Production build |
| `make app-smoke` | Build, serve, and curl real URLs — the only gate that catches production-only bugs |

## The tests need a built database

`db.test.ts`, `route.test.ts` and `page.test.tsx` all query the real `upgauge.duckdb` rather
than mocking it — deliberately, so the catalog and the SQL templates are exercised as shipped.
On a fresh clone that file does not exist yet and `make app-check` fails with a DuckDB open
error. Run `make ingest && make build` from the repo root first.

## Two things here are load-bearing and easy to delete by accident

- **`src/proxy.ts` + `skipProxyUrlNormalize` in `next.config.ts`.** They are one mechanism.
  Without them Next form-encodes the query string before any route sees it, and *every*
  filtered query fails on both `/explore` and `/api/pivot`. See
  [docs/architecture/hosting.md](../docs/architecture/hosting.md).
- **`serverExternalPackages` in `next.config.ts`.** `@duckdb/node-bindings` picks its native
  binding with a runtime `require` switch; without this the production build fails on every
  platform branch whose optional dependency isn't installed.

No unit test can catch a regression in either — both only manifest in a built, served app.
That is what `make app-smoke` is for.

## Fonts

`layout.tsx` uses IBM Plex Sans and IBM Plex Mono via `next/font/google`, self-hosted at
runtime (no request leaves the user's browser). Note the *build* still fetches them, so
`next build` needs network access to `fonts.googleapis.com`.
