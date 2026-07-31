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

**A hybrid stays available:** prerender the finite entity sets as static, keep the server for
route pages and the Explorer. An optimization, not a v0 requirement — but the sets are small
enough that it stays on the table. Measured against `fct_segment_month`, quarantined rows
excluded, trailing 12 (2025-05 → 2026-04) and all-time (2015-01 → 2026-04):

| Entity | trailing 12 | all-time |
|---|---|---|
| airports (`origin` **or** `dest`) | 749 | 1,041 |
| carriers | 70 | 114 |
| aircraft types | 74 | 110 |

**These `all-time` numbers are quarantine-EXCLUDED, and that makes them the wrong universe for
the sitemap** — do not quote them as "how many entity pages exist." A quarantined row
(`load_factor > 1.0`, CLAUDE.md) is still a real filing and its page still 200s, so excluding
it silently undercounts. `docs/product/scope.md` § D2 has the number that actually answers
"how many entity pages get indexed" — M5's `/sitemap.xml`, **quarantine-INCLUDED**: 1,045
airports, 114 carriers, 110 aircraft, 22,420 routes (23,689 total). Airports and carriers here
happen to be close to those figures (1,041 vs. 1,045; 114 both ways — no fact-present carrier's
entire row history is quarantined), but **aircraft types' `110` here is a different count
entirely and its match to the sitemap's `110` is coincidence, not agreement**: this row counts
distinct BTS `aircraft_type` CODES with quarantine excluded (112 codes all-time, 110 once
quarantine-only codes drop out), while the sitemap counts distinct URL-routable SLUGS with
quarantine included (112 fact-present codes → 111 distinct short names → 110 once the one
ambiguous short name, `CE-180`, is excluded — `sql/03_queries/sitemap_aircraft.sql`). Neither
this table nor a future prerender build should key its build list on this row's counts without
re-deriving them the way the sitemap does; they were computed independently and drift the
moment either changes.

The three page types together are ~1,265 all-time URLs, three orders of magnitude below the
20,000-file cap above and nowhere near a build-time problem. The route pages are the set that
is not finite in the same sense — 22,950 pairs — which is why the split is entity pages static,
routes served.

**Count airports at both endpoints, or the number is wrong by a third.** Origin-only gives 741
/ 993, and that is not a rounding difference: it is the same silent halving `pipeline.md` § M4d
measures on `/airport/SEA` (26,710,000 seats against 53,373,806). A prerender list built from
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

Data changes monthly. Every successful JSON response (`/api/pivot`) and, once M5 Task 8 wires
them into `proxy.ts`'s matcher, the sitemap and `robots.txt`, get:

```
Cache-Control: public, s-maxage=2592000, stale-while-revalidate=86400
```

**HTML page routes — `/explore` and the four entity pages — get a shorter one instead, as of
M5 Task 7:**

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
> M4d added `/airport/:code`, `/carrier/:code` and `/aircraft/:name` on that pattern, so the
> matcher now carries **six** entries: `/explore`, `/api/pivot`, and the four entity pages.

### What omitting one actually costs — measured, not assumed

M4d's three page tasks each predicted that a missing matcher entry would make every 404 on
their page a **500**, because `not-found.tsx` reads `x-upgauge-path` and throws
`MissingRawPathError` without it. Measured against a served build with `/airport/:code`
deliberately removed from the matcher, the truth is narrower and worth stating exactly:

| | With the matcher entry | Without it |
|---|---|---|
| `/airport/SEA` | 200, `public, s-maxage=2592000, …` | 200, `private, no-cache, no-store, max-age=0, must-revalidate` |
| `/airport/sea` | 308, long-cached | 308, `private, no-cache…` |
| `/airport/ZZZZ` | 404, `no-store`, names the code | **404**, `private, no-cache…`, **7,740-byte `<html id="__next_error__">` shell** |

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

The same docs (`:181`) point at a Client Component reading `usePathname()`, and that is what
M4b shipped first. It was replaced because it named only the *pair*, where four doc sites
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
> changing how the 404 renders, which nothing in M4b required.

## `Cache-Control` lives here, and it is status-blind by construction

CLAUDE.md's *"every response gets `public, s-maxage=2592000, stale-while-revalidate=86400`"*
is applied in `proxy.ts`, on the proxy's own response — not in the pages. (As of M5 Task 7,
`proxy.ts` applies that exact value only to `/api/pivot`'s own route handler, untouched by this
file, and to a future sitemap/robots matcher entry; every HTML page route gets the shorter
`HTML_CACHE` — § "The gap" below has the measurement behind the split.) It has to be applied
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

