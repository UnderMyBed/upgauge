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
| App — **Hetzner `cx23`, 2 vCPU / 4GB, always-on** | $6.49/mo |
| IPv4 address — **required, see below** | $0.60/mo |
| CDN + DNS — Cloudflare free tier | $0 |
| Domain — subdomain of owned `shipman.dev` | $0 |
| **Total** | **$7.09/mo** |

Measured in the Hetzner console 2026-08-19, in USD. The account holds a $25 credit ≈ **3.5
months**; revisit before it runs out.

> **The IPv4 is not optional.** `ghcr.io` publishes no AAAA record and Hetzner provides no
> NAT64/DNS64 — measured on an IPv6-only `cx23` in `nbg1`: `dig AAAA ghcr.io` against
> `2a01:4ff:ff00::add:1` returns nothing while `deb.debian.org` returns a real address through
> the same resolver, and `curl -6 https://ghcr.io/v2/` fails with "Could not resolve host". An
> IPv6-only box can never pull the image.

---

## Why this box — the survey

Two criteria decide it, and neither is price. **DuckDB aggregation wants RAM** (1–2 GB per
thread), and **cold starts land on shared links** — the growth mechanic is someone clicking a
pasted URL, so a sleeping box is a product problem, not a latency nit.

Surveyed 2026-07. The Hetzner row was re-measured 2026-08-19 in USD when the box was
actually bought; the rest are as surveyed, so compare currencies before re-ranking.

| Option | Cost | Resources | Assessment |
|---|---|---|---|
| **Hetzner `cx23`** | **$6.49/mo** (+$0.60 IPv4) | 2 vCPU / 4GB / 40GB NVMe / 20TB | **Chosen.** Best RAM-per-dollar from a reputable host. Always-on, no cold start. EU regions only; the nearest US equivalent, `cpx21`, is $37.49/mo. |
| **Google Cloud Run** | **$0** at this traffic | container, scale-to-zero | **Strongest $0 option.** Free tier: 2M req + 180k vCPU-s + 360k GiB-s/mo. Container-based, so it *passes* the portability test. Cold start is the risk — a baked-in image is fat, and under the catalog-over-Parquet shape it's `data/parquet/` (96 MB over the full 2015–2026 window; not the thin `.duckdb` catalog file) driving that image size. Free tier is per-*account*, not per-project; `us-central1/east1/west1` only. |
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

**A hybrid stays available:** prerender the finite entity sets as static, keep the server for
route pages and the Explorer. An optimization, not a v0 requirement — but the sets are small
enough that it stays on the table. Measured against `fct_segment_month`, quarantined rows
excluded, trailing 12 (2025-05 → 2026-04) and all-time (2015-01 → 2026-04):

| Entity | trailing 12 | all-time |
|---|---|---|
| airports (`origin` **or** `dest`) | 749 | 1,041 |
| carriers | 70 | 114 |
| aircraft types | 74 | 110 |

