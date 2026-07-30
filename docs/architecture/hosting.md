# Architecture & hosting

## The fact that makes this nearly free

**This is a read-only dataset that changes once a month. There are no writes, ever.** So you
never need a database *server*. That single realization is worth ~$25/mo.

## Shape

```
GitHub Actions (monthly cron)
  └─ Python ingest ──→ Parquet ──→ build upgauge.duckdb
                                      │
                                      ├─→ Cloudflare R2 (artifact storage)
                                      └─→ upgauge.duckdb + data/parquet/, both baked
                                              │            into the container image
                                      Next.js app (single deployable)
                                        - route handlers query DuckDB via @duckdb/node-api
                                        - all query logic lives in .sql files
                                              │
                                      Hetzner  ←  Cloudflare CDN (free tier)
```

> The `.duckdb` file is a thin catalog of views over *relative* `data/parquet/` paths, not
> a database that carries its own data — see [Portability test](#portability-test) below.

**Single Next.js deployable.** No separate API service — one container, one box, one deploy.
Python exists only in the ingest pipeline, which runs in CI, never in prod.

**Query logic lives in `.sql` files, never in Python or TS string literals.** This lets the
Python pipeline and the TS server share definitions, and keeps a future DuckDB-WASM port
possible.

## Cost

| Item | Cost |
|---|---|
| Ingest — GitHub Actions monthly cron | $0 |
| Artifacts — Cloudflare R2 (10GB + zero egress on free tier) | $0 |
| App — **Hetzner CX22-class, 2 vCPU / 4GB, always-on** | ~€4/mo |
| CDN + DNS — Cloudflare free tier | $0 |
| Domain — subdomain of owned `shipman.dev` | $0 |
| **Total** | **~€4/mo** |

> Confirm Hetzner's exact current price in their console before relying on it — published
> third-party figures for the same box ranged **€3.79–€4.59** as of 2026-07, and there was an
> April 2026 price change. The ranking below doesn't change across that range; the number
> does.

---

## Why this box — the survey

Two criteria decide it, and neither is price. **DuckDB aggregation wants RAM** (1–2 GB per
thread), and **cold starts land on shared links** — the growth mechanic is someone clicking a
pasted URL, so a sleeping box is a product problem, not a latency nit.

Surveyed 2026-07:

| Option | Cost | Resources | Assessment |
|---|---|---|---|
| **Hetzner CX22 / CX23** | **~€3.79–4.59/mo** | 2 vCPU / 4GB / 40GB NVMe / 20TB | **Chosen.** Best RAM-per-euro from a reputable host. Always-on, no cold start. |
| **Google Cloud Run** | **$0** at this traffic | container, scale-to-zero | **Strongest $0 option.** Free tier: 2M req + 180k vCPU-s + 360k GiB-s/mo. Container-based, so it *passes* the portability test. Cold start is the risk — a baked-in image is fat, and as of the M2 catalog-over-Parquet shape it's `data/parquet/` (96 MB over the full 2015–2026 window as of M3a Task 1, was 26 MB at 2015–2017; not the thin `.duckdb` catalog file) driving that image size. Free tier is per-*account*, not per-project; `us-central1/east1/west1` only. |
| **Self-host + Cloudflare Tunnel** | **$0** | whatever you own | Underrated: `cloudflared` is free and unlimited, needs no open ports or static IP, and the domain is already required to be on Cloudflare, so it composes. Trades cash for home uptime/power/ISP risk. |
| Contabo VPS 10 | ~€4.50/mo | 8GB | Most RAM per euro found. Weaker reliability reputation — the tradeoff is real. |
| Oracle Cloud Always Free | $0 | ARM Ampere A1 | Free-tier A1 cut to 2 OCPU / 12GB in June 2026; reclamation risk. Fine as a $0 mirror, not the only copy. |
| Netcup | ~€3.35/mo | 2 vCPU / 2GB | Cheapest entry, but 2GB is already too small. |
| Fly.io 1GB | $5.70/mo | 1 vCPU / 1GB | The original pick. *More* than Hetzner, no free tier for new orgs, and 1GB spills to disk on Explorer group-bys. |
| Fly.io 2GB | $10.70/mo | 1 vCPU / 2GB | Sizing up to a still-marginal 2GB makes Fly the most expensive option surveyed. |
| Render Starter | $7/mo | shared CPU | Always-on. Free tier sleeps after 15 min idle — disqualifying for shared links. |
| Railway Hobby | $5/mo + usage | usage-billed | No permanent free tier as of 2026. No advantage over Hetzner. |
| Linode / Vultr | ~$5/mo (1GB) | 1GB entry | ~$12 at 2GB, ~$24 at 4GB. Far worse RAM-per-dollar. |
| AWS Lightsail | ~$10/mo entry | — | No advantage at any tier. |
| Koyeb | $0 (2 nano services) | nano | Too small for DuckDB. |
| Cloudflare Containers | $5/mo (needs Workers Paid) | usage-billed | Not cheaper, and provider-specific — fails the portability test. |
| Cloudflare Pages, fully static | $0 | — | Blocked by a **20,000 files/site** cap on free (100k paid), and DuckDB-WASM is a ~33MB binary with known feature-parity gaps. |

**If $0 matters more than hands-off operation**, the honest ranking is Cloud Run, then
self-host + Tunnel. Both are legitimately free at this traffic and neither compromises
portability. Measure Cloud Run's cold start with the real image before committing.

**A hybrid stays available:** prerender the finite entity sets (airports ~1k, carriers ~100,
aircraft types ~200) as static, keep the server for route pages and the Explorer. An
optimization, not a v0 requirement.

---

## Public from day one — what that commits us to

- **Host at `upgauge.shipman.dev`** — a subdomain of an already-owned domain, so no purchase
  for v0. The subdomain must sit **behind Cloudflare (proxied / "orange cloud")**: point it
  at the app host (CNAME + provisioned cert) with Cloudflare in front. If `shipman.dev`'s
  nameservers aren't already on Cloudflare, either move them or use a partial (CNAME) setup
  — the free CDN in front is what makes the numbers work.
- **Basic rate limiting** at the Cloudflare edge (free tier) on the API routes — enough to
  stop a scraper from waking the box constantly. No app-level auth.
- **Nothing private ever goes in it.** All data is public DOT filings; keep it that way.

## The actual cost control is caching, not the tier

Data changes monthly. Every response gets:

```
Cache-Control: public, s-maxage=2592000, stale-while-revalidate=86400
```

With Cloudflare's free tier in front, near-zero repeat traffic touches the box.
**Precompute all leaderboards as static JSON at build time.**

## Avoid

- Managed Postgres (~$20+/mo, pointless — no writes)
- Mapbox tiles (usage-priced; Natural Earth GeoJSON instead)
- Always-on Redis
- Vercel, if traffic spikes (bandwidth pricing bites)

## Portability test

**The deployable artifact is `upgauge.duckdb` *plus* `data/parquet/` (96 MB, measured
`du -sh data/parquet` over the full 2015–2026 window after M3a Task 1's rebuild — was 26 MB
on the 2015–2017 window measured at M2), not the `.duckdb` file alone.** As built, the catalog is views over
*relative* Parquet paths — it carries almost no data itself — so it behaves identically
under `docker run` only if `data/parquet/` is co-located with it and `WORKDIR` is the
directory containing `data/`. Get that wrong and the container still starts and the file
still opens; every query then fails with a "no files found" read error. Full detail,
including a confirmed repro of that exact failure: [pipeline.md § Views cannot take bound
parameters](pipeline.md#views-cannot-take-bound-parameters--so-cwd-is-load-bearing).

`docker run` it locally against the same `.duckdb` file + `data/parquet/` and it must
behave identically. Everything is Docker + Parquet + env vars. R2 is S3-compatible. **Do
not build on provider-specific runtimes** (Workers, D1, KV). This must stay a normal app.

> This constraint earned its keep: swapping the original Fly pick for Hetzner was a one-line
> change precisely because nothing depended on the provider.

## Environment variables

The server (`app/src/lib/db.ts`) reads two. Both are optional — production sets neither and
gets the defaults below, which are what the Portability test and the WORKDIR contract
assume.

| Var | Default | What it's for | What breaks if it's wrong |
|---|---|---|---|
| `UPGAUGE_ROOT` | `process.cwd()` | The directory containing `data/` and `sql/` — anchors both `upgauge.duckdb`'s default location and every `.sql` file read (`sql/03_queries/*.sql`). Also passed to DuckDB as `file_search_path`, so the catalog's relative Parquet globs (`read_parquet('data/parquet/...')`) resolve against it regardless of the process's actual OS working directory. | Set to the wrong directory: every `.sql` file read fails with ENOENT, and every query against a Parquet-backed view fails with `IO Error: No files found that match the pattern "data/parquet/..."` — the exact failure the Portability test section above describes, just triggered by a bad env var instead of a bad `WORKDIR`. |
| `UPGAUGE_DB` | `${UPGAUGE_ROOT}/upgauge.duckdb` | Overrides the `.duckdb` file path directly, independent of `UPGAUGE_ROOT` — for a deploy that keeps the database file somewhere other than the repo-root default (e.g. a mounted volume). | Set to a path that doesn't exist or isn't a valid DuckDB file: `DuckDBInstance.create()` rejects and every route handler 500s. Note this does NOT relocate `data/parquet/` — that's still resolved via `UPGAUGE_ROOT`'s `file_search_path`, so pointing `UPGAUGE_DB` at a database file whose Parquet tree lives elsewhere still needs `UPGAUGE_ROOT` set to match. |

Neither is a substitute for the WORKDIR contract — they exist so the default (WORKDIR ==
repo root, both vars unset) needs no configuration, while still giving an operator an escape
hatch if a deploy's directory layout genuinely can't match it.