M4b implemented that for `/route/<pair>` as `resolveRoutePair(slug).kind !== "notFound"`. M4d
generalized it to four entity pages — `ENTITY_ROUTES` in `proxy.ts` is one row per page, a
`slugFromPath` prefix reader plus a resolver — and **changed the predicate to an allow-list of
outcomes, which is not a style preference:**

```ts
kind === "ok" || kind === "redirect"      // cacheable
```

`resolveAircraftSlug` has **four** outcomes, not three. `/aircraft/CE-180` resolves to
`ambiguous` — BTS codes `030` (CESSNA 180) and `031` (CESSNA 180A/B) share one `short_name`,
both really flew, and the page renders a 404 naming both. It is not `notFound`, so copying
`/route`'s `!== "notFound"` shape — the obvious thing to do, and the thing M4d's plan warned
about — would have pinned that 404 in a shared CDN cache for 30 days. An allow-list also fails
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
| `/route/JFK-LAX` | 200 | long cache | known pair |
| `/route/LAX-JFK` | 308 | long cache | re-ordering, derived from the two codes |
| `/route/ZZZZ-LAX` · `/route/JFK-LHR` · `/route/LAX-LAX` | 404 | `no-store` | unknown code · non-domestic · self-route |
| `/airport/SEA` | 200 | long cache | fact-present airport |
| `/airport/sea` | 308 | long cache | `toUpperCase()`, no lookup involved |
| `/airport/ZZZZ` · `/airport/LHR` | 404 | `no-store` | unknown code · recognized but domestic-only |
| `/carrier/DL` | 200 | long cache | fact-present carrier |
| `/carrier/dl` | 308 | long cache | canonical is `dim_carrier`'s own spelling |
| `/carrier/ZZ` · `/carrier/PA` | 404 | `no-store` | not in the catalog · in it, never filed |
| `/aircraft/B737-8` · `/aircraft/A321-LR` | 200 | long cache | fact-present type; the second exercises the slug transform |
| `/aircraft/a321-lr` | 308 | long cache | to the **slug**, never to the unroutable `A321/LR` |
| `/aircraft/NOPE-1` | 404 | `no-store` | unknown type |
| **`/aircraft/CE-180`** | **404** | **`no-store`** | **`ambiguous`, not `notFound` — the allow-list is for this row** |

**Verified by mutation on a served build, because a `check_not` that cannot fire is worse than
no check** (M4c's final review found exactly one of those). Five mutants, each applied to
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

### What the proxy's query actually costs

The first version of this section called it *"one extra read of dimension-sized tables …
on a request that is about to run a much larger pivot"*. **That was wrong by roughly an
order of magnitude, and in the direction that matters** — M4d is told above to copy this
pattern three more times. The corrected numbers, read-only against the built database,
`memory_limit=1GB`, five warm runs, at DuckDB's default thread count (which is what the
server runs with — `db.ts` never sets `threads`) and, in brackets, capped to `threads=2`:

| Query | At `6a6b11c` | Now | Note |
|---|---|---|---|
| `lookup_airport_by_code.sql` (the proxy's, and the page's) | 43–51 ms [same] | **8 ms** [17 ms] | filters `dim_airport` by presence in `fct_segment_month` — 3.36 M rows, not a dimension read |
| `lookup_airport_code_exists.sql` (404 reason only) | 1.8–2.4 ms | unchanged | genuinely dimension-only |
| A `/route/JFK-LAX` carriers pivot | ~7–9 ms | unchanged | the query the lookup precedes |
| `lookup_carrier_by_code.sql` (M4d, `/carrier/*`) | — | **3.6–3.7 ms** | same method; correlated `EXISTS` was 15.1–15.8 ms |
| `lookup_aircraft_by_name.sql` (M4d, `/aircraft/*`) | — | **4.6–4.8 ms** | same method; correlated `EXISTS` was 23.2–24.5 ms |

The two M4d rows were measured in the same run as the `lookup_airport_by_code.sql` row above,
which reproduced at 8.5–9.1 ms — so they are comparable rather than merely adjacent. Both are
cheaper than the airport lookup because they probe a single fact column instead of a union of
two; both use `IN (SELECT DISTINCT col …)` rather than the plain `IN (SELECT col …)` for the
same reason `UNION` beat `UNION ALL` there — 114 and 112 distinct probe values against 3.36 M.