**These `all-time` numbers are quarantine-EXCLUDED, which makes them the wrong universe for the
sitemap** — do not quote them as "how many entity pages exist." A quarantined row
(`load_factor > 1.0`, CLAUDE.md) is still a real filing and its page still 200s, so excluding it
silently undercounts. `docs/product/scope.md` § D2 has the number that answers "how many entity
pages get indexed" — `/sitemap.xml`, **quarantine-INCLUDED**: 1,045 airports, 114 carriers, 110
aircraft, 22,420 routes, **23,694** total (which includes `/watch` and its four presets — not
entity pages, and not part of this table's breakdown).

Airports and carriers happen to land close to those figures (1,041 vs. 1,045; 114 both ways — no
fact-present carrier's entire row history is quarantined). **Aircraft types' `110` here is a
different count entirely, and its match to the sitemap's `110` is coincidence, not agreement:**
this row counts distinct BTS `aircraft_type` CODES, quarantine excluded (112 all-time, 110 once
quarantine-only codes drop out); the sitemap counts distinct URL-routable SLUGS, quarantine
included (112 fact-present codes → 111 short names → 110 once the ambiguous `CE-180` is
excluded, `sql/03_queries/sitemap_aircraft.sql`). **Never key a build list on this table's
counts — re-derive them the way the sitemap does.** They are computed independently and drift
the moment either side changes.

The three page types together are ~1,265 all-time URLs, three orders of magnitude below the
20,000-file cap above and nowhere near a build-time problem. Route pages are the set that is not
finite in the same sense — **22,420** undirected pairs — which is why the split is entity pages
static, routes served.

**22,420 and 22,950 are both real and answer different questions.** 22,950 is
same-airport-INCLUSIVE; 22,420 excludes the 530 same-airport pairs (`docs/data/invariants.md`
§ Route identity). A same-airport "route" has no `/route/<pair>` page at all — `routePair.ts`
404s it as "not a route between two airports" — so only 22,420 belongs in a count of pages.

**Count airports at both endpoints, or the number is wrong by a third.** Origin-only gives 741
/ 993, and that is not a rounding difference: it is the same silent halving
`../product/features.md` measures on `/airport/SEA` (26,710,000 seats against 53,373,806). A prerender list built from
`origin_airport_id` alone would simply never emit pages for the 48 airports that only ever
appear as destinations.

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

**A `Cache-Control` header is necessary and not sufficient.** Cloudflare does not cache
`text/html` by default at any plan level, so every HTML `s-maxage` below is inert until a Cache
Rule tells the edge to cache the response. That rule is `deploy/cloudflare/cache-rules.json`,
applied by `make cloudflare-apply` — it is the thing that makes this section true, and the
origin header alone would have every page miss while looking correctly configured. Verified on
the live site: a repeat fetch of `/route/JFK-LAX` returns `cf-cache-status: HIT` alongside
`public, s-maxage=3600, stale-while-revalidate=86400`.

Data changes monthly. Every successful JSON response (`/api/pivot`), plus `/sitemap.xml` and
`/robots.txt`, get:

```
Cache-Control: public, s-maxage=2592000, stale-while-revalidate=86400
```

**HTML page routes — `/explore`, the four entity pages, and `/watch` plus its four
`/watch/:preset` pages — get a shorter one instead:**

```
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
```

Not a stylistic choice: § "The gap" below measures why — a 5xx from a page carries whichever
`Cache-Control` the proxy already committed to before the page ran, and a route-handler entry
point that could catch that and set its own header per outcome turned out to be unreachable for
this Next version without discarding the page. The shorter value is `proxy.ts`'s `HTML_CACHE`
constant, bounding that exposure to an hour instead of a month rather than closing it outright.

With Cloudflare's free tier in front, near-zero repeat traffic touches the box regardless —
`stale-while-revalidate` keeps serving from the edge while either value revalidates.

**Leaderboard precompute was specified for three milestones and is retired, not deferred**
(#14). Measured 2026-08-09 against a served build at `4aa8087`, not argued: `mart_route_health`
is 8,080 rows, and the four `/watch` preset queries cost **2.2-2.5 ms** each at a warm median
(fresh read-only connection per preset, median of seven runs), **5.0 ms** at the cold worst case
(`watch_death_watch`; the other three cold runs were 3.3-3.5 ms). End-to-end TTFB on that same
build puts `/watch/gauge` at **43-46 ms** — against `/route/JFK-LAX` at 63-69 ms and
`/airport/ORD` at 85-104 ms, neither of which anyone proposes precomputing. Precompute would have
optimised the third-cheapest page on the site and left the two most expensive per-request.

## Avoid

- Managed Postgres (~$20+/mo, pointless — no writes)
- Mapbox tiles (usage-priced; Natural Earth GeoJSON instead)
- Always-on Redis
- Vercel, if traffic spikes (bandwidth pricing bites)

## Portability test

**The deployable artifact is `upgauge.duckdb` *plus* `data/parquet/` (96 MB, measured
`du -sh data/parquet` over the full 2015–2026 window; it grows with the window), not the
`.duckdb` file alone.** As built, the catalog is views over
*relative* Parquet paths — it carries almost no data itself — so it behaves identically
under `docker run` only if `data/parquet/` is co-located with it and `WORKDIR` is the
directory containing `data/`. **`make portability` proves that by breaking it** — three ways,
each asserting its own signature ([§ below](#the-portability-test-itself)).

Everything is Docker + Parquet + env vars. R2 is S3-compatible. **Do not build on
provider-specific runtimes** (Workers, D1, KV). This must stay a normal app.

**That artifact is published, not just described.** `warehouse.yml` publishes
`warehouse-YYYY.MM.tar.zst` (`upgauge.duckdb` + `data/parquet/`) and `raw-YYYY.MM.tar.zst`
(`data/raw/`, needed only by `make verify`) as GitHub Release assets with build-provenance
attestations. CI restores the first; the container work (#15) consumes the same one, so there is
one producer for CI, the image, and the portability test.

> This constraint earned its keep: swapping the original Fly pick for Hetzner was a one-line
> change precisely because nothing depended on the provider.

### The Dockerfile

Four stages: `warehouse` (fetches and unpacks the published release asset), `deps` (full
`npm ci`, for the build only), `build` (`next build`; touches no `data/` and no `sql/`, so it
runs concurrently with `warehouse`), `runtime` (`npm ci --omit=dev` plus the warehouse output
copied in). `runtime` runs as `USER node` — confirmed: `docker run --rm upgauge:local id` →
`uid=1000(node) gid=1000(node) groups=1000(node)`. No `output: "standalone"` (§ above).

**The WORKDIR contract above is asserted at BUILD time, not left for the first query to
discover.** `warehouse`'s extraction is followed by three `test` assertions — `upgauge.duckdb`
at the tarball root, `data/parquet` a directory at the tarball root, `data/raw` absent — so a
future change to `warehouse.yml`'s packing step fails the image build instead of shipping a
container that starts cleanly and then fails every query. **Confirmed by mutation**: changing
the extraction to `mkdir -p x && tar --zstd -xf w.tar.zst -C x` (landing `upgauge.duckdb` one
directory down) fails the BUILD at `RUN test -f upgauge.duckdb …` with exit code 1 — it never
reaches `docker run`, and never reaches a query.

**`--read-only` works with no tmpfs mount.** Every DB-touching route in this app already carries
`export const dynamic = "force-dynamic"`, so there is no ISR page cache and no on-demand
revalidation write to `.next/cache` at request time, and `db.ts` opens the database
`access_mode: "READ_ONLY"` always — no candidate write path survives from either direction.
Measured: `docker run --read-only` served `/`, `/explore`, all four entity pages, `/watch`,
`/sitemap.xml` and `/api/health` at 200 with an empty, error-free log. No tmpfs mount is added;
if a future page ever needs one (most likely `/srv/upgauge/app/.next/cache`), add
`--mount type=tmpfs,destination=/srv/upgauge/app/.next/cache` to the run command rather than
dropping `--read-only`.

**The base image is TAG-pinned, not digest-pinned, and that bounds every size figure in this
section.** `node:24.19.0-slim` is a moving target: Debian security rebuilds re-push the same tag, so
two `make image` runs from an identical tree can produce different images — the opposite of the
reproducibility argument the Makefile makes for `WAREHOUSE_TAG` a few lines from it, and it
invalidates the `.Size` and layer counts below whenever it happens. Accepted deliberately: a digest
pin freezes out those same security rebuilds until someone bumps it by hand, which is a patching
policy decision, not a Dockerfile tidy-up. Keep `ARG NODE_VERSION` equal to `mise.toml`'s `node`
(24.19.0 today) so the container runs the Node the gates ran against. **Open follow-up**, not a
finding: if this ever ships behind an SLA, decide digest-pin-plus-renovation versus tag-pin
explicitly.

**The build context must contain only tracked files, or the image depends on what this host has
run.** `app/tsconfig.tsbuildinfo` and `app/next-env.d.ts` are generated, gitignored and untracked;
both are regenerated inside the `build` stage, so neither belongs in the context. Left in, they
were load-bearing by accident: one `make app-check` rewrites `tsconfig.tsbuildinfo`, which
invalidates `COPY app ./app`, which re-runs `next build`, which mints a fresh build id — so the
next `make image` produced a *different image from an unchanged tree*. Confirmed by mutation, both
directions: with the `.dockerignore` entries in place, appending a byte to
`app/tsconfig.tsbuildinfo` leaves `COPY app ./app` `CACHED` and `.Size` byte-identical; with them
removed, the same append re-runs the stage and changes `.Size`. **No delta is quoted for that
second half on purpose** — it is whatever two `next build` runs happened to differ by, so it is a
property of one pair of builds and re-measuring it yields a different number, not a broken rule.

**`app/smoke.sh` is `.dockerignore`d too, and it is TRACKED — the second reason a file leaves the
context is that the build does not need it.** The gate script runs on the *host* in both modes
(container mode drives the container from outside; the image never contains it) and `next build`
never reads it, but it lives under `app/`, so every edit to it invalidated `COPY app ./app`, re-ran
`next build` and minted a fresh build id. That is how the `.Size` figure below went stale one commit
after being measured — by a **comment-only** edit to `app/smoke.sh`, which is as small as a change
to this file gets.

Confirmed by mutation, both directions, **with `BUILD_SHA` pinned to the same value in all three
builds** so the only variable is the ignore entry: with it in place, appending a comment to
`app/smoke.sh` leaves `.Size` byte-identical *and* the `RootFS.Layers` digest list identical; with it
removed, the same append changes the layer list and moves `.Size`. No delta is quoted for that
second half, for the same reason as the paragraph above. Anything else under `app/` that only the
host or CI reads belongs here too.

**Pinning `BUILD_SHA` for that mutant was not optional, and the reason is worth keeping:** `make
image` derives it from `git describe --always --dirty`, so *any* uncommitted edit — including one to
a file this very entry excludes — lengthens the identity string from 7 characters to 13 and moves
`.Size` by **18 bytes** with byte-identical layers. Unpinned, that 18 bytes would have read as the
ignore entry failing. Overriding it (`make image IMAGE_SHA=…`) is a measurement tool, never a build
step: the whole point of `--dirty` is that nobody can label a modified tree as the commit.

**`ARG BUILD_SHA` and its `ENV` go LAST in the `runtime` stage, below every `RUN` and `COPY`.** An
`ARG` is consumed where its `ENV` sits, and `BUILD_SHA` changes on every commit — declared at the
top of the stage it invalidated `npm ci --omit=dev` and all five `COPY`s beneath it, so a one-line
identity change re-installed the production deps and re-materialised the 96 MB `data/parquet`
layer. Measured before the move: `npm ci --omit=dev` re-ran (13.9 s), every subsequent `COPY`
re-ran, and `.Size` shifted 2,098 bytes between two commits with an identical tree. After: both
are `CACHED` across a `BUILD_SHA` change and `.Size` moves by **3 bytes** — the config blob alone,
with byte-identical layers. This is a deploy cost, not only a build one: a registry pulls the data
layer again for every commit whose layers did not actually change.

**Measured image size: ≈413 MB / 394 MiB** — `docker inspect upgauge:local --format='{{.Size}}'`
reports 412,715,491 bytes, cross-checked against `docker save upgauge:local | wc -c`
(412,738,560 bytes; the ~23 KB difference is tar-format overhead) and against the 13 layers in
`docker inspect --format '{{len .RootFS.Layers}}'`. Both figures come from **two consecutive builds
of the same commit that agreed exactly**, every step `CACHED` — a number that moves on a second
identical build is not worth writing down. **Quote ≈413 MB, not the byte count.** Every
run of the `build` stage mints a new `next build` id, so any real source change moves `.Size` by
kilobytes, and the baked identity moves it by the 3 bytes above; the exact figure is a property of
one build, not of this project, and is not a fixture. **It is also not what
`docker images --format '{{.Size}}' upgauge:local` reports** — that
printed `1.5GB` for the identical tag on the same host (Docker 29.6.2, containerd snapshotter),
and `docker history`'s per-instruction sizes for the same image sum to ~1.09 GB.

**Neither inflated figure is multi-stage discarding, and the proof is an image with nothing to
discard.** A plain, unmodified `node:24.19.0-slim` — no multi-stage build, no `COPY --from`, no
stage to throw away — shows the identical pattern: `docker inspect --format='{{.Size}}'` reports
**80,463,700 bytes** and `docker save node:24.19.0-slim | wc -c` reports **83,079,680 bytes** (the
two agree, exactly as `upgauge:local`'s own pair does), while `docker history --format
'{{.Size}}'` summed over its 5 layers reports **247,710,100 bytes — a ~3.08× inflation** and
`docker images` reports `331MB`. It is a general over-count in that accounting layer on this
containerd-snapshotter Docker (29.6.2), not a symptom of anything this Dockerfile does. **Use
`docker inspect`'s `.Size` or `docker save | wc -c` for any image's real size on this host; never
`docker images` or `docker history`.**

### Container smoke mode

`make image-smoke` runs `app/smoke.sh`'s served-build checks against the container `make image`
produces (`--read-only`, no tmpfs, per the finding just above), instead of against a `next
start` the script forked itself. `port_free_or_die` (`app/smoke.sh`'s own header, unchanged)
proves *"I started this server"*; it cannot prove *"this is the build under test,"* and in
container mode a container is **supposed** to hold the port — deleting the guard for this mode
would reopen the exact hole `port_free_or_die`/`kill_port` exist to close (an orphaned server
held `:3199` for 34 minutes across two runs; both reported `266 ok` against a build that was not
the one under test). So container mode keeps the guard **and** adds `assert_identity()`, the
positive check the guard never had: it reads `/api/health`'s `build.sha`/`build.warehouse` and
aborts *before any content check runs* if either disagrees with `SMOKE_EXPECT_SHA`/
`SMOKE_EXPECT_WAREHOUSE` — the two values `image-smoke` passes as the working tree's own short
SHA and `WAREHOUSE_TAG`. `assert_identity` reads through `mise exec -- node -p …`, never bare
`node`, with an explicit non-empty check on both values before the comparison — the same
silently-green failure shape this file's `next`-version guard fixed once already (`set -e` is
off and command substitution never propagates a child's exit status, so an absent `node` yields
`""` for both sides and `"" != ""` passes).

**Confirmed by mutation, both halves — against `app/smoke.sh` directly, not through `make
image-smoke`, and that "not through" is itself a finding.** `image-smoke`'s own recipe (above)
assigns `SMOKE_EXPECT_SHA="$(git rev-parse --short HEAD)"` as a shell prefix on the `./app/
smoke.sh` invocation, and a prefix assignment always wins over an inherited exported variable of
the same name for that one command — ordinary POSIX shell precedence, reproduced in isolation
with a two-line Makefile before trusting it against this one. So `SMOKE_MODE=container
SMOKE_EXPECT_SHA=deadbee make -s image-smoke` cannot inject a wrong expectation at all: the
recipe recomputes the real SHA and passes *that*, the comparison matches, and the run reports
`smoke: all checks passed` — silently proving nothing about `assert_identity`. That is a
property of the wrapper, not a bug in it: `make image-smoke` deliberately computes its own
ground truth rather than trusting a caller-supplied expectation, which is the correct shape for
the real use case (nobody should be able to launder a stale image past this gate by also
supplying the wrong expectation). The mutant therefore has to exercise `assert_identity` at the
layer that actually owns the comparison:

```
$ SMOKE_MODE=container SMOKE_IMAGE=upgauge:local SMOKE_EXPECT_SHA=deadbee ./app/smoke.sh
  FAIL the server on this port reports build 4170ac5, expected deadbee.
       Every check below would pass against a build that is not under test.
$ echo "exit=$?"
exit=1
```

Aborted before `==> checks` ever printed — no served-build check ran. Then, with the
`assert_identity "$BASE"` call itself deleted and the identical command re-run: `smoke: all
checks passed` — every served-build check green — against the same server whose identity
(`deadbee` expected, `4170ac5` actual) was never read at all — the defect the assertion exists to make impossible. Restored
immediately after; `git diff app/smoke.sh` empty against the committed version before
re-verifying `make image-smoke` clean.

**`WAREHOUSE_TAG` and `app/smoke.sh`'s dataset needles are ONE fixture — bump the pin in the same
commit that re-measures the needles.** The Makefile pins the tag for reproducibility, but
`make image-smoke` then runs dataset-month-specific checks against that pinned asset: the two
chart-window needles on `/route` and `/carrier`, the current year's asterisked tick and its
partial-year sentence on `/airport`, and the covered-range message an out-of-range `?y=` returns
(`app/smoke.sh`'s `check_dataset` call sites). **Those needle values are not quoted here, and must
not be** — every one of them moves when BTS publishes, and a copy written into prose rots silently
while the fixture itself moves on. When BTS publishes, `make ingest && make build` moves the local
database and those needles get re-measured, so **`make app-smoke` goes green while `make
image-smoke` goes red with no defect present** — it is still building from the previous pin.
Whoever meets that red beside a green host gate will reach for the needles, which is the wrong end.
Same rule as CLAUDE.md's "when a renamed value was the fixture for a transform, MOVE the fixture",
applied to this coupling; stated at the pin itself (`Makefile`, `WAREHOUSE_TAG`) as well as here.

**Two mechanisms hold the fixture together, and neither is a human remembering.** The bot is
`warehouse.yml`'s `bump-pin` job: it opens a PR moving the pin when the pin is behind, and does
**not** touch the needles. Only four of those (the partial-year sentence, the chart window, the
current-year asterisk, the covered range) follow from `max(year_month)`; the rest need the
warehouse queried through the rendered pages, so a rewriter that fixed the derivable four would
emit a PR that reads as re-measured and is not.

**The bot's guard is `!cancelled()` plus "a release with this tag exists", never "this run
published it" — and that difference is a permanent stall.** `classify` runs after the release is created and
can legitimately throw (a real upstream shape change is exactly when it should), which fails the
publish job and skips the bump. Every re-dispatch afterwards takes the already-published path, so
a flag meaning "this run created the release" is never set again: the release ships, the pin never
moves, and the only signal is a generic red. Keyed on existence instead, the next run repairs it —
which is why the job runs daily and mostly opens nothing, a checkout and a script rather than a
single chance per publish. `!cancelled()` rather than `always()`: the two differ only on a run a
human stopped on purpose, and opening a PR out of one is the overreach `scheduled-failure.yml`'s
own allow-list already refuses. Its failures stay loud (they redden "Warehouse", which
`scheduled-failure.yml` watches), and the accepted cost of that loudness is that a genuinely
broken bot also defers `image.yml`'s build until the next push to `main`. **Every network call
that can fail the job is retried** — five attempts, backoff, no sleep after the last — through the
one helper in `.github/scripts/gh_retry.sh`, so that a transient wobble is never what triggers it;
the two calls that are pure polish (assigning the PR, annotating a superseded one) are
`||`-tolerated instead. `git ls-remote` goes through that helper too, and for a second reason:
`--exit-code` returns 2 for "no such branch" and 128 for a transport failure, and the obvious
`if git ls-remote …; then` reads both as "absent". The gate is
`image-contract.yml`, which runs `make image-smoke` **with nothing overridden** — the committed
pin, the needles at their default — on any PR touching either half. That is the only invocation
that can see the coupling: `image.yml` also runs `make image-smoke`, but resolves the newest
published release and passes `SMOKE_DATASET_PINNED=0`, so both halves are absent from it by
construction, and correctly so (a production image is built from the newest release, which the
committed needles trail between a publish and its bump PR merging). Neither `WAREHOUSE_TAG` nor
`SMOKE_DATASET_PINNED` may appear in the gate's command **or in an `env:` block at any scope**:
`WAREHOUSE_TAG ?=` is a conditional assignment, so an environment variable of that name wins over
the pin, and `app/smoke.sh` reads `${SMOKE_DATASET_PINNED:-1}`.

**The bump PR carries no `pull_request` checks, and the PR says so.** GitHub starts no workflow
runs from events created by `GITHUB_TOKEN` (the same rule that rules out `release: published` as a
trigger — see `image.yml`'s `on:` comment), so a PR the bot opens starts neither `ci.yml` nor the
gate. `workflow_dispatch` is the documented exception, and `bump-pin` uses it to run the gate
against its own branch; the PR body states plainly that `ci.yml` has not run and links the
branch-filtered runs. **A reader who merges on a green-looking PR with no checks is the failure
this caveat exists to prevent.** Setting a `BUMP_PIN_TOKEN` secret removes it — the job already
reads `secrets.BUMP_PIN_TOKEN || github.token`, so the PR would be authored by a real account and
every workflow would fire normally. The repo grants no such secret today and nothing requires one.

**`/api/health` carries its own served-build checks, in both modes** — exactly
`cache-control: no-store`, and no `s-maxage=2592000`. It was the readiness probe and the identity
source and had no check of its own: the probe reads only *whether* it answered, `assert_identity`
reads only `build.sha`/`build.warehouse` out of the body. **Its status code is asserted by the
readiness guard, not by a `check`** — a third check (`health: 200 on a healthy build`) was added
alongside these two and removed in the same review round, because it sat *after* a guard that
already `exit 1`s unless the code is exactly 200: it could never be red, and it inflated both
published counts by one. The guard is the stronger form regardless — it aborts rather than letting a
degraded server report a mass of consequential failures with one cause (**no count is quoted for
that**: it is a property of one broken build, exactly like the `.Size` delta two sections above, and
the argument is the ratio of noise to cause) — and it has been red by name twice, at HTTP 000 and
HTTP 503. `assert_identity` would not stop such a run either: it reads `build.sha`/`build.warehouse`,
which a degraded 503 body still carries — identity and health are separate questions, and that is
correct. `no-store` is the property that justifies
this route being the one deliberate omission from `proxy.ts`'s matcher, and nothing verified it on
a served response — `proxy.test.ts` pins the absence from the matcher *array*, and
`api/health/route.test.ts` calls `GET()` directly. Both would stay green if a Next upgrade or an
"add every route to the matcher" sweep put the project's 30-day `s-maxage` on this endpoint, which
would pin `{"status":"ok"}` in a shared CDN for a month in front of a degraded container. The
negative check is not redundant with the positive one: a response carrying *two* `Cache-Control`
values still contains `cache-control: no-store`.

**Three sections of `app/smoke.sh` are skipped under `SMOKE_MODE=container`** — the three gap
checks, each of which starts its own short-lived `next start` against a deliberately-broken
*copy* of the database. They test page and proxy behaviour against a broken catalog, nothing the
container contributes, and containerising them would triple image builds for zero new coverage.
The skip is **printed**, immediately before the pass/fail tally, never silent — reporting a
narrower count as though it were the full one is the same dishonesty as a stale build passing
every check, one level up. `make app-smoke` (host mode) runs all three; `make image-smoke`
reports the served-build subset alone, shorter by exactly the checks inside those three sections.
**The two totals are not written here.** `pipeline/gatecounts.py` states that the smoke counts are
deliberately not generated — only a real `next build` plus a served port produces them — so they
are hand-maintained, and a second hand-maintained copy is one that goes stale silently. CLAUDE.md's
gates table is the one place they live.

**One existing check needed a container-specific path, not a skip: the "ONE `DuckDBInstance`"
handle count** (§ "One `DuckDBInstance` per process", below). Its host-mode form walks the local process tree with
`pgrep` and reads `/proc/<pid>/fd` directly — valid because `smoke.sh` and `next start` share a
PID namespace on the host. That does not hold for a container under **Docker Desktop**:
`docker inspect --format '{{.State.Pid}}'` reports a PID in the *daemon's* own PID namespace,
which measurably does not exist in the host's `/proc` at all (`docker info` reports
`Operating System: Docker Desktop` — its own Linux VM, not this host) — a namespace mismatch,
not a permission error, and true of Docker Desktop on any platform, not this one machine.
`docker exec upgauge-smoke sh -c '…'` sidesteps it: it always runs inside the *container's own*
namespaces regardless of daemon topology, and PID-namespace isolation alone limits `/proc` there
to this container's own processes, so no `pgrep` is needed either (`node:*-slim` ships no
`procps`).

### The portability test itself

`make portability` is the **negative** half: it breaks the WORKDIR/data-colocation contract three
ways and asserts the *distinct* signature each break produces. The **positive** half is
`make image-smoke` — the served-build checks against the real container, `--read-only`, no tmpfs
(§ above) — which is host mode's total less exactly the checks inside the three host-only gap
sections. Both totals live in CLAUDE.md's gates table and are not restated here.

**The contract is defended at four layers, and the failures are not interchangeable.** One shared
"it 500s" assertion would pass for all of them and therefore prove none:

| break | layer it fails at | observed |
|---|---|---|
| a mis-packed warehouse tarball | image build | `docker build` exits 1 at the `warehouse` stage's `test` assertions (§ The Dockerfile) — never reaches `docker run` |
| `data/parquet/` shadowed, database present | Parquet read | server listens, `/api/health` **503**, every route **500** |
| wrong `WORKDIR`, image `CMD` | `exec` | container **exits 1** in under a second; nothing ever listens |
| wrong `WORKDIR`, absolute entrypoint | database open | server listens, `/api/health` **503**, every route **500** |

**Negative 1 — `--mount type=tmpfs,destination=/srv/upgauge/data/parquet`.** The catalog opens
(it is views over relative paths and carries almost no data of its own); every query then fails:

```
/api/health status=503
/api/health body={"status":"degraded","build":{…},"data":{"asOf":null,"missing":[],
                  "error":"IO Error: No files found that match the pattern \"data/parquet/t100_segment/**/*.parquet\""}}
/explore    status=500
⨯ [Error: IO Error: No files found that match the pattern "data/parquet/t100_segment/**/*.parquet"]
```
(`data` wrapped across two lines for width; it is one object in the response.)

(`build` is elided in both bodies above and below: it carries the working tree's own short SHA, so
quoting it here would go stale on the next commit. `image-smoke`'s `assert_identity` is what checks
that field, against a value it computes rather than one written down.)

All eight paths the healthy container serves at 200 return **500** here — `/`, `/explore`, the
four entity pages, `/watch`, `/sitemap.xml` — so not even a "looks alive" surface survives. Why
cwd is what decides this: [pipeline.md § Views cannot take bound
parameters](pipeline.md#views-cannot-take-bound-parameters--so-cwd-is-load-bearing).

**`missing` is `[]`, and that is the finding.** The healthcheck's `(object, column)` manifest is
**blind** to this break by construction — `duckdb_columns()` answers out of the catalog and never
reads a Parquet file, so every required object and column is genuinely present. The 503 comes from
the `asOf` clause alone. Confirmed by mutation: with `stamp !== null` dropped from
`healthReport()`'s status expression and the image rebuilt, negative 1 returns
**`200 {"status":"ok"}` while `/explore` still returns 500** — a container Docker's `HEALTHCHECK`
and any load balancer would keep sending traffic to. So `portability` asserts the 503, the
`asOf:null` **and** the `missing:[]`; the last of those pins *which* clause is load-bearing rather
than detecting the break, and if the manifest ever does see this break, that is an improvement and
this section and the assertion move in the same commit.

**`data.error` names the cause, and this is the break that needs it most.** `asOf: null` with an
empty `missing[]` says *that* the data layer is unreadable without saying *what happened* — and an
unmounted data volume is both the most likely container break and the one this whole section is
about. The freshness probe's own message is therefore carried verbatim in `data.error` (it was
swallowed by a bare `catch {}` until this review), which is exactly the trip to `docker logs` the
endpoint exists to remove. It is a **separate field from `missing`, deliberately**: the catalog
probe's message goes in `missing` (negative 3 below), so the two breaks — catalog unopenable vs.
Parquet unreadable — stay distinguishable from the health body alone. `portability` asserts
`"error":"IO Error` here; mutant, measured: restore the bare `catch {}`, rebuild the image, and that
assertion is the **only** one of negative 1's six that goes red (the 503, the `asOf:null`, the
`missing:[]`, `/explore`'s 500 and the log line all stay green — none of them can see the
difference).

**Negative 2 — `docker run -w /tmp`.** The `CMD` is a **relative** path
(`app/node_modules/.bin/next`), so a wrong working directory stops the container before it can
listen instead of bringing up a server that answers every request from the wrong place:

```
exit code   =1
/explore    status=000
Error: Cannot find module '/tmp/app/node_modules/.bin/next'
```

**Keep `CMD` relative.** Rewriting it to an absolute path turns this hard start failure into a
running server serving 500s off a wrong cwd — strictly worse, and precisely why negative 3 has to
override the entrypoint to reproduce that shape at all.

The mechanism runs through the base image, worth knowing before editing either end of it:
`node:24.19.0-slim` sets `ENTRYPOINT ["docker-entrypoint.sh"]`, and that script falls back to
`exec node "$@"` whenever `command -v "$1"` finds nothing — which is what a relative path from the
wrong cwd is. The error therefore arrives from node's module resolver, not from `execve`. Give
`--entrypoint` that same relative path and it fails one step earlier, in `runc`:
`exec: "app/node_modules/.bin/next": stat app/node_modules/.bin/next: no such file or directory`.

This case is also the one that must run **without `--rm`**: the container is gone within a second,
and `docker logs` against an `--rm` container that has already exited reports `No such container`
— the evidence deletes itself, which is why the first attempt at this case observed nothing at
all. Keep it, then `timeout 30 docker wait`: a `docker wait` that *times out* **is** the failure
(a server came up), where a bare `docker wait` would hang forever in exactly that case.

**Negative 3 — `-w /tmp` plus `--entrypoint /srv/upgauge/app/node_modules/.bin/next`.** An
absolute entrypoint leaves `process.cwd()` at `/tmp`, so `db.ts`'s `ROOT` resolves there and the
failure lands *earlier* than negative 1's — at the open, before any query:

```
/api/health status=503
/api/health body={"status":"degraded",…,"data":{"asOf":null,"missing":["catalog probe failed: IO Error: Cannot open database \"/tmp/upgauge.duckdb\" in read-only mode: database does not exist"]}}
/explore    status=500
```

`missing` names this cause and `error` names negative 1's, which is what keeps the two breaks
distinguishable in production from the health body alone — the reason `healthReport()` reports each
probe's own error text instead of a boolean, in the field belonging to that probe. `missing` here
is a one-element list holding a *message*, not an object name: that is how a catalog probe that
could not even open the database reports, and it is why negative 1 must not push its message there
too.

**Mutants run — each break removed, the named assertions confirmed red, `make` exit 2:**

| mutant | result |
|---|---|
| negative 1's tmpfs mount removed | health **200 `ok`**, `/explore` **200**, no log line — 4 of its 5 assertions red (measured when negative 1 had five; `data.error` is the sixth, added later and mutant-checked in its own row below) |
| negative 2's `-w /tmp` corrected | container still up at 30 s, `/explore` **200** — all 4 assertions red |
| negative 3's `-w /tmp` removed | health **200 `ok`**, `/explore` **200** — all 3 assertions red |
| `healthReport()`'s `stamp !== null` dropped, image rebuilt | negative 1's *status* assertion red (**200** while `/explore` returned 500); its `asOf:null` body assertion stayed **green**, because the body still carried the null — the **status mapping** is what that first assertion owns, and only it |
| `healthReport()`'s `asOf` catch reduced to a bare `catch {}`, image rebuilt | negative 1's **`data.error` assertion red, and nothing else** — body `{"asOf":null,"missing":[]}`, still 503, `/explore` still 500, log line still present. A 503 that names no cause is invisible to every other assertion in the case |

`missing:[]` stayed green under the first mutant, as it must: it is equally true of a healthy
container. That is the difference between pinning a mechanism and detecting a break, and its FAIL
text says which it is.

Nothing here runs `--read-only`, deliberately: each negative isolates exactly one variable, and a
second difference would leave a red ambiguous between the break under test and the read-only root.
`--read-only`'s own proof is `image-smoke`'s, where every check runs under it.

## What `proxy.ts` owns

`app/src/proxy.ts` does **three** jobs, and each of them has already shipped broken once by
being invisible to whoever added a route:

| Job | Mechanism | Read the section |
|---|---|---|
| Raw query string → the app | `x-upgauge-raw-query` request header (`lib/rawQuery.ts`) | *load-bearing*, below |
| Request pathname → the app | `x-upgauge-path` request header (`lib/rawPath.ts`) | *the pathname header*, below |
| The project `Cache-Control` | Set on the proxy's own response | *Cache-Control lives here*, below |

> **Adding a page route? You must add it to `config.matcher` in `proxy.ts`, or it ships
> uncached, without either header, and with its 404 page destroyed.** This is not optional and
> nothing else enforces it: a route missing from the matcher builds, serves, typechecks, passes
> its unit tests, and looks correct in a browser. `/route/<pair>` shipped
> `private, no-cache, no-store, max-age=0, must-revalidate` for exactly this reason — the
> matcher listed only `/explore` and `/api/pivot`, and every gate stayed green.
>
> **Three lines per page, and all three are load-bearing:** a `matcher` entry, a row in
> `ENTITY_ROUTES`, and *both* a header assertion and a `no-store` assertion in `app/smoke.sh`.
> **The matcher holds twelve entries**: `/`, `/explore`, `/api/pivot`, the four entity pages
> (`/route/:pair`, `/airport/:code`, `/carrier/:code`, `/aircraft/:name`), `/search`,
> `/sitemap.xml`, `/robots.txt`, `/watch` and `/watch/:preset`. Only the four entity pages and
> `/watch/:preset` are dynamic segments; the rest are exact paths with no per-slug resolution.
> The rule is the same for all of them: a route absent from the matcher gets
> no `Cache-Control` from this file at all, which for `/search` happens to be harmless (Next's
> own `no-store` for `dynamic = "force-dynamic"` covers the gap) but for `/sitemap.xml` and
> `/robots.txt` is not — neither sets its own header the way `/api/pivot`'s route handler does,
> so omitting either from the matcher ships it with literally no shared-cache header, forever,
> not merely mis-cached. `/search` gets `no-store` **unconditionally** (`q` is an unbounded,
> attacker-chosen string, and there is no proxy-side resolution that would make caching any of
> it safe — see `proxy.ts`'s own doc comment on that branch); `/sitemap.xml` and `/robots.txt`
> get the project's 30-day value outright, since both are built from the same catalog queries
> regardless of who's asking and carry none of an entity page's per-request resolution risk.
>
> **`/watch/:preset` is a dynamic segment, the same shape as the four `ENTITY_ROUTES` entries,
> but it deliberately has
> no `ENTITY_ROUTES` row:** `resolveRoutePair`/`resolveAirportCode`/`resolveCarrier`/
> `resolveAircraftSlug` each resolve an id against the warehouse, where a preset slug resolves
> against `presetBySlug()`, a lookup into the fixed, four-entry `PRESETS` registry
> (`lib/watch.ts`) — no query at all. That is why `/watch`'s cacheability rule in `proxy.ts` is
> written as its own `if` branch rather than a fifth `ENTITY_ROUTES` row: **the allow-list
> (`presetBySlug(slug) !== null`, or the bare `/watch` path which has no slug to fail) answers
> "is this a well-formed, known page" for free, but does NOT answer "is it safe to cache" —
> every preset page still runs a live `mart_route_health` query, so the branch also gates on
> `isDataLayerHealthy()`, the same probe `/explore` and `/sitemap.xml`/`/robots.txt` use.**
> Skipping that probe because the slug set is static is exactly the mistake `/sitemap.xml` made
> once already (§ "The gap" below, fix wave F4) — "it takes no user input" was true there too,
> and it still 500ed under a 30-day public cache. Declining the cache when the probe fails costs
> a cache miss; skipping the probe costs a 500 pinned in a shared cache for up to an hour
> (`HTML_CACHE`'s window, since `/watch` reads live warehouse state the way `/explore` does, not
> a fixed catalog query the way `/sitemap.xml`/`/robots.txt` do). An unknown preset — `known`
> false — is `no-store` regardless of the probe, same as every other 404 in this file.
>
> **A route can be *structurally* wrong — missing a required page-level export, not merely a
> matcher row — and stay invisible to every gate but one.** `app/src/app/sitemap.ts` and
> `app/src/app/robots.ts` carry `export const dynamic = "force-dynamic"`, the same export every
> other DB-touching route has. Without it Next tries to prerender them at `next build` time, and
> `next build` runs with `cwd` wherever the build tool started it (`npm --prefix app run build`,
> every documented entry point's exact command, changes `cwd` to `app/` before invoking the real
> `next build`), not the repo root `db.ts`'s `UPGAUGE_ROOT` contract assumes. The failure is
> `IO Error: Cannot open database ".../app/upgauge.duckdb" ... database does not exist`, and the
> only gate that can see it is `make app-smoke` — the sole one that runs a real `next build`.
> That is the whole argument for treating a served-build pass as a first-class deliverable
> rather than a nice-to-have at the end.

### What omitting one actually costs — measured, not assumed

A missing matcher entry looks like it should make every 404 on the affected page a **500**,
because `not-found.tsx` reads `x-upgauge-path` and throws `MissingRawPathError` without it.
Measured against a served build with `/airport/:code` deliberately removed from the matcher,
the truth is narrower, and worse:

| | With the matcher entry | Without it |
|---|---|---|
| `/airport/SEA` | 200, `public, s-maxage=3600, …` | 200, `private, no-cache, no-store, max-age=0, must-revalidate` |
| `/airport/sea` | 308, long-cached | 308, `private, no-cache…` |
| `/airport/ZZZZ` | 404, `no-store`, names the code | **404**, `private, no-cache…`, **7,740-byte `<html id="__next_error__">` shell** |

> The **shape** of the finding — present vs. absent, not the literal number — is what the table
> exists to show, and that shape is unchanged by which constant HTML pages carry. `/airport/SEA`
> is an `ENTITY_ROUTES` page, so its long cache is `HTML_CACHE`'s `s-maxage=3600`, not the
> project's 30-day value.

So the status stays 404 — Next catches the throw inside the 404 render — but the page is gone:
no reason, no code named, no `DATA AS OF`, no recovery link, and `MissingRawPathError` in the
server log with a digest. **A 404 that has lost its entire message, on every unknown code, with
nothing red anywhere else.** That is worse than the 500 the reports expected, because a 500 is
loud. `app/smoke.sh`'s per-page 404-body checks are what catch it; the three matcher-removal
mutants below each turned exactly those checks red.

## `proxy.ts` is load-bearing — both query entry points break without it

**`app/src/proxy.ts` and `next.config.ts`'s `skipProxyUrlNormalize: true` are one mechanism,
and neither works alone.** They are a deploy requirement, not an optimisation: without them
*every* filtered query fails on both `/explore` and `/api/pivot`.

Next normalizes the incoming request URL by round-tripping the query string through
form-encoding before either a page or a route handler sees it. Measured directly:

| Source | `f=k:a%2Cb,c` becomes |
|---|---|
| `new URL(raw).search` | `f=k:a%2Cb,c` — correct |
| `URLSearchParams.toString()` (what Next applies) | `f=k%3Aa%2Cb%2Cc` |

The structural `:` becomes `%3A`, and — the fatal part — the **structural comma and the
percent-encoded data comma collapse into the same bytes**, so a value that legally contains a
`,` becomes indistinguishable from two values. This is unrecoverable after the fact; no
amount of re-decoding downstream can undo it.

Measured against a running production server before the fix: every filtered query returned
`malformed filter 'origin_state%3AOR'` — including ones with **no reserved characters at
all**. `/api/pivot` was affected exactly as much as `/explore`; its
`new URL(request.url).search` is normalized too.

The fix: `skipProxyUrlNormalize` keeps `request.url` untouched inside `proxy.ts`, which copies
it into the `x-upgauge-raw-query` request header (`app/src/lib/rawQuery.ts`); both entry
points read that header and nothing else. A page can never use `searchParams` for this — Next
has already percent-decoded those, which loses the same distinction.

Portability is unaffected, and in fact improved: Next 16 deprecated `middleware` in favour of
`proxy`, and its docs are explicit that **"the `edge` runtime is NOT supported in `proxy`. The
`proxy` runtime is `nodejs`, and it cannot be configured"** — so this cannot pull in a
provider-specific edge runtime, and the platform-support table lists a plain Node.js server as
supported. It is ordinary Node code in the container.

If the header is absent the app **fails loudly** rather than guessing: `/api/pivot` returns a
generic 500 (the message never reaches the client) and `/explore` throws
`MissingRawQueryError`, naming the header and the file to check. There is deliberately no
fallback to reconstructing the string from `searchParams` — that path is exact for most inputs
and silently wrong for the rest, which is the failure mode this project refuses everywhere
else.

**No unit test can catch a regression here.** The tests never construct a `NextRequest` and
never cross Next's normalization; both times this bug appeared it was found only by building,
serving, and curling. See [pipeline.md](pipeline.md) on the missing `app-smoke` gate.

## The pathname header — how a `not-found.js` names what was requested

`proxy.ts` sets a second request header, `x-upgauge-path` (`app/src/lib/rawPath.ts`), carrying
the request's pathname. Unlike the raw-query header, nothing is being rescued from Next's URL
normalization here. It exists because **Next's `not-found.js` convention accepts no props**
(`node_modules/next/dist/docs/.../file-conventions/not-found.md:131`) and gets no route
params, so `app/route/[pair]/not-found.tsx` has no framework channel telling it which slug
failed — and `notFound()` takes no argument, so `page.tsx` cannot pass its resolution either.

The same docs (`:181`) point at a Client Component reading `usePathname()`. That shape is
rejected here: it names only the *pair*, where four doc sites
promise a 404 **naming the offending code**, and because it put the one value the page's whole
message depends on behind a client boundary that no server test and no `curl` can observe:
`usePathname()` returning null would have degraded the page to a generic sentence with every
gate green. That is this branch's signature failure class.

The same file's Data Fetching example (`:135-152`) shows an `async not-found.tsx` calling
`headers()`. So the pathname arrives server-side, `not-found.tsx` re-runs `resolveRoutePair()`
against it, and renders that function's own `reason` — `unknown airport code 'ZZZZ'`, or
`'LHR' is a recognized airport code, but this dataset is domestic-only …`. Absent header →
`MissingRawPathError`, same fail-loud discipline as `MissingRawQueryError`, no fallback.

`app/smoke.sh` asserts the *rendered sentence*, not just the 404 status, and asserts each
case's phrase together with the **absence** of a sibling case's phrase — a single generic
sentence enumerating all the causes would satisfy any lone positive check, and that sentence
is precisely what shipped before.

**Four `not-found.tsx` files depend on this header now** (`/route`, `/airport`, `/carrier`,
`/aircraft`), each re-running its own resolver against the pathname, so the matcher rule above
is not a caching concern with a 404 side-effect — it is the other way round on three of the four
pages. The `/aircraft` one does the most with it: it catches `AmbiguousCodeError`, resolves both
colliding BTS codes to their full designations, and renders each with an Explorer permalink.

> **Known gap, pre-existing and not fixed by this:** Next serves a 404 from a `force-dynamic`
> page as an `<html id="__next_error__">` shell with an **empty `<body>`** — the page's markup
> arrives in the streamed React payload further down the same response and is rendered
> client-side. Verified by building and curling `d158726`, before the fix wave that moved this
> page to the server, so it is a property of the framework's 404 path and not of the page. The
> smoke checks therefore grep the whole response body. That still proves what matters here —
> the payload is server-generated, so a hit means the *server* resolved the pair and shipped
> that reason — but the 404's text is not visible with JavaScript disabled. Fixing it means
> changing how the 404 renders, which nothing here requires.

## `Cache-Control` lives here, and it is status-blind by construction

CLAUDE.md used to state one blanket rule, *"every response gets `public, s-maxage=2592000,
stale-while-revalidate=86400`"* — since superseded by the split below, and CLAUDE.md itself now
says so. That value is applied in `proxy.ts`, on the proxy's own response — not in the pages.
`proxy.ts` applies that exact 30-day value only to `/api/pivot`'s own route
handler (untouched by this file) and to `/sitemap.xml` and `/robots.txt`
(`PROJECT_CACHE` in `proxy.ts`, set on this file's own response since neither metadata-route
export sets one itself); every HTML page route — `/explore` and the four `ENTITY_ROUTES`
pages — gets the shorter `HTML_CACHE`, and `/search` gets `no-store` unconditionally (§ "The
gap" below has the measurement behind the `HTML_CACHE` split; `/search`'s reasoning is its own
branch in `proxy.ts`, not a variant of this one — an unbounded free-text `q` has no
well-formed-vs-not distinction to cache either side of). It has to be applied
here regardless of which value: `/explore` and `/route/<pair>` both export
`dynamic = "force-dynamic"` (their content depends on live warehouse state), so Next emits its
own `no-store` for the HTML, and every shared permalink — the growth mechanic — would hit
DuckDB with the CDN doing nothing. Setting it on the proxy response is what makes it stick
regardless of route segment config.

`/api/pivot` is deliberately excluded: its route handler sets its own header, `no-store` on
errors and the long cache on success, and overriding here would make every 400 publicly
cacheable for a month.

**A proxy cannot see the downstream status.** `NextResponse.next()` is a passthrough sentinel
created *before* the page runs, and a Server Component cannot set response headers, so "exempt
404s" — the rule `/api/pivot` gets for free in its handler — has no direct implementation on a
page route. The naive consequence shipped: a `/route/<pair>` 404 was pinned in a shared CDN
cache for 30 days. The dataset is rebuilt monthly, so `/route/XYZ-JFK` 404ing today because
`XYZ` has no `fct_segment_month` rows keeps 404ing for up to another 30 days *after* the
ingest that makes it real — `stale-while-revalidate` only applies once `s-maxage` has expired,
so the page cannot self-correct.

The rule that does have an implementation:

> **Cache-worthiness is not "did it return 200". It is "is this a well-formed, known entity",
> which the proxy *can* determine before the page runs.**

It applies to all four entity pages — `ENTITY_ROUTES` in `proxy.ts` is one row per page, a
`slugFromPath` prefix reader plus a resolver — and **the predicate is an allow-list of
outcomes, which is not a style preference:**

```ts
kind === "ok" || kind === "redirect"      // cacheable
```

`resolveAircraftSlug` has **four** outcomes, not three. `/aircraft/CE-180` resolves to
`ambiguous` — BTS codes `030` (CESSNA 180) and `031` (CESSNA 180A/B) share one `short_name`,
both really flew, and the page renders a 404 naming both. It is not `notFound`, so copying
a `!== "notFound"` shape — the obvious thing to do — would pin that 404 in a shared CDN cache for 30 days. An allow-list also fails
safe for the *next* outcome anyone adds: an unrecognized kind declines the cache, which costs a
cache miss instead of a month of a wrong answer.

**`redirect` is cacheable for all four.** A 308 target is derived from the slug alone — an
uppercasing, the alphabetical re-ordering of two airport codes, `dim_carrier`'s own spelling —
so it is exactly as stable as the 200 it points at and no ingest can invalidate it.

One asymmetry worth knowing before it looks like a bug: `resolveAirportCode` redirects on **case
before it looks anything up**, so `/airport/zzzz` gets a *long-cached* 308 to `/airport/ZZZZ`,
which then 404s `no-store`. That is correct rather than merely tolerable — `toUpperCase()` never
consults the dataset, so the redirect can never become the wrong answer, and the 404 that
follows is the response that has to stay uncached. `resolveCarrier` and `resolveAircraftSlug`
resolve first and redirect second, so they have no equivalent case.

**The cost side of that same fact, which is worth knowing on a project whose cost control *is*
the caching:** because the redirect precedes the lookup, *every* lower-case path under
`/airport/` mints a long-cached 308 — `/airport/aaaa`, `/airport/aaab`, and so on without bound.
A crawler walking random lower-case strings therefore creates an attacker-controllable family of
30-day CDN entries. Nothing is *wrong*: each response is correct, and each is the cheapest
response in the app (no DB work at all, § What the proxy's query actually costs). The other
three resolvers consult the dataset first, so an unknown slug there gets `no-store` regardless
of case and has no equivalent. Cloudflare's rate limiting is the mitigation and is already in
the architecture; this is recorded so nobody discovers the shape from a cache-fill graph.

At most **one** resolution runs per request: every `slugFromPath` is a prefix test and the loop
breaks on the first match, so four entity pages cost what one did.

Two things this depends on, both established by building and serving rather than assumed:

- **DuckDB is reachable from inside `proxy.ts`.** Next 16 runs the proxy on the Node.js
  runtime and the `runtime` config option is not available there
  (`.../file-conventions/proxy.md:221-223`), so `lib/db.ts` works unchanged — confirmed by
  `make app-smoke`, which is the only evidence that counts for this class.
- **The proxy's resolution is advisory, never authoritative.** It is wrapped in a `try`
  returning `false`: a transient DuckDB failure inside a proxy would 500 a request the page
  might well have served, and declining to cache is the conservative outcome. The page runs
  its own resolution unguarded a moment later, so a real database failure still surfaces
  loudly.

Measured against a served production build. `make app-smoke` curls the `Cache-Control` on
every row below, and the status on every 308 and 404.

| URL | Status | `Cache-Control` | Why |
|---|---|---|---|
| `/explore?…` (well-formed) | 200 | `HTML_CACHE` (1hr) | `isDataLayerHealthy()` probe succeeded |
| `/search?q=PDX` | 307 | `no-store` | a live resolution, not a fixed URL — see below |
| `/search?q=LNY` | 200 | `no-store` | a collision, not a redirect — both candidates rendered |
| `/search?q=nonsense` | 200 | `no-store` | `no-store` is unconditional on this route, outcome-blind |
| `/sitemap.xml` · `/robots.txt` | 200 | `PROJECT_CACHE` (30d) | built from the same catalog queries regardless of caller |
| `/route/JFK-LAX` | 200 | long cache | known pair |
| `/route/LAX-JFK` | 308 | long cache | re-ordering, derived from the two codes |
| `/route/ZZZZ-LAX` · `/route/JFK-LHR` · `/route/LAX-LAX` | 404 | `no-store` | unknown code · non-domestic · self-route |
| `/airport/SEA` | 200 | long cache | fact-present airport |
| `/airport/sea` | 308 | long cache | `toUpperCase()`, no lookup involved |
| `/airport/ZZZZ` · `/airport/LHR` | 404 | `no-store` | unknown code · recognized but domestic-only |
| `/carrier/DL` | 200 | long cache | fact-present carrier |
| `/carrier/dl` | 308 | long cache | canonical is `dim_carrier`'s own spelling |
| `/carrier/ZZ` · `/carrier/PA` | 404 | `no-store` | not in the catalog · in it, never filed |
| `/aircraft/B737-8` · `/aircraft/A320-1-2` | 200 | long cache | fact-present type; the second exercises the slug transform |
| `/aircraft/a320-1-2` | 308 | long cache | to the **slug**, never to the unroutable `A320-1/2` |
| `/aircraft/NOPE-1` | 404 | `no-store` | unknown type |
| **`/aircraft/CE-180`** | **404** | **`no-store`** | **`ambiguous`, not `notFound` — the allow-list is for this row** |
| `/watch` | 200 | `HTML_CACHE` (1hr) | allow-list is unconditional (no slug to fail) — gate is the probe alone |
| `/watch/gauge` | 200 | `HTML_CACHE` (1hr) | known preset, `isDataLayerHealthy()` probe succeeded |
| `/watch/nope` | 404 | `no-store` | not one of the four `PRESETS` |
| `/airport/SEA?y=2019` | 200 | long cache | fact-present airport, `y` a real calendar year |
| `/airport/SEA?y=1999` | 200 | `no-store` | airport resolves fine, but `y` is outside the dataset's window |
| `/airport/SEA?y=nonsense` | 200 | `no-store` | same outcome as an out-of-range year — malformed is not a distinct case |

> **The three `/watch` rows are curled against a served build, not unit-only.** The
> distinction is kept because it
> is the general rule, not a fact about `/watch`: `proxy.test.ts` cannot observe
> `config.matcher` at all (it never goes through Next's routing layer), so it **cannot tell a
> present matcher entry from a missing one**. Any new row in this table is unit-verified, not
> measured, until `app/smoke.sh` curls it against a real build.

**`/search`'s 307 is a deliberate departure from every 308 in this table, and it is `search.ts`'s
choice, not `proxy.ts`'s** — the redirect status is set by `redirect()` in
`app/src/app/search/page.tsx`, unrelated to the `Cache-Control` decision above it. Every other
redirect row here is a second spelling of one fixed URL, derived from the slug alone
(`toUpperCase()`, an id-to-code re-sort) and therefore exactly as permanently valid as the 200 it
targets — a browser caching that mapping forever is correct. `/search?q=PDX` redirecting to
`/airport/PDX` is a different kind of fact: it is *this month's* answer to a live query over
changing data, not a second spelling of a fixed thing, and a 308 is cached by the requesting
browser itself, independently of any CDN and for as long as that browser exists. If a future
carrier or aircraft rebuild ever made `PDX` ambiguous, every browser that had ever visited
`/search?q=PDX` under a 308 would keep redirecting to `/airport/PDX` forever, past the point
where that answer stopped being true — exactly the class of "a wrong permanent answer that no
`s-maxage` bounds" this table's `no-store` rows exist to avoid one layer up.

**Verified by mutation on a served build, because a `check_not` that cannot fire is worse than
no check** (this repo has shipped exactly one of those). Five mutants, each applied to
`proxy.ts` alone, `make app-smoke` run, then reverted:

| Mutant | Result |
|---|---|
| drop `/airport/:code` from the matcher | 4 red: the 200's header, the 308's header, and both airport 404 *body* checks |
| drop `/carrier/:code` | 5 red: the same shape, plus the slug-as-typed check |
| drop `/aircraft/:name` | 7 red: both 200 headers, the 308's, and all four 404-body checks |
| `isCacheable` → `kind !== "notFound"` | **exactly 2 red, both on `/aircraft/CE-180`**, everything else green — the bug, isolated |
| `isCacheable` → `return true` | 18 red: every `no-store` and every `s-maxage` absence check across all four entities |

The last one is the proof that the absence checks are live rather than decorative; the
fourth is the proof that they are specific.

### `y` on `/airport/:code` — a closed set, so validate it rather than blanket `no-store`

`/airport/<code>` takes a second query key, `y=<year>`, selecting one calendar year's
network map instead of the page's default trailing-12-month view. That is a **second
cacheability input** on top of the airport-slug resolution every other `ENTITY_ROUTES` row
already has — the proxy commits to a `Cache-Control` before the page runs, exactly as it does
for the slug, so `y` needs the identical treatment: decided in `proxy.ts`, before the response
leaves, never left to the page to discover after the fact.

**The `/search` parallel, stated explicitly, because it is the thing to reach for first and the
wrong answer here.** `/search`'s `q` is `no-store` **unconditionally** (the section above,
and `proxy.ts`'s own doc comment on that branch) because `q` is unbounded free text with no
set of correct answers to check a candidate against — there is no "is this well-formed"
question short of "never cache" that closes the cache-fill vector a crawler walking the query
space would open. `y` looks like the same shape (attacker-chosen, arrives on a page route,
mints a distinct shared-cache entry per value) but differs in the one respect that matters:
**its legitimate value set is CLOSED** — the calendar years this dataset actually covers, today
2015 through whatever year `dataAsOf()` falls in. A closed set is exactly what makes
*validating* the right answer instead of `/search`'s blanket refusal: `lib/year.ts`'s
`parseYear` rejects anything outside that set structurally, with **no database read at all**,
so a well-formed year stays exactly as cacheable as the airport page always was, and only a
malformed or out-of-range value pays the `no-store` cost `/search` pays on every request.

**`parseYear` is deliberately synchronous and cannot ask `dataAsOf()` directly** — that call is
async, and this function has to run on the request-hot proxy path before anything else does.
Its lower bound (`EARLIEST_YEAR = 2015`) is hardcoded, matching the `EARLIEST_MONTH = "2015-01"`
literal every entity page and `/explore` already hardcode (T-100's earliest ingested filing does
not move the way the *latest* one does with every rebuild, so there is nothing here for a future
ingest to silently disagree with). Its upper bound is `new Date().getUTCFullYear()` — wall-clock
time, not a hardcoded `2026` — because BTS files after the fact, so the dataset's `data_as_of`
can never be ahead of the real calendar; wall-clock time is therefore always at least as large as
any year this dataset could legitimately contain, and it advances on its own every January with
no code change. The task brief's own warning was explicit about the failure this avoids: a
literal `2026` upper bound would start rejecting a real, in-window year the moment `dataAsOf()`
crossed it, and nothing would fail loudly to say so.

**`proxy.ts` reads `y` off the same raw query string it already captures for `/explore`
(`RAW_QUERY_HEADER`'s source value, captured once per request), never off
`request.nextUrl.searchParams`** — the identical rule CLAUDE.md states for the Explorer
permalink, extended to every query key this file reads rather than only the one it was written
for. A bare four-digit year has no reserved characters to lose to Next's query normalization the
way a permalink filter's `,`/`:` do, but the fix that keeps `/explore` alive is "read the one
preserved raw string once per request," not "re-derive it per key only when a key happens to
carry delimiters." `app/airport/[code]/page.tsx` itself reads `y` off ordinary `searchParams`,
the same way `/search` reads `q` — that page-side read is a *different* concern (rendering,
after the proxy has already decided cacheability) and follows the precedent `SearchPage`'s own
doc comment states: a bare, delimiter-free value has nothing `searchParams`'s decoding could
corrupt.

**Cacheability is an AND of two allow-lists, never a negation** — `isCacheable(...)` must
return `true` (the airport slug resolves to `"ok"` or `"redirect"`, unchanged) **and**
`parseYear(y).kind !== "invalid"` (`"default"`, no `y` at all, and `"year"`, a real one, are the
two cacheable outcomes — the same "new outcome? decline by default" safety property
`isCacheable`'s own allow-list already has for a future third `ParsedYear` kind). `/airport` was
pulled back OUT of `proxy.ts`'s generic `ENTITY_ROUTES` table for this — the same reason
`/watch` was never IN it (above): the airport branch's cacheability question no longer fits the
table's one-resolver shape, so it is its own `if` branch, running before the loop and returning
early. The matcher entry (`/airport/:code`) is unchanged; only which mechanism answers for it
moved.

**An invalid `y` is a named error, never a silent fallback to the default view** — the identical
contract `/explore` already has for an invalid permalink. `/airport/SEA?y=1999` 200s (the
airport itself is fine) with `unknown year '1999' — this dataset covers 2015–2026`, stated on
the page and `no-store` on the response; it does not quietly render the trailing-12 default the
way a lesser implementation might reason "well, *some* view is safer than an error." That
reasoning is exactly the failure class CLAUDE.md's Explorer section and this file's own 404
rows both already refuse.

Mutant table (`lib/year.ts`, `proxy.ts`; task-9-brief.md Step 7 — run and reverted, `git status`
confirmed clean after each):

| # | Mutation | Test(s) reddened |
|---|---|---|
| 1 | `parseYear`'s range check removed (accepts any 4-digit string) | `year.test.ts`'s two boundary tests (`EARLIEST_YEAR - 1`, `"9999"`) **and** `proxy.test.ts`'s "declines to cache an airport page with an out-of-range year" |
| 2 | `/airport` branch in `proxy.ts` set to unconditional `no-store` | `proxy.test.ts`'s "still caches an airport page with a valid year" (**and** four other cache-positive airport tests, confirming the branch is live rather than a no-op) |
| 3 | `yearTrack` marks every year `partial: false` | `year.test.ts`'s "marks 2026 partial and 2025 complete" |

Mutant 1 is the pair the brief calls out by name: a `no-store`-everywhere implementation would
pass "declines to cache … out-of-range" *vacuously*, so mutant 2 — the other half — has to
redden independently for either result to mean anything. It does.

### `/explore`'s query VALUES — bounded at the origin, because a pure function can decide them

The key gate above closes which query KEYS a path reads. It closes nothing about their VALUES, and
the value axis was the larger of the two (#52). `decode()` validates *identifiers* against the
catalog through `renderPivot`; it never validates a value. Measured against the real codec before
the fix, every one of these decoded cleanly and rendered a distinct 200 under `HTML_CACHE`:

| key | what constrained it | family |
|---|---|---|
| `t` | `MONTH_RE` (`/^\d{4}-(0[1-9]\|1[0-2])$/`) only — 10,000 × 12 values per side, and nothing required `from ≤ to` | **1.44×10¹⁰** ordered pairs |
| `n` | `parsePyInt` — any integer at all | unbounded |
| `n`, `v` | nothing: `n=25`, `n=025`, `n=0025`, … `n=%32%35`, `n=%2B25`, `n=2_5` all decode to 25 | unbounded **again**, in spelling |
| `t`, `k`, `d`, `m`, `s`, `g` | nothing: `decode()` percent-decodes at `urlstate.ts:179` and checks the shape 35 lines later at `:214`, so every byte may be sent literally or as `%XX` in either hex case | **110,592** spellings of `t=2015-01:2015-12` alone (2¹² digits × 3² hyphens × 3 for the colon) — ~**1.1×10⁹** with the ordered pairs above, before `k`/`d`/`m`/`g`/`s` multiply it |
| `d`, `m` | nothing: split on `,`, and neither `normalizeQuery` nor `renderPivot` dedupes | unbounded in the NUMBER of repeats of one token |

**A shape regex downstream of `pyUnquote` is not a spelling bound.** `MONTH_RE` pins `t` to four
digits, a hyphen and a two-digit month — of the *decoded* value, which is the one thing it can
never constrain the bytes to. The same holds for `URL_TO_GRAIN` on `k`, `URL_TO_GROUPING` on `g`
and the catalog allowlist on `d`/`m`/`s`: each validates a token that `pyUnquote` has already
produced. Measured on a served build, all of these returned **200, `s-maxage=3600`, and a
byte-identical 36,632-byte page**: `t=2025-05:2026-04`, `t=%32025-05:2026-04`,
`t=2025-05%3A2026-04`, `t=2025-05%3a2026-04` and
`t=%32%30%32%35%2D%30%35%3A%32%30%32%36%2D%30%34`. `m=seats,seats,seats` returned 42,420 bytes and
`m=seats`×200 returned 661,824 — distinct pages, all cached, all unbounded.

Bounding a value's *range* therefore reduces the family by nothing on its own, on any key. That is
true of `n` (`n=25`, `n=025`, `n=0025`, …), of `v` (`v=1`, `v=01`, `v=+1`, `v=%31`), and equally of
every textual key.

**The bound is a SERVER ADMISSION policy, not a codec check, and that placement is load-bearing.**
`docs/product/features.md` states the codec's contract as *"Reference implementation:
`pipeline/urlstate.py`; the TypeScript port must match it exactly"*, and `pipeline/urlstate.py`
records the reversed range as a **"Known accepted gap … Not guarded here on purpose"** — a
judgement about *meaning* (a backwards range is a plausible reading that returns zero rows) made by
a module that runs in CI and never faces a CDN. Putting the bound inside `decode()` would silently
make the port stricter than the spec it is pinned to and falsify a shipped product doc, and would
make a frozen public codec depend on `new Date()`. So `app/src/lib/pivot/bounds.ts` owns the rule
and `decodeRequest` composes it with the codec — exactly the relationship `lib/year.ts` already has
with `/airport`'s `y`, where no codec owns `parseYear` either. `bounds.test.ts` pins the boundary
from the other side: bare `decode()` must still accept every value above.

**One wiring point, three entry points.** `proxy.ts`'s `isExploreCacheable`, `/api/pivot`'s handler
and `ExploreView` all call `decodeRequest` instead of `decode`, and every downstream behaviour then
already existed: the proxy's `catch` answers `no-store`, the handler's `instanceof UrlStateError`
answers **400** + `no-store` (never a 307 — a JSON endpoint must not redirect an XHR), and the page
renders its named "This permalink can't be read" error with the message wired through. A fourth
entry point copying three lines out of four is the failure `ENTITY_ROUTES` and `QUERY_ROWS` are both
tables to prevent; this is the same defence.

**`/api/pivot` is in scope deliberately.** Its `QUERY_ROWS` row already declares `keys:
ALLOWED_KEYS` — "the SAME keys as /explore, and for the same reason" — and its *successes* carry
`PROJECT_CACHE`, thirty days, ten times any HTML page here. Excluding it would have left the
**longer-lived** unbounded family outside the fix, which is the `exempt`-means-the-rules-are-off
misreading that already left this exact path's `&&` axis a 30-day-cached 200.

The rules, and why each bound is the one it is:

- **`t`'s months must fall in a year `parseYear` already accepts**, i.e. `2015-01` through the
  current wall-clock year's December. Not a second constant: `monthInWindow` calls `parseYear`, so
  `y` on `/airport/:code` and `t` on `/explore` cannot disagree about which months this dataset
  covers. Wall-clock, never a literal year, for the reason the `y` section above already gives.
- **The upper bound is YEAR-END, not the current month.** `/airport/ORD?y=2026` maps through
  `yearWindow(2026)` to `2026-01 → 2026-12`, months past `asOf`; a month-tight bound would refuse on
  `/explore` the very window `/airport` hands the user, to save four months out of 144. Months past
  `asOf` simply return no rows.
- **`from ≤ to`, with `from == to` allowed** — a single-month query is legitimate and `encode()`
  emits it.
- **`n ≤ 1000`.** An order of magnitude above the largest `n` this product ever puts in a permalink
  (100). Measured on a served build, one query at three limits: n=25 → 73,300 bytes; n=100 →
  240,014; n=1000 → **2,225,172** (~2,225 bytes per row, since the Explorer has no pagination and
  every row ships twice, body plus RSC payload). The ceiling costs 2.2 MB, comparable to
  `/sitemap.xml`; what it refuses is `n=100000`, a ~220 MB response this box would have built and
  let a CDN store once per spelling.
- **`n`'s lower bound is NOT restated here.** `render.ts` already rejects `limit <= 0` by name and
  `decode()` runs `renderPivot` first, so `n=0` keeps the accurate "limit must be a positive
  integer" message. A second validator for one boundary is how two rules drift into disagreeing;
  `bounds.test.ts` pins that `checkBounds` stays silent about it.
- **`n` and `v` must be spelled as a plain decimal**, checked on the RAW bytes before `pyUnquote` —
  `%32%35` unquotes to `25`, so a check that runs after decoding cannot see the difference.
- **`t`, `k`, `d`, `m`, `s` and `g` must carry no `%` at all**, on the same raw bytes and for the
  same reason. The rule is deliberately *not* a second shape regex per key: `pyUnquote` returns its
  input unchanged when it contains no `%` (`urlstate.ts:62`), so once these bytes carry none, the
  raw bytes **are** the decoded value and every validator that already exists — `MONTH_RE`,
  `URL_TO_GRAIN`, `URL_TO_GROUPING`, the catalog allowlist — pins them directly. One value, one
  spelling, without `bounds.ts` restating a single one of those shapes. That is the same
  drifting-duplicate-validator rule that keeps `n`'s lower bound in `render.ts`.
- **`f` is exempt from that rule, and the exemption is load-bearing.** `encode()` builds it as
  `f=${quote(key)}:${values.map(quote).join(",")}`, so a filter value legitimately carries `,`,
  `:`, `&`, `=` and spaces — golden case 8 is `f=op_airline_id:2T%20%281%29,O%27Hare,…`. Banning
  `%` there would break permalinks this product has already shipped. Both `bounds.test.ts` and
  `app/smoke.sh` assert the exemption, so a blanket "no `%` anywhere" reddens rather than ships.
- **No token may repeat in `d` or `m`.** This one is invisible to a spelling rule (every repeat is
  spelled the one legal way) and to a range rule, and it is not a codec question either: `encode()`
  cannot emit one, since a repeated dimension is a duplicate `GROUP BY` key that changes no row and
  a repeated measure is a duplicate `SELECT` alias. Order is left alone — `d=a,b` and `d=b,a` are
  genuinely different pivots.

Result: every remaining family is **one cache key per distinct query**, rather than unboundedly
many per query — which is the claim this fix can actually make, and the one worth making. `t`'s
value axis is 10,440 ordered pairs today (the count is wall-clock-dependent: 144 months now, 156
from 2028, because `parseYear`'s upper bound advances every January) and `n`'s is 1,000. What is
*not* bounded to a small number is the count of distinct queries the catalog can express —
ordered subsets of the dimension and measure allowlists — and that is a property of the product
being expressive, not of the URL grammar being loose. Every rule above is decided by a pure,
synchronous, database-free function on the request hot path, the same shape as `parseYear`.

Mutant table (run and reverted; each edit was read back off disk before its result was believed,
and every touched file checksummed identical afterwards):

| # | Mutation | Test(s) reddened |
|---|---|---|
| 1 | `parseYear` drops its LOWER bound | `bounds.test.ts` "rejects a month before the data window" only — the upper-bound test stayed green |
| 2 | `parseYear` drops its UPPER bound | "rejects a month past the current calendar year" only |
| 3 | `checkBounds` rejects everything | **16**: all seven `checkBounds` positives (four "accepts …" boundary tests, both message tests, and "does NOT restate the positive-integer rule that renderPivot already owns"), all seven `decodeRequest` wiring tests, and both shipped-permalink corpora — the anti-vacuity control for 1–2. It does **not** redden "keeps renderPivot's own message for a non-positive limit": `decode()` runs first and throws there before `checkBounds` is consulted |
| 4 | `from ≤ to` deleted | "rejects a reversed range whose two months are BOTH inside the window" only |
| 5 | ordering written strict (`>=`) | "accepts a single-month range, where from equals to" only |
| 6 | `n` ceiling deleted / off-by-one (`>=`) | "rejects a limit above MAX_LIMIT" / "accepts MAX_LIMIT itself" respectively |
| 7 | `checkBounds` restates the positive-integer rule | "does NOT restate the positive-integer rule that renderPivot already owns" |
| 8 | `decodeRequest` never calls `checkBounds` | **only** the `decodeRequest` wiring tests — all eleven `checkBounds` unit tests stayed green, which is what makes them a separate claim from the wiring |
| 9 | spelling regex loosened to `PY_INT_RE`'s own set | all five spelling tests |
| 10 | `v` dropped from the numeral keys | the two `v` tests only |
| 11 | the bound moved INTO `decode()` | "bare decode() is untouched" — the port-parity boundary |
| 12 | ceiling lowered to 24 | both shipped-permalink corpora (9 goldens, 8 hardcoded hrefs) |
| 13–15 | each entry point reverted to bare `decode()` | that entry point's four/five negatives, with its control green in every case |
| 16 | `/explore` branch forced to unconditional `no-store` | "still long-caches the SAME query with every value in bounds" — the control's own control |
| 17 | `decodeRequest` made a pass-through, **on a served build** | 16 of the then-26 new `app/smoke.sh` checks; all four served controls stayed green |
| 18 | `t` dropped from `LITERAL_KEYS` | its three `checkSpelling` tests (encoded digit, encoded structural colon, lowercase hex) and `decodeRequest`'s "rejects a percent-encoded t" — **4**, and nothing else |
| 19, 28–30 | `d`, `k`, `m`, `s` dropped from `LITERAL_KEYS`, one at a time | that key's own named test only — 2 for `d` (it also owns the encoded-comma test), 1 each for `k`, `m`, `s`. One test per key exists so a single-key regression names itself |
| 20 | `g` dropped from `LITERAL_KEYS` | "rejects a percent-encoded g" only |
| 21 | `f` **added** to `LITERAL_KEYS` (a blanket "no `%`" rule) | "leaves f alone, because percent-encoding is that key's own escape mechanism" **and** "accepts every one of the 9 golden URLs" — the exemption is pinned from both sides |
| 22 | the `%` scan narrowed to well-formed uppercase escapes (`/%[0-9A-F]{2}/`) | "rejects LOWERCASE hex, which doubles the family again per encoded byte" only |
| 23 | `checkSpelling` rejects everything | **11**: every `checkSpelling` positive, four `decodeRequest` wiring tests, and both shipped-permalink corpora — the anti-vacuity control for 18–22 |
| 24 | the repetition rule deleted | its three `checkBounds` tests, its message test, and `decodeRequest`'s "rejects a repeated measure" — **5** |
| 25 | the repetition rule applied to `m` only | "rejects a repeated dimension" only |
| 26 | repetition compared as ADJACENT neighbours (`tokens[i] === tokens[i-1]`) | "rejects a repeat that is not adjacent" and the message test — `a,b,a` walks straight past a neighbour compare |
| 27 | `decodeRequest` composes `checkBounds` only | the three spelling wiring tests only; the repetition wiring test stays green, because that rule lives in `checkBounds` — which is what makes the two separate claims |


### What the proxy's query actually costs

Calling this *"one extra read of dimension-sized tables … on a request that is about to run a
much larger pivot"* would be **wrong by roughly an order of magnitude, and in the direction
that matters** — the pattern is repeated on four pages. The numbers, read-only against the built database,
`memory_limit=1GB`, five warm runs, at DuckDB's default thread count (which is what the
server runs with — `db.ts` never sets `threads`) and, in brackets, capped to `threads=2`:

| Query | At `6a6b11c` | Now | Note |
|---|---|---|---|
| `lookup_airport_by_code.sql` (the proxy's, and the page's) | 43–51 ms [same] | **8 ms** [17 ms] | filters `dim_airport` by presence in `fct_segment_month` — 3.36 M rows, not a dimension read |
| `lookup_airport_code_exists.sql` (404 reason only) | 1.8–2.4 ms | unchanged | genuinely dimension-only |
| A `/route/JFK-LAX` carriers pivot | ~7–9 ms | unchanged | the query the lookup precedes |
| `lookup_carrier_by_code.sql` (`/carrier/*`) | — | **3.6–3.7 ms** | same method; correlated `EXISTS` was 15.1–15.8 ms |
| `lookup_aircraft_by_name.sql` (`/aircraft/*`) | — | **4.6–4.8 ms** | same method; correlated `EXISTS` was 23.2–24.5 ms |

The carrier and aircraft rows were measured in the same run as the `lookup_airport_by_code.sql`
row above, which reproduced at 8.5–9.1 ms — so they are comparable rather than merely adjacent. Both are
cheaper than the airport lookup because they probe a single fact column instead of a union of
two; both use `IN (SELECT DISTINCT col …)` rather than the plain `IN (SELECT col …)` for the
same reason `UNION` beat `UNION ALL` there — 114 and 112 distinct probe values against 3.36 M.

**`/route` runs TWO pivots, and the second one is the larger.** Measured **in-process**, through
`runPivot`/`fetchAircraftMix` against the built database on `/route/JFK-LAX`, warm, median of
8 runs at DuckDB's default thread count — so each figure includes that call's own
`loadAllowlist()` (two catalog reads) and `resolveRows()`, i.e. what the page actually pays,
not the bare SQL:

| Work | Rows | Warm median |
|---|---|---|
| carriers pivot, trailing 12 | 5 | **10.9 ms** |
| aircraft-mix pivot, full window | 996 | **20.0 ms** |
| the two **serially awaited** | | **30.1 ms** |
| the two under `Promise.all` | | **20.2 ms** |

They share nothing — different windows, different dimensions, and `connect()` hands each its
own `DuckDBConnection` off the single memoized instance — so the serial form pays for
both in turn for no reason. Concurrent, the pair costs what its slower half costs: **a 33%
saving on the page's DB work, for free.** Every multi-pivot page uses `Promise.all` for that
reason.

**`/airport/<code>` runs THREE pivots per request**: the carriers table/stat-strip pivot
(`fetchAirportTraffic`), the fleet-mix chart pivot (`fetchAirportMix`), and the network-map
pivot (`fetchAirportNetwork`) — `page.tsx:269-273`.

**That count is what `endpoint_airport_id` buys.** An airport is both endpoints, and without a
first-class either-endpoint filter each of the page's two grains has to be assembled as
`origin + dest − (origin ∧ dest)` — three pivots each, six for the page.
`endpoint_airport_id` (`filter_only`, `filter_mode='either'`, compiling to
`(origin_airport_id IN (...) OR dest_airport_id IN (...))`) collapses both unions to one pivot
apiece. The six-pivot form measured **54.2 ms** under `Promise.all` and saved only 16% over
serial, against this page's 41% — six full scans of `fct_segment_month` contend for the same
buffer pool, so the wave costs more than its slowest member. It was 2.7× `/route`'s DB work per
page, on the pages most likely to be linked, and it did not yet include the network map.

In-process, warm, median of 8 (first two discarded as JIT/cache warm-up), through the real
exported functions (`fetchAirportTraffic`, `fetchAirportMix`, `fetchAirportNetwork`) against
the built database, on `/airport/SEA`, trailing-12 window for the traffic and network pivots,
full window for the mix pivot:

| Work | Warm median |
|---|---|
| traffic pivot (carriers table + stat strip) | 21.6 ms |
| mix pivot (fleet chart, full window) | 26.9 ms |
| network pivot (map) | 22.4 ms |
| all three under `Promise.all` | **40.0 ms** |
| all three serially | 68.1 ms |

Concurrency saves **41%** (68.1 ms → 40.0 ms), because three concurrent scans contend for the
buffer pool less than six do. Three pivots at ~22-27 ms apiece, concurrent, costs about what
`/route`'s two-pivot page costs (20.2 ms, above) plus roughly one more query's worth of
contention.

A direct read-only measurement of the mix query alone, at `threads=2` rather than the default,
puts it at 30–34 ms; a measurement of this query that omits its thread count and whether the
allowlist read is inside it is not comparable to another one.

The old form is **identical at 2 threads and at 12** — it does not parallelise, which is
itself the tell that it was re-scanning rather than probing. Both figures reproduce; a
measurement of this query that omits its thread count is not comparable to another one.

The lookup ran a correlated `EXISTS (… WHERE f.origin_airport_id = id OR f.dest_airport_id
= id)`. The `OR` across two columns defeats a hash semi-join, so DuckDB re-scanned the fact
table per candidate row. Rewriting it as a semi-join against `origin ∪ dest` is 5.5× faster
(2.7× at two threads) and selects exactly the same airports — proven exhaustively over every `is_latest` code
against the real database, not sampled: `pipeline/tests/test_resolution_invariants.py`'s
`test_reverse_lookup_selects_exactly_the_fact_present_current_airports` diffs the shipped
file's result set against the `EXISTS` form's, both directions, and a mutation that drops
only destination-only airports fails it by 50 rows.

**It is still the largest single query on the route path**, and a 404 runs it twice (proxy,
then `not-found.tsx`'s reason) with no CDN absorption, over an unbounded URL space.
Cloudflare rate limiting is the front door for that (CLAUDE.md § Architecture). Do not
"optimise" it by dropping the fact-presence filter: that filter is what takes colliding
airport codes from 36 to 0, and `AUS` resolves to an airport closed since 1999 without it
([invariants.md § Entity resolution](../data/invariants.md)).

### One `DuckDBInstance` per process — and it takes `globalThis` to get there

**A module-level memo in `lib/db.ts` is three memos, not one** — so the proxy's query does not
run against an already-memoized `DuckDBInstance` unless the memo is on `globalThis`. Turbopack
emits the module into a separate server chunk per entry graph, and each chunk carries its own
copy of the module's state, so a module-level `let instance` was **three** memos. Measured
against `next build` output:
`access_mode` — a string that occurs only in `getInstance()` — appears in three emitted
chunks (proxy, page SSR, route handler), and open fds on `upgauge.duckdb` in the single
`next-server` process climbed **1 → 2 → 3** as `/`, `/route/JFK-LAX` and `/api/pivot` were
each hit for the first time.

Two consequences, one of them a live route back to the bug above:

1. **Three snapshots.** The three instances open at three different moments and each pins
   an inode for the process's life. If the database file were replaced between the proxy's
   open and the page's, a pair present in the proxy's snapshot and absent from the page's
   would get a long-cached header (`HTML_CACHE` today, `s-maxage=2592000` when this was
   the value before the `HTML_CACHE` split — the RISK described here is unchanged by
   which constant HTML pages carry) on a 404.
2. **Three buffer pools**, each defaulting to ~80% of system RAM, with no coordination
   between them, on an 8 GB box.

`db.ts` now memoizes on `globalThis` instead. The three chunks are plain `require`s in one
Node process, not vm contexts, so they share it: the same fd count stays at **1** after all
three entry points are hit. `app/smoke.sh` asserts that against a served build — no unit
test can, because a test has one module graph by construction. If a future Next isolates the
proxy into its own realm, this degrades to exactly the old behaviour (one memo per realm)
rather than breaking, and that smoke check is what would say so.

### `app/smoke.sh` served its checks through npx's cache, not the pinned `next`

**The gate that exists to catch production-only bugs was serving its checks under a Next this
repo does not pin.** `app/smoke.sh` started every server with `next start app -p "$PORT"` via
`npx`, run from `$ROOT` — but there is no root `node_modules` and no root `package.json`, so npx
cannot resolve `app/node_modules` and falls back to its own cache instead. Traced 2026-08-09: it
resolved `~/.npm/_npx/8b377f6eec906bc4/node_modules/next`, a cached download that happened to be
`16.3.0`, the exact version `app/package.json` pins (`"next": "16.3.0"`, not a range). On a cold
npx cache — a fresh clone, a fresh CI runner, a cleared `~/.npm` — npx fetches `next@latest`
instead, serving the gate's checks under a Next this repo never pinned, tested, or shipped. CI
runs `make app-smoke` through this same code path, so the exposure was not local-only.

**Fix:** `app/smoke.sh` resolves `NEXT_BIN="${ROOT}/app/node_modules/.bin/next"` directly, fails
loudly if it is missing (`make install` not run), and asserts the installed
`next/package.json` version equals `app/package.json`'s declared `"next"` pin — a plain string
equality, since the pin is exact — before starting anything. One `serve_next <port> <logfile>
[VAR=value...]` function wraps all four servers this script starts (the primary server and the
three gap-check servers), so the pinned binary cannot be reintroduced as `npx` at one call site
and missed at the others.

### One canonical key set per cacheable URL

**Key set, not spelling.** The gate decides by byte-equality over the query *keys* a path reads.
Key *order* survives and *values* are never inspected, so a cacheable URL still has many spellings
— see § What this does not close, below. The wider claim ("exactly one cacheable spelling") is what
this section, `CLAUDE.md` and `canonicalQuery.ts`'s own header all said first, and it was never
true of anything that shipped.

Cloudflare's default cache key includes the full query string, so an unknown query key is not
cosmetic: it is a distinct cache entry, and `?x=1…N` is an unbounded family of them, each a
guaranteed origin miss. Measured on a served build at `4aa8087`, before the gate:

| request | status | `Cache-Control` |
|---|---|---|
| `/watch?x=1` | 200 | `s-maxage=3600` |
| `/airport/ORD?y=2019&junk=1` | 200 | `s-maxage=3600` |
| `/carrier/DL?utm_source=x` | 200 | `s-maxage=3600` |
| `/route/JFK-LAX?cachebust=99` | 200 | `s-maxage=3600` |
| `/explore?…&bogus=1` | 200 | `s-maxage=3600` |
| `/sitemap.xml?x=1` | 200 | `s-maxage=2592000` — 2.4 MB, ~45 ms of DuckDB, 30 days |
| `/robots.txt?x=1` | 200 | `s-maxage=2592000` |
| `/api/pivot?…&bogus=1` | 400 | `no-store` — already closed, in the handler |
| `/search?q=DL&x=1` | 307 | `no-store` — never cacheable |

`/` is missing from the rows above for a different reason, not a survivor of this bug: at
`4aa8087` it had not yet joined `proxy.ts`'s matcher and returned Next's own
`private, no-cache, no-store, max-age=0, must-revalidate` unconditionally, so a junk query on it
changed nothing — there was no long-cached response yet for one to corrupt. Once Task 1 landed,
`/` joined the same exposure the seven rows above demonstrate, for **ten** paths the proxy gates
(the seven shown, plus `/aircraft/:name` and `/watch/:preset`, both the identical mechanism as a
row already shown). `/api/pivot` is an **eleventh** cacheable path — its own successful responses
take the identical `PROJECT_CACHE` value `/sitemap.xml` and `/robots.txt` do — and it is closed by
its own handler rather than by the proxy (§ `/api/pivot` closes its own, below). `/search` alone is
never cacheable, gated or not, which makes twelve matcher entries in all.

`app/src/lib/canonicalQuery.ts` declares the legitimate query keys for every matcher path — the
third list, alongside `ENTITY_ROUTES`, that the app's cacheable surface depends on. Only agreement
with `config.matcher` is asserted by its own test (`canonicalQuery.test.ts`): `QUERY_ROWS` (12
rows, one per matcher entry) is a strict superset of `ENTITY_ROUTES` (3 rows), so row-for-row
agreement with the latter isn't a property that test could assert. An unknown key gets a **307 to
the canonical URL under `no-store`**, answered before any database probe: origin cost is ~0 instead
of a full render, the CDN stores nothing, and a visitor arriving with a tracking param still lands
on the page. A duplicated key gets `no-store` with **no**
redirect — there is no canonical form, because choosing one occurrence renders a different query
than the URL encodes, which is `decode()`'s own reason for erroring on duplicates.

**The predicate is byte-equality against the canonical string, not "were any unknown keys
present".** `?&`, `?&&`, `?&&&…` carry no key to reject and were each a distinct cacheable entry;
byte-equality closes that axis, and a trailing `&` and a leading `?` with it.

**Key *order* survives, and the reason this document gave for that was false.** It read "a bounded
family the app emits itself, not an attacker-chosen one". `encode()` emits exactly one order
(`urlstate.ts`), so every *other* permutation of `/explore`'s nine keys is chosen by whoever typed
the URL — up to 9! = 362,880 of them, more once repeated `f` interleavings are counted, each a
distinct one-hour entry backed by a full DuckDB render. The decision to preserve order stands on a
different ground: that family is **finite and bounded**, where `?x=1…N` is not bounded at all, and
the two cures are both worse than the disease. Redirecting to a fixed order rewrites permalinks
people already hold and made their screenshots from; and the byte-for-byte rejoin that preserves
order is the same mechanism that keeps a percent-encoded `,` inside a filter value intact
(`skipProxyUrlNormalize`'s whole reason for existing). Accepted, not closed.

**A leading `?` is a spelling, not a wiring bug — and calling it one 500ed the entire site.** An
earlier revision of `canonicalize()` threw on a `rawQuery` starting with `?`, documented as
something "a real request can [not] trigger through correct wiring". `proxy.ts` derives that value
with `new URL(request.url).search.replace(/^\?/, "")` — **non-global**, so it strips one `?` of
two — and `proxy()` has no `try`/`catch` around the call. Measured end to end against a served
build, first at `d109845` and again in the fix wave by restoring the throw on top of the fix
(mutant 8, below):

| request | with the throw | now |
|---|---|---|
| `/watch?x=1` | 307 `no-store` → `/watch` | 307 `no-store` → `/watch` |
| `/watch??x=1` | **500** | 307 `no-store` → `/watch` |
| `/watch???` | **500** | 307 `no-store` → `/watch` |
| `/route/JFK-LAX??cachebust=99` | **500** | 307 `no-store` → `/route/JFK-LAX` |
| `/airport/ORD??y=2019` | **500** | 307 `no-store` → `/airport/ORD?y=2019` |
| `/sitemap.xml??x=1` | **500** | 307 `no-store` → `/sitemap.xml` |

Reachable on all twelve matcher paths — `/`, `/sitemap.xml` and every entity page included — by any
client, with no auth and no unusual encoding, and `?x=1…N` behind a doubled `?` is itself an
unbounded family of origin-hitting 500s: the exact cost shape this branch exists to close, minted
by the branch itself. At `4aa8087`, before the gate existed, the same URL was an ordinary
long-cached 200 — *derived, not re-measured*: no branch there read the query string at all, so
`/watch??x=1` took the identical path to `/watch`, which that commit's own row above records as
200 `s-maxage=3600`. The fix is that the module is **total**: rule 0 drops the whole leading run
of `?`s (the whole run, so `/watch??x=1` and `/watch???x=1` land on the same URL rather than
forming a chain) and byte-equality then produces the redirect. `canonicalQuery.test.ts` asserts
totality over a corpus of hostile inputs, and asserts that every `strip` location is itself clean —
the proxy 307s to it, so a location that would strip again is a redirect loop. No check in
`app/smoke.sh` used a doubled `?`, which is why neither `make app-smoke` nor `make image-smoke`
saw a 500 on every gated path; the section-15 loop carries three of them now.

### `/api/pivot` closes its own — `exempt` means the proxy does not redirect, not that the rules are off

`canonicalQuery.ts` declared `/api/pivot` exempt, justified by "the handler owns its own Response:
400 + `no-store` on an unknown key". True, and irrelevant to the keyless axis. `urlstate.ts`'s
`splitPairs` does `if (!chunk) continue`, so `/api/pivot?<valid permalink>&`, `&&`, `&&&`… all
decode cleanly and the handler returned **200 under `public, s-maxage=2592000`** — 30 days, ten
times longer than any HTML page the proxy's gate protects, each entry a full pivot render, on the
one path this section had declared closed. Measured by disabling the gate on top of the fix: a
trailing `&`, `&&`, `&&&` and a *leading* `&` all returned 200 under
`public, s-maxage=2592000, stale-while-revalidate=86400`. Key *order* is a separate axis, open on
this path exactly as on `/explore` and not closed by any of this.

So `exempt` now means only **"the proxy does not redirect this path"**. The rules apply to every
row: `queryVerdict()` evaluates them for all twelve, and `canonicalize()` — the proxy's entry point
and only that — answers `clean` for an exempt row. `app/api/pivot/route.ts` calls `queryVerdict()`
itself and answers **400 + `no-store`**, the same as it already does for an unknown key. It does
not 307: a redirect is a worse answer to an XHR than a named error, and that ruling is unchanged.
Neither side restates a rule — a second copy of the key table is what the module exists to prevent.

Two consequences worth stating plainly:

- **A behaviour change on a public endpoint**: `/api/pivot?<valid>&&` went from 200 to 400.
  Deliberate. `/api/pivot`'s row also had to stop lying — it read `keys: NO_KEYS`, harmless only
  while nothing evaluated it, and would have 400ed every real API query the moment something did.
  It now carries `ALLOWED_KEYS` and repeatable `f`, the same as `/explore`, because both entry
  points hand the identical raw string to the same `decode()`.
- **`/search` is untouched.** It is `no-store` unconditionally and must never redirect, so nothing
  consumes its verdict. Its row states its real key (`q`) anyway, because a row that lies is one
  wiring change away from acting on the lie.

### What this does not close

Written in the same idiom as § The gap, and for the same reason: a permanent doc that reads as if
`/explore` were finished is worse than one that names what is left.

**Every key but `f` is closed; `f` is not.** `t`'s months and their ordering, `n`'s ceiling,
one spelling per value on `v`, `n`, `t`, `k`, `d`, `m`, `s` and `g`, and no repeated token in `d`
or `m` are all bounded at the origin by `app/src/lib/pivot/bounds.ts` — see § "`/explore`'s query
VALUES" above for the rules, the measurements and the mutants. What remains open is `f`, and it
is open on **three** axes at once: `parseFilter` accepts any non-empty value list, so
`f=origin_state:<arbitrary string>` decodes; `f` is legitimately **repeatable**, so the number of
`f` tokens is unbounded as well as each one's value; and `f` is the one key **exempt from the
spelling rule**, because `quote()` must escape `,`, `:`, `&`, `=` and spaces inside a filter value,
so `%` is meaningful there rather than redundant. Every distinct spelling is a distinct 200 under
`HTML_CACHE` on the most expensive page on the site.

That exemption is not a gap that could be closed by tightening the same rule one key wider: a
filter value is warehouse text, and there is no canonical byte spelling of it to insist on without
either a catalog read or a re-implementation of `quote()`'s escaping policy inside the admission
check. It is named here rather than left implicit, and both `bounds.test.ts` and `app/smoke.sh`
assert it, so a future "simplification" to a blanket `%` ban reddens instead of shipping.

**`f` is left to the edge deliberately, and a key table could not have expressed it anyway.**
`QUERY_ROWS` maps a path to the *names* it reads. Deciding whether `f=origin_state:XX` names a real
state is a property of the WAREHOUSE, not of the URL grammar, so checking it means a catalog read on
the path that runs before every request — which is exactly what `t` and `n` did **not** need, and
why they were closed at the origin instead: both are decidable by a pure, synchronous,
database-free function, the same shape as `parseYear`. Do not generalise "values need the catalog"
from `f` to the others; that reading is what kept `t` and `n` open for a milestone.

**The thresholds `f` is left to, stated plainly rather than assumed.**
`deploy/cloudflare/rate-limit.json` blocks a source IP past **10 requests per 10 s** per
`(ip.src, cf.colo.id)`, with a 10 s mitigation timeout — a sustained **1 req/s**. Two things about
it are easy to get wrong and both matter here:

- **Its expression is `starts_with(http.request.uri.path, "/api/")`.** `/explore` is not under
  `/api/`, so **the residual `f` axis on `/explore` has no edge rate limit at all today.** The rule
  covers `/api/pivot`, where the same `f` axis rides the *thirty-day* `PROJECT_CACHE`; it does not
  cover the HTML page. Whether to extend it is its own question and is not answered here.
- **A rate limit caps rate, not cardinality.** Even where it applies, 1 req/s is 86,400 distinct
  cache entries per day per IP, each a full pivot render. It bounds how fast the space can be
  walked, never how large the space is.

Smaller, and also open: a bare trailing `?`. WHATWG URL parsing gives
`new URL("http://h/watch?").search === ""` — byte-identical to what the query-less request
produces — so `proxy.ts` cannot distinguish `/watch?` from `/watch` at all, and no rule here can.
Whether a CDN keys the two separately is the CDN's business, not measured here; the point is only
that this gate structurally cannot answer it. At most one extra entry per path either way, unlike
everything above.

**`f` is declared repeatable.** `encode()` emits one `f=` per filter and `decode()` skips its own
duplicate check for `f`, so a multi-filter permalink — the product's core shareable artifact — is
a repeated key by construction. A blanket duplicate rule would have made every one of them
uncacheable, and `app/smoke.sh` carries a fixture for a repeated key.

**The redirect's `Location` is built absolute — `new URL(canonical.location,
request.nextUrl.origin).toString()` — never the bare relative string `canonical.location` alone.**
A relative `Location` 500s every redirect on a served build: `next/dist/server/web/adapter.js`
reads `Location` off the response `proxy()` returns and calls `new NextURL(redirect,
{ forceLocale: false, ... })` with no base argument, which throws `ERR_INVALID_URL` for any
relative string — true of any response carrying a `Location` header, not a
`NextResponse.redirect()`-specific behavior (that factory's own `validateURL()` forces its
argument absolute for the identical reason). It comes back relative on the wire regardless:
`next/dist/server/lib/router-utils/resolve-routes.js` calls `getRelativeURL(value, initUrl)`
unconditionally, for any redirect status including 307, on the header this function returns.
`initUrl` is built from the server's own bind config (or the bare incoming `req.url`) and reads
the request's `Host` header at all only when `experimental.trustHostHeader` is set — unset here —
so a differing `Host` cannot produce an absolute `Location` to a spoofed origin: both
`request.nextUrl.origin` (used to build the absolute value above) and `initUrl` (used to
relativize it back down) derive from the same server-resolved request, and the two can never
disagree. Measured directly, not merely traced: spoofing the incoming request's `Host`, and
separately its `X-Forwarded-Host`, to a domain this server was never configured with still
produced a bare relative `location: /watch` in all three cases.

Routing the canonical query back through a URL serializer is the one thing this file avoids
everywhere else, so **that it survives is now pinned, not assumed**. Measured against Node's own
URL for the `RESERVED` permalink (`app/smoke.sh` §2 — every reserved character this format has to
survive, in one filter value): `new URL("/explore?" + RESERVED, origin).toString()` is
byte-identical to `origin + "/explore?" + RESERVED`. It holds because the URL query
percent-encode set is only C0 controls, space, `"`, `#`, `<` and `>` — none of `: , % + -`. Every
other `Location` assertion on this branch used an escape-free URL and would have passed against a
serializer that mangled escapes; `app/smoke.sh` §15 now asserts the wire bytes of
`/explore?<RESERVED>&bogus=1` → `/explore?<RESERVED>`, which is also the only served-build check
that `/explore` — the one row with a non-empty `keys` set — 307s a junk key at all.

`new URL(loc, origin)` is an **open-redirect shape** — `new URL("//evil.com", origin)` is
`http://evil.com/` — and it is unreachable for two independent reasons, both now asserted rather
than left to luck. No `QUERY_ROWS` predicate can claim a `//`-leading pathname (each is an exact
`p === "/literal"` or an `entitySlugFromPath` prefix test anchored at position 0), so
`canonicalize("//evil.com", …)` is `clean` and mints no `Location` at all —
`canonicalQuery.test.ts`. And Next answers `GET //evil.com` with its own 308 to `/evil.com` before
`proxy()` runs — `app/smoke.sh` §15, on a served build.

**A request carrying the `RSC` header never reaches this gate — it is answered `no-store`
unconditionally, before `canonicalize()` runs.** `skipProxyUrlNormalize` (above) is what lets the
gate see `_rsc`, Next's own cache-busting query param appended to every RSC fetch
(`fetch-server-response.js`) — no row's `keys` lists it, so the gate used to 307 it away to the
bare URL, and Next's own RSC hash check (`experimental.validateRSCRequestHeaders`, default
`true`) then 307ed straight back with the correct hash: the two redirects alternated forever.
Measured on a served build: `/`, `/explore`, `/route/JFK-LAX`, `/carrier/DL`, `/airport/ORD`,
`/watch`, `/watch/gauge` and `/aircraft/737-800` all hit the redirect cap and never settled, while
`/search`, exempt from this gate entirely, settled in its one legitimate hop regardless. The fix
gates on the **header**, not the query key: adding `_rsc` to a row's `keys` is the wrong fix,
because `_rsc` is attacker-choosable and Next validates it only when the `RSC` header is
present — a plain `GET /watch?_rsc=1…N`, no header, would sail through clean and long-cached,
reopening the exact unbounded-cache-key family this gate exists to close. Accepted cost: every
client-side navigation and prefetch (Next appends both `_rsc` and `RSC: 1` to each) always reaches
the origin instead of a CDN. Side benefit, not the reason for the fix: a shared CDN that ignores
`Vary` (Cloudflare, by default, honors only `Accept-Encoding`) can no longer serve a stored RSC
payload to a plain document request.

**`/explore` needs one more input than a key table can express:** junk *values* ride legitimate
keys, and `ExploreView` renders its "permalink can't be read" page as a **200**, so `?d=junk1…N`
was an unbounded family of cacheable error pages. Its cacheability now requires `decodeRequest()`
to succeed — the codec AND the value bounds above, in one call. Bare `/explore` is therefore
`no-store`: `decode("")` throws `missing required key 'v'`, and that URL has always been the
error page, and nothing links it: `TopBar` links `/` and
`/watch`, the front door links the full sample permalink, and `app/sitemap.ts` has no `/explore`
entry. `/api/pivot` and `/search` are declared exempt: the first answers 400 + `no-store` in its
own handler, and the second is `no-store` unconditionally, so neither has a cache entry to
pollute.

### The gap: a **5xx** still gets a long-cached header

CLAUDE.md's rule is *"404s get `no-store`"* and that is deliberately narrow. **A 500 does
not.** The proxy resolves the pair, writes the long cache, and only then does the page throw
— `dataAsOf()`, `loadAllowlist()`, `runPivot()`, or an OOM. Measured against a served build
pointed at a deliberately broken database, **before** the probe below:

| URL | Status | `Cache-Control` |
|---|---|---|
| `/route/JFK-LAX` (catalog view missing) | **500** | `public, s-maxage=2592000, stale-while-revalidate=86400` |
| `/explore?…` (same) | **500** | `public, s-maxage=2592000, stale-while-revalidate=86400` |
| `/api/pivot?…` (same) | 500 | `no-store` — the handler owns its own header |
| `/route/ZZZZ-LAX` (same) | 404 | `no-store` — unaffected |

RFC 9111 § 3 lets a shared cache store a 500 that carries an explicit `s-maxage`, so this was
a real exposure on the headline SEO-canonical URL, not a technicality.

**This is not fixable from the proxy alone.** The same shape is true of `/explore` and of every
entity page: the proxy cannot see the downstream status, and (see below) a Server Component
genuinely cannot set a response header — there is no place left that knows both "this is a 5xx"
and "headers are still writable" the way `/api/pivot`'s route handler does, unless a page ALSO
becomes a route handler, which Part B below tried and could not do without discarding the page.

**All four entity pages carry it, and the exposure scales with how many ways a page can
throw.** `/airport` is the widest: its proxy resolution succeeds first and it runs three pivots
after that, each a way to throw under a header already committed. Collapsing it from six pivots
to three (the either-endpoint filter, above) narrowed that exposure without closing it — three
ways instead of six, not zero. What follows is as much of this as is honestly closeable: Part A,
plus a fallback that bounds every page's exposure window to an hour rather than a month, since
the full fix (Part B) is not reachable at all.

**Part A: `/explore`'s missing probe, closed.** Every `ENTITY_ROUTES` row already
runs a real query (`resolve()`) before choosing a header, and already caught its own exception
— `isCacheable`'s `catch { return false; }` is what makes
`/route`, `/airport`, `/carrier` and `/aircraft` decline the cache when their
own proxy-side lookup throws. **`/explore` was the one branch that ran no query at all** — it
set the long cache unconditionally, with nothing to catch because nothing was attempted. That
is precisely why the table above shows `/explore?…` 500ing under a long-cache header: the
DB was broken (a missing catalog view), but the proxy's `/explore` branch never asked it
anything.

The fix (`app/src/proxy.ts`'s `isDataLayerHealthy()`) gives `/explore` the same shape as an
entity row: call `loadAllowlist()` — exactly what `ExploreView` calls first, before its own
try/catch, which wraps only `decode()`+`runPivot()` — and default to `no-store` if it throws.
Pinned by `app/src/proxy.test.ts`'s *"does not long-cache /explore when the proxy's own
data-layer probe throws"*, which mocks `loadAllowlist` to reject (same partial-mock shape as
`route.test.ts`/`page.test.tsx`, since this codebase has no fakes for the database itself).
Mutation-verified: changing the new `catch` to fall through to `true` (cacheable) turns that
one test red and no other — the untouched *"sets the project's Cache-Control on /explore"*
test, which runs the same code path against the real, healthy database, stays green under the
same mutant, which is what proves the new test isn't vacuous.

**What Part A does not, and by construction cannot, cover: a page-specific throw whose proxy
resolution already succeeded.** `resolveRoutePair`/`resolveAirportCode`/`resolveCarrier`/
`resolveAircraftSlug` each check dimension-table presence (`dim_airport`, `dim_carrier`,
`fct_segment_month`), not the pivot catalog — so a database broken by removing, say,
`mart_route_health` rather than `meta_pivot_dimensions` leaves every entity row's `resolve()`
succeeding while the page's own pivot still throws downstream, still under the long cache.
`/explore`'s own probe has the identical shape of blind spot one level up: `loadAllowlist()`
succeeding says nothing about `dataAsOf()` or `runPivot()`, which the page calls afterward.
Part A is a fail-safe on the query the proxy *already runs* (plus the one new query `/explore`
needed to have *a* query at all) — it was never going to be able to predict every way a page
can fail after its own resolution succeeds. That is what Part B evaluated: whether a
route-handler entry point, which owns its own `Response` and can catch what the page itself
throws, is small enough to ship for at least one page.

**Part B: the route-handler entry point, spiked and rejected — for a structural
reason, not a hard-to-reach one.** The plan was `/route/<pair>`, the simplest of the four entity
pages: give it a `route.ts` that runs the same resolution and rendering `page.tsx` does, catches
whatever throws, and returns a `Response` with its own per-outcome `Cache-Control` — closing the
gap completely for at least one page, the way `/api/pivot` already does for JSON.

**Measured, not reasoned about: it cannot be done for this page, full stop, and the reason is
Next 16 itself.** The obvious first shape — add `app/src/app/route/[pair]/route.ts` alongside
the existing `page.tsx`, so the page tree keeps rendering exactly as it does today and the
handler only wraps it — does not build:

```
$ next build   # app/src/app/route/[pair]/route.ts added, page.tsx untouched
Build error occurred
Error: Turbopack build failed with 1 errors:
./src/app
An issue occurred while preparing your Next.js app
Conflicting route and page at /route/[pair]: route at /route/[pair]/route and page at /route/[pair]/page
```

Next's own docs say the same thing in prose (`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`):
*"Route Handlers can be nested anywhere inside the `app` directory... But there **cannot** be a
`route.js` file at the same route segment level as `page.js`."* This is not a build
misconfiguration to work around — it is Next's routing table rejecting an ambiguous request
target, the same category of hard rule as "no two `page.js` at one segment."

**The only other shape — delete `page.tsx` and hand-render its tree from `route.ts`** — was ruled
out by the task's own exit condition before it was ever coded: a Route Handler is not part of
Next's page-rendering pipeline at all. Route Handlers are, in Next's own words, *"the equivalent
of API Routes"* (same doc) — they return a bare `Response`, with no access to a `layout.js`
ancestor, to `next/navigation`'s `notFound()`/`permanentRedirect()` (both throw a
digest-encoded error that only the page-rendering pipeline's error boundary interprets; a route
handler has no such boundary), to React Server Component streaming, or to the RSC flight payload
`AircraftMixChart` and every other Server Component on this page depend on being part of
(`docs/architecture/hosting.md` § "The SVG is emitted twice per response" — that duplication IS
the flight payload, and a route handler emits neither copy). Reimplementing all of that inside a
`route.ts` is not "the route-handler entry point catches a page-specific throw" — it is a second
rendering pipeline, parallel to Next's own, and the task brief's own exit condition rules that
out directly: *"If it cannot render the existing page tree without giving up layouts, streaming,
or the RSC payload... stop and take the fallback."* Both are given up by construction, not by a
weak implementation — so the second shape was never attempted, and per the brief's own scope
rule ("the spike may touch that one page and no other"), reaching for `layout.tsx` or a
hand-rolled document shell to claw either property back would itself have been the disqualifying
"outgrows that one page."

**Exit taken: the fallback.** `app/src/proxy.ts`'s `HTML_CACHE` constant is now
`public, s-maxage=3600, stale-while-revalidate=86400` (was `s-maxage=2592000`) — applied only to
the branches this file controls, `/explore` and the four `ENTITY_ROUTES` pages. `/api/pivot`
sets its own header in its own route handler and is untouched, still `s-maxage=2592000`. The
sitemap and `robots.txt` are in `proxy.ts`'s matcher and get `PROJECT_CACHE`
(`s-maxage=2592000`), gated behind the same `isDataLayerHealthy()` probe as `/explore` — the
whole-branch final review found this branch had been left unconditional (see immediately
below), which was closed in the same fix wave that wrote this paragraph, not left as still-open.
Mutation-verified in `app/src/proxy.test.ts`: reverting `HTML_CACHE` to the old
30-day value turns 10 of the file's 33 tests red (every test asserting the exact `Cache-Control`
string on a 200 or a 308) with the rest — the `no-store` assertions and the pathname/raw-query
tests — staying green, which is the same "not vacuous" property Part A's mutant demonstrated: the
tests that should be insensitive to the header's *value* stay insensitive, and the ones that
should be sensitive to it are.

**Fix wave, final whole-branch review (F4): `/sitemap.xml` and `/robots.txt` reopened this exact
gap at 30 days, gated behind nothing.** The branch that sets `PROJECT_CACHE` on those two paths
originally did so unconditionally — no `isDataLayerHealthy()` probe, unlike `/explore`
immediately above it in the same file, despite `app/src/app/sitemap.ts` running four DuckDB queries via
`lib/sitemap.ts` (`app/src/lib/sitemap.ts`) and both `parseLastmod` and `dedupeAircraftBySlug`
throwing by design on malformed input. A broken data layer therefore 500ed `/sitemap.xml` — the
one URL the entire crawl graph is submitted through — under a 30-day shared-cache header, a
*worse* exposure than `/explore`'s one-hour `HTML_CACHE` window, not a smaller instance of it.
Fixed by gating the branch on the same `isDataLayerHealthy()` probe `/explore` already uses;
pinned by `app/src/proxy.test.ts`'s `it.each(["/sitemap.xml", "/robots.txt"])("does not
long-cache %s when the proxy's own data-layer probe throws", …)`, same partial-mock shape as
Part A's own test.

**`/watch`'s branch carries the probe from the start, because F4 above is exactly
the mistake a static, closed preset set invites a second time.** `/watch/:preset` has no
`ENTITY_ROUTES` row and no per-request database resolution to fail — `presetBySlug()` is a
lookup into a fixed four-entry map, not a query — which is precisely the "it takes no user
input" shape that let F4 ship unconditional. The branch (`proxy.ts`) still gates on
`isDataLayerHealthy()` regardless, because the allow-list only answers "is this URL
well-formed", never "is the page about to succeed" — `WatchPresetView` runs a real
`mart_route_health` query per request, same as `ExploreView`'s pivot. Pinned by
`app/src/proxy.test.ts`'s `"declines to cache /watch when the data layer is broken"` and its
`/watch`-index sibling, same partial-mock shape as Part A and F4's own tests. Mutation-verified,
two mutants against `proxy.ts` alone, `npm test -- proxy` run, then reverted: dropping
`&& (await isDataLayerHealthy())` turns exactly those two tests red; replacing the whole
ternary with the unconditional `HTML_CACHE` additionally turns `"gives an unknown preset
no-store"` red (three total), everything else green. A third mutant — removing
`/watch/:preset` from `config.matcher` — left all 50 `proxy.test.ts` tests green: the suite
calls `proxy()` directly and never crosses Next's routing layer, so it cannot see the matcher
at all, the identical blind spot § "What omitting one actually costs" measures for the
`ENTITY_ROUTES` pages. **That mutant is only reachable from a served build**, never from the
unit suite.

`/sitemap.xml` is
`export const dynamic = "force-dynamic"` (`app/src/app/sitemap.ts`), serves roughly 2.4 MB, and
costs ~45 ms of DuckDB per request under `Promise.all` — measured per query: routes 35.5 ms,
airports 39.0 ms, carriers 10.2 ms, aircraft 43.6 ms (the four run concurrently, so the total is
close to the slowest one, not the sum). The CDN cache key includes the query string, so
`/sitemap.xml?x=N` is an unbounded family of origin hits regardless of the `Cache-Control` value
on the canonical path — the identical reasoning that earned `/search` its unconditional
`no-store` rather than a per-outcome header (see the table above). The canonical-query gate
closes this one (§ One canonical key set per cacheable URL, above): `/sitemap.xml?x=1` is now a
307 to `/sitemap.xml` under `no-store`, so the family costs a ~200-byte redirect each instead of a
2.4 MB document and ~45 ms of DuckDB. The `q`-shaped exposure `/search` carries is unchanged and
unclosable by this mechanism, which is why that route is `no-store` unconditionally rather than
canonicalised.

**What the fallback actually buys, honestly stated:** the exposure window for a 5xx shrinks from
up to 30 days to up to 1 hour — origin load stays near zero because `stale-while-revalidate`
still serves from the edge while it revalidates, and a broken deploy now self-corrects within an
hour of being fixed rather than within a month. **It does not close the gap.** A 500 minted at
minute 0 of its hour is still a cached 500 for up to 59 more minutes, on the headline
SEO-canonical URL, same as before — this is a smaller number, not a different shape of bug.
CLAUDE.md's "The 5xx cache gap" item should be read against this section, not
as still-open in its original form: Part A closed one concrete scenario outright (a broken data
layer that /explore's own probe would catch), and Part B's fallback bounds the rest to an hour
instead of a month — the residual page-specific-throw case above is what remains, and the three
things named in the pre-Task-7 version of this section (a route-handler entry point; a per-page
Cache-Control mechanism, if Next ever grows one; a short `s-maxage`) are now one adopted (the
short `s-maxage`) and one measured-closed (the route-handler entry point, for this Next version,
for a page with a server-rendered chart) rather than three open options.

**The "say, `mart_route_health`" example two paragraphs above (§ "What Part A
does not... cover") from a hypothetical into a measurement, against `/watch/gauge`.** A database
copy with `mart_route_health` dropped — and `meta_pivot_dimensions`/`meta_pivot_measures`
untouched — leaves `isDataLayerHealthy()` (which only calls `loadAllowlist()`) reporting
healthy, so `proxy.ts` commits to `HTML_CACHE` before `WatchPresetView`'s `runPreset()` ever
touches the missing table. Measured on a served build: **`/watch/gauge` returns `500` with
`Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`** — a cacheable 5xx, not a
declined one. The counterpart mutant (drop `meta_pivot_dimensions` instead, leave
`mart_route_health` intact) correctly 500s under `no-store`, confirming the gap is specific to
what `isDataLayerHealthy()` does and does not probe, not a general failure of the branch. Closing
this fully would mean giving that probe a `mart_route_health`-specific query of its own — the
identical extra-round-trip-per-request tradeoff already declined for `/route` and the other three
`ENTITY_ROUTES` pages, not a new decision this milestone makes differently. `app/smoke.sh`
asserts the measured behaviour as a known-open gap (§ "gap check: /watch/gauge against a database
missing mart_route_health"), the same way it does for `/explore` — except
that one is a gap CLOSED, and this one documents a gap still open.

## Server-side Observable Plot needs no bundler configuration

Charts render on the server: Plot draws into a jsdom `document` and the serialized SVG
is injected (`app/src/lib/chart/svg.ts`). The risk going in was that `jsdom` would need
`serverExternalPackages` the way `@duckdb/node-bindings` does — jsdom has dynamic requires
and native-ish dependencies, the same shape that broke the DuckDB build above.

**It does not.** Measured against Next 16.2.12 + Turbopack: `next build` compiled the server
bundle with jsdom and `@observablehq/plot` inlined, unchanged `next.config.ts`, and the
served build renders the SVG per request on a `force-dynamic` page. `serverExternalPackages`
was left at its existing two DuckDB entries. Recorded because the same component is mounted
on three more pages and should not re-litigate this.

The one thing that *was* required is a types-only dev dependency. jsdom 29 ships no
declarations, and `next build` runs `tsc` after a successful compile, so the build fails
*after* reporting `✓ Compiled successfully`:

```
./src/lib/chart/svg.ts:1:23
Type error: Could not find a declaration file for module 'jsdom'.
'/…/node_modules/jsdom/lib/api.js' implicitly has an 'any' type.
```

`@types/jsdom` in `devDependencies` fixes it; `jsdom` itself is a production dependency
because it runs at request time.

**The two are a major version apart — `jsdom@^29` against `@types/jsdom@^28` — and that cannot
currently be fixed by bumping.** Checked against the registry on 2026-07-31: DefinitelyTyped's
newest published `@types/jsdom` is **28.0.3**, which is also its `latest` tag; there is no 29.
So the skew is recorded rather than closed. Exposure is minimal and deliberately kept that way:
`svg.ts` uses exactly `JSDOM` and `.window.document`, and nothing else in the app imports jsdom
at all. Bump the day 29 ships.

**`var()` colour tokens survive into the served SVG**, so `globals.css` stays the single
source for the ramp and no hex fallback is needed. Verified on a served build in *both*
forms, which are different code paths: a constant `fill: "var(--g3)"` and — the form the
stacked area actually uses — an ordinal colour scale whose `range` is `var()` strings.
The served bytes carry `<path fill="var(--g1)" d="…">` and `fill="var(--g5)"` verbatim.

**The SVG is emitted twice per response.** Once as markup in the HTML body and once,
escaped, in the RSC flight payload that follows it (`self.__next_f.push`) — measured by
counting occurrences in a served response. That is inherent to rendering into
`dangerouslySetInnerHTML` from a Server Component, not a bug, but it doubles the byte cost
of every chart. It is the number to watch as this component goes on more pages;
a trivial two-mark probe page came to 18,762 bytes.

Measured on the real shape — 136 months × 6 bands, which is what `/route` actually renders —
one chart serializes to **28,609 bytes**, so it costs about **57 KB per response** once the
flight-payload copy is counted. Mounting this on `/airport`, `/carrier` and `/aircraft`
does not multiply a rounding error.

**The jsdom document is created once for the module, not per call**, and the reason is worth
recording because the first implementation assumed the opposite. Plot never appends its output
into the document it is given: `plot.js:156` creates the root with d3's `creator("svg")` (the
document only resolves the namespace), and `plot.js:360` returns it still detached. Measured: a
shared document grew **0 bytes across 25 renders**. Sharing it takes a render from **8.59 ms to
3.93 ms** — `new JSDOM()` alone is **5.21 ms**, more than the entire plot — on a `force-dynamic`
page that pays this on every cache miss.

**`svg.test.ts` pins the no-accumulation property, and the obvious way to write that test
cannot.** Asserting `mark().length === first.length` — the byte length of the **returned,
detached node**, across repeated renders — does not see the regression: appending that node to
the shared document does not change the node's own `outerHTML`, so the one regression the test
names is invisible to it. Demonstrated rather than
inferred: a deliberately leaky renderer doing `document.body.appendChild(node)` returned 1,384
bytes on every one of 12 renders while `document.body` grew to **16,608**, and the test stayed
green.

It now observes the document, through `sharedDocumentFootprint()` — a narrow read-only probe
exported from `svg.ts` rather than the document itself, because exporting the document would
put a DOM type on that module's public surface (its whole point is that callers stay free of
them) and hand every future caller a writable handle to the one object whose emptiness *is* the
safety argument. The probe counts `head` **and** `body` children and measures
`documentElement.outerHTML`: an injected `<style>` in `<head>` leaks exactly as much as an
appended SVG. The test asserts both zero nodes and zero growth across 12 renders, and the leaky
renderer above turns it red. So a future Plot release that starts appending now fails a test
rather than leaking memory in an always-on process.

## React's `cache()` needs an active RSC dispatcher — unprovable by unit test

Each entity page's slug resolver is wrapped in React's `cache()`
(`resolveRoutePairForRequest` in `route/[pair]/page.tsx`, and its `/airport`, `/carrier`,
`/aircraft` siblings) so `generateMetadata` and the default page export — two separate calls
Next makes for the same request (`generate-metadata.md`'s own "Memoizing data requests"
section, which shows the identical `cache(async (slug) => …)` pattern) — dedupe the DB-backed
lookup instead of paying for it twice on every successful render.

**`cache()`'s memoization is conditional on something a Vitest test cannot construct.** Its
implementation (`app/node_modules/react/cjs/react.react-server.development.js:578`) reads the
current React dispatcher and, if none is active, calls straight through:

```js
exports.cache = function (fn) {
  return function () {
    var dispatcher = ReactSharedInternals.A;
    if (!dispatcher) return fn.apply(null, arguments);   // <- no dedup, ever
    ...
```

That dispatcher only exists while Next's RSC renderer is actually rendering a request. This
project's test suite calls `generateMetadata()` and each page's default export as ordinary
function invocations (`RoutePage(...)`, not `<RoutePage />` through Next's renderer) — the same
limitation `route/[pair]/page.tsx`'s own header comment already states for a different reason,
since these tests render through react-dom's client renderer to sidestep a separate problem
(awaiting a nested async Server Component reached via JSX). No dispatcher is ever active, so
`cache()` degrades to calling straight through on every test run — a call-count assertion here
would measure the test harness's own limitation, not whether the dedup happens in production.

**This is a new member of this file's "no unit test can catch that class" list** — the same
class `smoke.sh`'s own header enumerates (`__dirname` under Turbopack, `decodeURIComponent`
throwing, `process.chdir`, the DuckDB platform-switch `require`, Next's query normalization):
a real behavior difference between test and production that every unit test, by construction,
cannot see. `make app-smoke` does not currently assert a call *count* for this either — doing
so would need either an instrumented build or a request-level trace, neither of which this
script has — so the dedup is disclosed as unverified-by-this-suite rather than silently assumed
correct. What `make app-smoke` DOES prove, indirectly: every entity page renders and resolves
correctly under a real served request, which is the scenario `cache()` is wrapped around; a
`cache()` that threw or resolved incorrectly outside a dispatcher would surface there as a
broken page, not as a missing dedup.

## If the Dockerfile ever adopts `output: "standalone"`

Next's standalone output traces the module graph and copies only what it finds. **`sql/` is
not in that graph** — `render.ts` and `db.ts` read `sql/03_queries/*.sql` with `readFileSync`
at request time, and file reads are invisible to a bundler's tracer. A standalone image would
build and start cleanly and then fail every query with ENOENT on the first request.

The same applies to `upgauge.duckdb` and `data/parquet/`, for the same reason plus the
relative-path contract above. If standalone is adopted, `outputFileTracingIncludes` has to
name `sql/**` explicitly, and the data still has to be copied in by the Dockerfile.

Recorded here rather than in the branch's working notes because those are untracked and would
have taken this with them.

## Environment variables

The server (`app/src/lib/db.ts`) reads two, and a third — read through the one shared
`app/src/lib/siteUrl.ts` module, not re-declared per call site — backs both the sitemap
(`app/src/app/sitemap.ts`, `app/src/app/robots.ts`) and the four entity pages' canonical
`<link>` tags (`app/src/app/route/[pair]/page.tsx` and its `/airport`, `/carrier`, `/aircraft`
siblings). Two more, read by `app/src/lib/health.ts`'s `identity()`, carry no functional
behaviour at all — they only label `/api/health`'s `build` field with which image and which
warehouse asset produced it. All five are optional — production sets none and gets the
defaults below, which are what the Portability test and the WORKDIR contract assume for the
first three, and what a local `next start` reports unchanged for the last two.

| Var | Default | What it's for | What breaks if it's wrong |
|---|---|---|---|
| `UPGAUGE_ROOT` | `process.cwd()` | The directory containing `data/` and `sql/` — anchors both `upgauge.duckdb`'s default location and every `.sql` file read (`sql/03_queries/*.sql`). Also passed to DuckDB as `file_search_path`, so the catalog's relative Parquet globs (`read_parquet('data/parquet/...')`) resolve against it regardless of the process's actual OS working directory. | Set to the wrong directory: every `.sql` file read fails with ENOENT, and every query against a Parquet-backed view fails with `IO Error: No files found that match the pattern "data/parquet/..."` — the exact failure the Portability test section above describes, just triggered by a bad env var instead of a bad `WORKDIR`. |
| `UPGAUGE_DB` | `${UPGAUGE_ROOT}/upgauge.duckdb` | Overrides the `.duckdb` file path directly, independent of `UPGAUGE_ROOT` — for a deploy that keeps the database file somewhere other than the repo-root default (e.g. a mounted volume). | Set to a path that doesn't exist or isn't a valid DuckDB file: `DuckDBInstance.create()` rejects and every route handler 500s. Note this does NOT relocate `data/parquet/` — that's still resolved via `UPGAUGE_ROOT`'s `file_search_path`, so pointing `UPGAUGE_DB` at a database file whose Parquet tree lives elsewhere still needs `UPGAUGE_ROOT` set to match. |
| `UPGAUGE_BASE_URL` | `http://localhost:3000` | The scheme+host every fully-qualified URL this app emits is prefixed with: every `<loc>` in `/sitemap.xml`, the `Sitemap:` line in `/robots.txt`, **and** every entity page's self-referential `<link rel="canonical">`. The sitemap protocol requires a fully-qualified URL, `sitemapEntries()` (`app/src/lib/sitemap.ts`) and the entity resolvers alike only ever return a site-relative path or a bare code, on purpose (CLAUDE.md's portability rule: no hardcoded hostname, Docker + env vars only) — a hardcoded `https://upgauge.shipman.dev` here is a Critical defect, not a shortcut. | Left at the default in a real deploy: the sitemap validates and crawls fine locally, and every entity page still renders, but every submitted `<loc>` and every canonical `<link>` points at `localhost`, so a crawler resolves none of them and every canonical tag is wrong for wherever this is actually served. |
| `UPGAUGE_BUILD_SHA` | `dev` | The git SHA the image was built from — `git describe --always --dirty --abbrev=7`, so an image built from a modified tree is labelled `a2020f0-dirty` and cannot pass itself off as the commit (`git rev-parse --short HEAD` reported the clean SHA regardless, and `image-smoke` compared against the same expression, so identity passed for an image whose contents were not that commit). One `IMAGE_SHA` variable in the Makefile feeds both the build arg and the expectation. Baked in as a Docker build arg and read by `app/src/lib/health.ts`'s `identity()`, reported verbatim in `/api/health`'s `build.sha` field. `dev` is also what a plain `next start` reports, unchanged, so local runs and the unit tests (`route.test.ts`'s `{ sha: "dev", warehouse: "dev" }` assertion) keep working without setting anything. | Left unset or wrong on a real deploy: `/api/health` still returns 200/`ok` — this var carries no correctness signal for the health check itself — but `make image-smoke`'s identity assertion (#15) now passes against a container that is not the build under test, which is the exact failure that gate exists to catch. A stale or blank SHA reported as healthy is indistinguishable from the right one until someone diffs it by hand. |
| `UPGAUGE_WAREHOUSE_TAG` | `dev` | The release tag (`warehouse-YYYY.MM`) whose `warehouse-YYYY.MM.tar.zst` asset (`upgauge.duckdb` + `data/parquet/`) is baked into this image, read the same way as `UPGAUGE_BUILD_SHA` and reported in `/api/health`'s `build.warehouse` field. | Wrong on a real deploy: `/api/health` reports a dataset provenance the image does not actually carry — a container built from `warehouse-2026.03` claiming `warehouse-2026.04` looks fresh to anyone reading the healthcheck, even though `DATA AS OF` on the served pages (read from the data itself, never this var) tells the truth regardless. This var is a label on the artifact, not a source of freshness — the freshness alert reads release `publishedAt` and the data's own `max(year_month)`, never this string ([pipeline.md § The freshness alert](pipeline.md#the-freshness-alert--the-thing-that-notices-exited-0-forever)). |

Neither of the first two is a substitute for the WORKDIR contract — they exist so the default
(WORKDIR == repo root, both vars unset) needs no configuration, while still giving an operator
an escape hatch if a deploy's directory layout genuinely can't match it. `UPGAUGE_BASE_URL` is
unrelated to that contract; it exists only because a fully-qualified URL cannot be built from a
relative path alone.
