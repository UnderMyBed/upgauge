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
                                      └─→ baked into container image
                                              │
                                      Next.js app (single deployable)
                                        - route handlers query DuckDB via @duckdb/node-api
                                        - all query logic lives in .sql files
                                              │
                                      Hetzner  ←  Cloudflare CDN (free tier)
```

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
| **Google Cloud Run** | **$0** at this traffic | container, scale-to-zero | **Strongest $0 option.** Free tier: 2M req + 180k vCPU-s + 360k GiB-s/mo. Container-based, so it *passes* the portability test. Cold start is the risk — a baked-in DuckDB file makes a fat image. Free tier is per-*account*, not per-project; `us-central1/east1/west1` only. |
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

`docker run` it locally against the same `.duckdb` file and it must behave identically.
Everything is Docker + Parquet + env vars. R2 is S3-compatible. **Do not build on
provider-specific runtimes** (Workers, D1, KV). This must stay a normal app.

> This constraint earned its keep: swapping the original Fly pick for Hetzner was a one-line
> change precisely because nothing depended on the provider.