**`/route` runs TWO pivots, and the second one is the larger.** M4c mounted the aircraft-mix
chart on this page without updating this table, which is the table that exists because M4d is
told above to copy the pattern three more times. Measured **in-process**, through
`runPivot`/`fetchAircraftMix` against the built database on `/route/JFK-LAX`, warm, median of
8 runs at DuckDB's default thread count — so each figure includes that call's own
`loadAllowlist()` (two catalog reads) and `resolveRows()`, i.e. what the page actually pays,
not the bare SQL:

| Work | Rows | Warm median |
|---|---|---|
| carriers pivot, trailing 12 | 5 | **10.9 ms** |
| aircraft-mix pivot, full window | 996 | **20.0 ms** |
| the two **serially awaited** (as M4c shipped) | | **30.1 ms** |
| the two under `Promise.all` (now) | | **20.2 ms** |

They share nothing — different windows, different dimensions, and `connect()` hands each its
own `DuckDBConnection` off the single memoized instance — so the serial form was paying for
both in turn for no reason. Concurrent, the pair costs what its slower half costs: **a 33%
saving on the page's DB work, for free.** M4d will copy whatever shape is here, so the shape
is `Promise.all`.

**`/airport/<code>` runs SIX, and that is the price of a filter the pivot cannot express.** An
airport is both endpoints, so each of its two grains is assembled as `origin + dest −
(origin ∧ dest)` — three pivots each (`pipeline.md` § M4d). Same method as the table above
(in-process, warm, median of 8, default threads), on `/airport/SEA`:

| Work | Rows | Warm median |
|---|---|---|
| one side of the carriers pivot, trailing 12 | 374 | 15.9 ms |
| the overlap pivot (`origin = X AND dest = X`), trailing 12 | 1 | 10.3 ms |
| the carriers union, 3 concurrent | 654 | **19.2 ms** |
| one side of the mix pivot, full window | 2,832 | 23.9 ms |
| the mix union, 3 concurrent | 2,886 | **42.3 ms** |
| all six under `Promise.all` | | **54.2 ms** |
| all six serially | | 64.3 ms |

Concurrency buys much less here than on `/route` (16%, not 33%): six full scans of
`fct_segment_month` contend for the same buffer pool, so the wave costs more than its slowest
member. **2.7× `/route`'s DB work per page**, standing, on the pages most likely to be linked.
A first-class either-endpoint filter in `meta_pivot_dimensions` — one pivot instead of three —
is the M5 fix; it needs matching composite-filter semantics in `render.ts` and
`pipeline/pivot.py`, which is why M4d did not take it on.

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

This section used to say the proxy's query runs "against an already-memoized
`DuckDBInstance`". **It did not.** Turbopack emits `lib/db.ts` into a separate server chunk
per entry graph, and each chunk carries its own copy of the module's state, so a
module-level `let instance` was **three** memos. Measured against `next build` output:
`access_mode` — a string that occurs only in `getInstance()` — appears in three emitted
chunks (proxy, page SSR, route handler), and open fds on `upgauge.duckdb` in the single
`next-server` process climbed **1 → 2 → 3** as `/`, `/route/JFK-LAX` and `/api/pivot` were
each hit for the first time.

Two consequences, one of them a live route back to the bug above:

1. **Three snapshots.** The three instances open at three different moments and each pins
   an inode for the process's life. If the database file were replaced between the proxy's
   open and the page's, a pair present in the proxy's snapshot and absent from the page's
   would get `s-maxage=2592000` on a 404.
2. **Three buffer pools**, each defaulting to ~80% of system RAM, with no coordination
   between them, on an 8 GB box.

`db.ts` now memoizes on `globalThis` instead. The three chunks are plain `require`s in one
Node process, not vm contexts, so they share it: the same fd count stays at **1** after all
three entry points are hit. `app/smoke.sh` asserts that against a served build — no unit
test can, because a test has one module graph by construction. If a future Next isolates the
proxy into its own realm, this degrades to exactly the old behaviour (one memo per realm)
rather than breaking, and that smoke check is what would say so.

### The gap: a **5xx** still gets a long-cached header — M5 Task 7 narrowed it, didn't close it

CLAUDE.md's rule is *"404s get `no-store`"* and that is deliberately narrow. **A 500 does
not.** The proxy resolves the pair, writes the long cache, and only then does the page throw
— `dataAsOf()`, `loadAllowlist()`, `runPivot()`, or an OOM. Measured against a served build
pointed at a deliberately broken database, **before** M5 Task 7:

| URL | Status | `Cache-Control` |
|---|---|---|
| `/route/JFK-LAX` (catalog view missing) | **500** | `public, s-maxage=2592000, stale-while-revalidate=86400` |
| `/explore?…` (same) | **500** | `public, s-maxage=2592000, stale-while-revalidate=86400` |
| `/api/pivot?…` (same) | 500 | `no-store` — the handler owns its own header |
| `/route/ZZZZ-LAX` (same) | 404 | `no-store` — unaffected |

RFC 9111 § 3 lets a shared cache store a 500 that carries an explicit `s-maxage`, so this was
a real exposure on the headline SEO-canonical URL, not a technicality.

**This is not fixable from the proxy alone.** The same shape has been true of `/explore` since
M3b, and of `/route` before and after the fix wave that made 404s `no-store`: the proxy cannot
see the downstream status, and (see below) a Server Component genuinely cannot set a response
header — there is no place left that knows both "this is a 5xx" and "headers are still
writable" the way `/api/pivot`'s route handler does, unless a page ALSO becomes a route
handler, which Task 7 Part B tried and could not do without discarding the page.

**M4d inherited it unchanged and widened its blast radius from one page to four.** `/airport`
is the worst of them: it runs six pivots (below), so it has the most ways to throw, and its
proxy resolution succeeds first. M5 Task 7 is what closes as much of this as is honestly
closeable — Part A below, plus a fallback that narrows every page's exposure window from a
month to an hour, since the full fix (Part B) turned out not to be reachable at all.

**M5 Task 7, Part A: `/explore`'s missing probe, closed.** Every `ENTITY_ROUTES` row already
runs a real query (`resolve()`) before choosing a header, and already caught its own exception
— `isCacheable`'s `catch { return false; }` predates this task (M4b fix wave 3) and was already
correct: `/route`, `/airport`, `/carrier` and `/aircraft` already decline the cache when their
own proxy-side lookup throws. **`/explore` was the one branch that ran no query at all** — it
set the long cache unconditionally, with nothing to catch because nothing was attempted. That
is precisely why the table above shows `/explore?…` 500ing with the (then) 30-day header: the
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

**M5 Task 7, Part B: the route-handler entry point, spiked and rejected — for a structural
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
sets its own header in its own route handler and is untouched, still `s-maxage=2592000`; the
sitemap and `robots.txt` are not yet in `proxy.ts`'s matcher (M5 Task 8's job) and so are also
untouched. Mutation-verified in `app/src/proxy.test.ts`: reverting `HTML_CACHE` to the old
30-day value turns 10 of the file's 33 tests red (every test asserting the exact `Cache-Control`
string on a 200 or a 308) with the rest — the `no-store` assertions and the pathname/raw-query
tests — staying green, which is the same "not vacuous" property Part A's mutant demonstrated: the
tests that should be insensitive to the header's *value* stay insensitive, and the ones that
should be sensitive to it are.

**What the fallback actually buys, honestly stated:** the exposure window for a 5xx shrinks from
up to 30 days to up to 1 hour — origin load stays near zero because `stale-while-revalidate`
still serves from the edge while it revalidates, and a broken deploy now self-corrects within an
hour of being fixed rather than within a month. **It does not close the gap.** A 500 minted at
minute 0 of its hour is still a cached 500 for up to 59 more minutes, on the headline
SEO-canonical URL, same as before — this is a smaller number, not a different shape of bug.
CLAUDE.md's M5 punch-list item 4 ("The 5xx cache gap") should be read against this section, not
as still-open in its original form: Part A closed one concrete scenario outright (a broken data
layer that /explore's own probe would catch), and Part B's fallback bounds the rest to an hour
instead of a month — the residual page-specific-throw case above is what remains, and the three
things named in the pre-Task-7 version of this section (a route-handler entry point; a per-page
Cache-Control mechanism, if Next ever grows one; a short `s-maxage`) are now one adopted (the
short `s-maxage`) and one measured-closed (the route-handler entry point, for this Next version,
for a page with a server-rendered chart) rather than three open options.

## Server-side Observable Plot needs no bundler configuration

M4c renders charts on the server: Plot draws into a jsdom `document` and the serialized SVG
is injected (`app/src/lib/chart/svg.ts`). The risk going in was that `jsdom` would need
`serverExternalPackages` the way `@duckdb/node-bindings` does — jsdom has dynamic requires
and native-ish dependencies, the same shape that broke the DuckDB build above.

**It does not.** Measured against Next 16.2.12 + Turbopack: `next build` compiled the server
bundle with jsdom and `@observablehq/plot` inlined, unchanged `next.config.ts`, and the
served build renders the SVG per request on a `force-dynamic` page. `serverExternalPackages`
was left at its existing two DuckDB entries. Recorded because M4d mounts the same component
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
of every chart. It is the number to watch when M4d puts this component on three more pages;
a trivial two-mark probe page came to 18,762 bytes.

Measured on the real shape — 136 months × 6 bands, which is what `/route` actually renders —
one chart serializes to **28,609 bytes**, so it costs about **57 KB per response** once the
flight-payload copy is counted. M4d mounting this on `/airport`, `/carrier` and `/aircraft`
does not multiply a rounding error.

**The jsdom document is created once for the module, not per call**, and the reason is worth
recording because the first implementation assumed the opposite. Plot never appends its output
into the document it is given: `plot.js:156` creates the root with d3's `creator("svg")` (the
document only resolves the namespace), and `plot.js:360` returns it still detached. Measured: a
shared document grew **0 bytes across 25 renders**. Sharing it takes a render from **8.59 ms to
3.93 ms** — `new JSDOM()` alone is **5.21 ms**, more than the entire plot — on a `force-dynamic`
page that pays this on every cache miss.

**`svg.test.ts` pins the no-accumulation property — but only since M4c's final review, and
this paragraph claimed it before it was true.** The original test asserted
`mark().length === first.length`: the byte length of the **returned, detached node**, across
repeated renders. Appending that node to the shared document does not change the node's own
`outerHTML`, so the one regression the test named was invisible to it. Demonstrated rather than
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
`app/src/lib/siteUrl.ts` module, not re-declared per call site — backs both M5's sitemap
(`app/src/app/sitemap.ts`, `app/src/app/robots.ts`) and the four entity pages' canonical
`<link>` tags (`app/src/app/route/[pair]/page.tsx` and its `/airport`, `/carrier`, `/aircraft`
siblings). All three are optional — production sets none and gets the defaults below, which
are what the Portability test and the WORKDIR contract assume.

| Var | Default | What it's for | What breaks if it's wrong |
|---|---|---|---|
| `UPGAUGE_ROOT` | `process.cwd()` | The directory containing `data/` and `sql/` — anchors both `upgauge.duckdb`'s default location and every `.sql` file read (`sql/03_queries/*.sql`). Also passed to DuckDB as `file_search_path`, so the catalog's relative Parquet globs (`read_parquet('data/parquet/...')`) resolve against it regardless of the process's actual OS working directory. | Set to the wrong directory: every `.sql` file read fails with ENOENT, and every query against a Parquet-backed view fails with `IO Error: No files found that match the pattern "data/parquet/..."` — the exact failure the Portability test section above describes, just triggered by a bad env var instead of a bad `WORKDIR`. |
| `UPGAUGE_DB` | `${UPGAUGE_ROOT}/upgauge.duckdb` | Overrides the `.duckdb` file path directly, independent of `UPGAUGE_ROOT` — for a deploy that keeps the database file somewhere other than the repo-root default (e.g. a mounted volume). | Set to a path that doesn't exist or isn't a valid DuckDB file: `DuckDBInstance.create()` rejects and every route handler 500s. Note this does NOT relocate `data/parquet/` — that's still resolved via `UPGAUGE_ROOT`'s `file_search_path`, so pointing `UPGAUGE_DB` at a database file whose Parquet tree lives elsewhere still needs `UPGAUGE_ROOT` set to match. |
| `UPGAUGE_BASE_URL` | `http://localhost:3000` | The scheme+host every fully-qualified URL this app emits is prefixed with: every `<loc>` in `/sitemap.xml`, the `Sitemap:` line in `/robots.txt`, **and** (M5 Task 2) every entity page's self-referential `<link rel="canonical">`. The sitemap protocol requires a fully-qualified URL, `sitemapEntries()` (`app/src/lib/sitemap.ts`) and the entity resolvers alike only ever return a site-relative path or a bare code, on purpose (CLAUDE.md's portability rule: no hardcoded hostname, Docker + env vars only) — a hardcoded `https://upgauge.shipman.dev` was Task 2's fix-round-1 Critical finding. | Left at the default in a real deploy: the sitemap validates and crawls fine locally, and every entity page still renders, but every submitted `<loc>` and every canonical `<link>` points at `localhost`, so a crawler resolves none of them and every canonical tag is wrong for wherever this is actually served. |

Neither of the first two is a substitute for the WORKDIR contract — they exist so the default
(WORKDIR == repo root, both vars unset) needs no configuration, while still giving an operator
an escape hatch if a deploy's directory layout genuinely can't match it. `UPGAUGE_BASE_URL` is
unrelated to that contract; it exists only because a fully-qualified URL cannot be built from a
relative path alone.
