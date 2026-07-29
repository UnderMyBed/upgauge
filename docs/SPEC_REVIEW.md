# Spec Review — pre-first-commit validation

Verification pass over `PRODUCT.md` and `DESIGN_BRIEF.md`, done against live sources
(2026-07-29). Goal: find everything that would force a spec rewrite mid-build.

**Verdict: the architecture and the data-modeling judgment are sound and should survive
contact. But the acquisition path in §5 is dead, and there are four correctness issues that
would ship wrong numbers.** Fix those and the specs are buildable end-to-end.

Findings are ordered by when they'd bite you.

---

## Blockers — these stop M1

### B1. The PREZIP path for T-100 no longer exists

`PRODUCT.md` §5 says *"Prefer the pre-zipped annual files at `transtats.bts.gov/PREZIP/`.
Enumerate that directory at build time."*

The directory is live and browsable, but **every T-100 file in it is dated 2015-09-02**:

```
896820853_T_T100_SEGMENT_US_CARRIER_ONLY.zip    9/2/2015 12:14 PM
896834156_T_T100_SEGMENT_US_CARRIER_ONLY.zip    9/2/2015 12:38 PM
896836191_T_T100_SEGMENT_US_CARRIER_ONLY.zip    9/2/2015 12:46 PM
896843307_T_T100_SEGMENT_US_CARRIER_ONLY.zip    9/2/2015 1:00 PM
896816367_T_T100D_SEGMENT_ALL_CARRIER.zip       9/2/2015 12:04 PM
```

For contrast, On-Time Performance files in the same directory run current — the most recent
is `..._1987_present_2026_5.zip` dated 2026-06-30. So PREZIP itself is maintained; the T-100
entries are abandoned one-off job outputs, not a refreshed annual feed.

**Consequence:** §5's primary and fallback are backwards. The `DL_SelectFields.aspx` POST is
the *only* path, not the fallback. The advice to "enumerate the directory, don't hardcode
filenames" is still right in spirit but applies to nothing.

**Fix:** rewrite §5 acquisition around the POST form — which means the pipeline needs
per-(year, month) request loops, response caching, and politeness/retry behavior that the
current spec doesn't budget for. This is real work that M1 currently doesn't account for.

### B2. `carrier_group` collides with an actual T-100 column

T-100 Domestic Segment already ships fields named **`CARRIER_GROUP`** and
**`CARRIER_GROUP_NEW`**. They are BTS's revenue-based reporting classification (it drives
filing requirements; code 8 = domestic-only all-cargo). That is unrelated to §2's
mainline-rollup concept, which also wants the name `carrier_group`.

Two different meanings for one name, in the same table, in a product whose entire §2 is
about not misattributing carriers. This will cause a bug.

Note the spec is already inconsistent with itself here: §6 names the dimension column
`mainline_group`, §2 and §8.1 call the dimension `carrier_group`.

**Fix:** standardize on `mainline_group` everywhere, and either drop BTS's `CARRIER_GROUP`
at staging or preserve it under `bts_carrier_group` so the collision is impossible.

---

## Correctness — these ship wrong numbers

### C1. Key on DOT IDs, not letter codes

§7 keys carriers on the 2-letter code and says of airports only *"codes change over time,
join `dim_airport` on its effective-date range."* The underlying mechanism is more specific
and the file already gives you the right tools:

| Field | What it is |
|---|---|
| `AIRLINE_ID` | DOT-assigned. Stable across code, name, and holding-company changes. |
| `UNIQUE_CARRIER` | IATA-style code. **Reused across different airlines over time.** |
| `ORIGIN_AIRPORT_ID` | Stable airport identity. |
| `ORIGIN_AIRPORT_SEQ_ID` | Changes when an airport's attributes change — the point-in-time key. |

For a 2015→present window this is not academic: code reuse is exactly why `AIRLINE_ID`
exists, and this product's core claim is longitudinal carrier comparison.

**Fix:** `AIRLINE_ID` is the join key and the fact-table grain; the letter code is a display
attribute resolved through `dim_carrier`. Airports: `AIRPORT_ID` for identity,
`AIRPORT_SEQ_ID` for point-in-time attributes. Rewrite the §7 bullet to say this.

### C2. `CLASS = 'F'` is not the freighter filter, and `seats = 0` is not either

§7 uses `CLASS = 'F'` for scheduled passenger service and separately quarantines `seats = 0`
as the freighter mechanism.

`F` is *Scheduled Passenger/Cargo Service* — a composite class. Dedicated all-cargo
scheduled service files under `G`, so `F` excludes most freighters, but sources conflict on
whether `F` can carry freighter-configured aircraft. **I could not resolve this from
documentation and you should not resolve it from documentation either** — the spec's own
instruction ("verify against the BTS lookup table — do not assume") is correct.

What *does* resolve it: T-100 ships an **`AIRCRAFT_CONFIG`** field, which the spec never
mentions. That is the precise passenger-configuration filter.

**Fix:** filter on `CLASS` + `AIRCRAFT_CONFIG`, verified empirically at ingest with a test
that asserts the class/config distribution. Then demote `seats = 0` from "freighter
detector" to what it should be — a genuine data-error trap. As written, the spec will
misclassify config-based cargo ops as bad rows and quarantine real data.

### C3. Hawaiian breaks the premise that "wholly-owned" is safe to map statically

§2's whole argument is that wholly-owned regionals can take a *static* rollup because
"single-mainline exclusivity is guaranteed by ownership **for the entire window**", whereas
serially-exclusive carriers need date-ranging and are therefore too fragile for v0.

Hawaiian falsifies that for the stated 2015→present window:

- **Sept 2024** — Alaska Air Group completes acquisition of Hawaiian Holdings.
- **Oct 2025** — FAA grants a single operating certificate; both fly under the AS certificate.
- **~April 2026** — single PSS cutover; `HA` flight numbers retire.

So Hawaiian is independent for ~9 years of the window and an AAG wholly-owned subsidiary for
the last ~2. A static `HA→AS` map is wrong before 2024; omitting Hawaiian is wrong after it.
The spec does neither — **Hawaiian is not mentioned anywhere.**

This is the date-ranged-mapping problem appearing *inside* the set §2 declared safe from it.
Virgin America has the identical shape (AS-owned Dec 2016, merged 2018) and §5 flags the
merger but §2's rollup table doesn't handle it.

**Fix:** one of two honest options, and the choice changes the data model.
1. Date-range the wholly-owned map — `(carrier × period → parent)` — accepting that §2's
   "static map" simplification is gone. This is the correct answer and is *much* smaller in
   scope than the §2-backlog version, because it's 2 entries, not the whole contract-regional
   universe.
2. Keep it static, explicitly scope Hawaiian and Virgin America out, and say so in the
   methodology surface.

Either way §2 needs rewriting. Option 1 is the recommendation — the mechanism you'd build is
the same one the v1 backlog needs anyway.

### C4. Amended filings — retention is specified, resolution isn't

§7 correctly says BTS silently overwrites amended filings, stamp each ingest with a download
date, retain prior Parquet partitions. It never says **which row wins** when the same
`(year_month, key)` appears in two partitions. Without a stated rule the marts are
non-deterministic across rebuilds, which quietly breaks the §11/M2 "fully reproducible from
scratch" requirement.

**Fix:** one line — latest `download_date` wins per key; prior partitions are audit-only.

---

## Hosting — the model is right, the box is wrong

Two criteria decide this, and they are not price. **DuckDB aggregation wants RAM**
(1–2GB per thread), and **cold starts land on shared links** — the growth mechanic is
someone clicking a pasted URL, so a sleeping box is a product problem, not just latency.

Surveyed July 2026:

| Option | Cost | Resources | Assessment |
|---|---|---|---|
| **Hetzner CX22 / CX23** | **~€3.79–4.59/mo** (see note) | 2 vCPU / 4GB / 40GB NVMe / 20TB | **Recommended.** Best RAM-per-euro from a reputable host. Always-on, no cold start. |
| **Google Cloud Run** | **$0** at this traffic | container, scale-to-zero | **Strongest $0 option.** Free tier: 2M req + 180k vCPU-s + 360k GiB-s/mo. Container-based, so it *passes* the §4 portability test. Cold start is the risk — a baked-in DuckDB file makes a fat image. Free tier is per-*account*, not per-project, and `us-central1/east1/west1` only. |
| **Self-host + Cloudflare Tunnel** | **$0** | whatever you own | Viable and underrated: `cloudflared` is free/unlimited, needs no open ports or static IP, and **§4 already requires the domain to be on Cloudflare**, so it composes with the existing plan. Trades cash for home uptime/power/ISP risk. |
| Contabo VPS 10 | ~€4.50/mo | 8GB | Most RAM per euro found. Weaker reliability reputation than Hetzner — the tradeoff is real. |
| Oracle Cloud Always Free | $0 | ARM Ampere A1 | Free-tier A1 cut to 2 OCPU / 12GB in June 2026; reclamation risk. Fine as a $0 mirror, not the only copy. |
| Netcup | ~€3.35/mo (2GB) | 2 vCPU / 2GB / 64GB | Cheapest entry, but 2GB is the tier that's already too small. |
| **Fly.io 1GB** (spec's pick) | **$5.70/mo** | 1 vCPU / 1GB | Spec says ~$5. No free tier for new orgs. **Dominated on every axis below.** |
| Fly.io 2GB | $10.70/mo | 1 vCPU / 2GB | Sizing up to a still-marginal 2GB makes Fly the most expensive option surveyed. |
| Render Starter | $7/mo | shared CPU | Always-on. Free tier sleeps after 15 min idle — disqualifying for shared links. |
| Railway Hobby | $5/mo + usage | usage-billed | No permanent free tier as of 2026. No advantage over Hetzner. |
| Linode / Vultr | ~$5/mo (1GB) | 1GB entry | ~$12 at 2GB, ~$24 at 4GB. Far worse RAM-per-dollar than Hetzner. |
| AWS Lightsail | ~$10/mo entry | — | No advantage at any tier. |
| Koyeb | $0 (2 nano services) | nano | Too small for DuckDB. |
| Cloudflare Containers | $5/mo (needs Workers Paid) | usage-billed | Not cheaper, and provider-specific — fails §4's own portability test. |
| Cloudflare Pages, fully static | $0 | — | Blocked by a file-count cap — see below. |

> ⚠️ **Hetzner's exact price is unconfirmed.** Secondary sources report €3.79, €4.15,
> €4.49, and $4.59 for nominally the same 2 vCPU / 4GB box, and Hetzner's own pricing page
> renders its figures client-side so they weren't fetchable. There was also an April 2026
> price change. Confirm in the Hetzner console before committing the number to `PRODUCT.md`.
> The ranking doesn't change across that range; the exact figure does.

**The sizing issue matters more than the $0.70.** DuckDB aggregation workloads want roughly
1–2GB *per thread*. At 1GB the Explorer's group-bys will spill to disk. Spilling on a
scale-to-zero machine, behind a cold start, on a link someone just clicked from a forum, is
the exact experience the product is optimizing for. §4 picked the machine on price without
sizing it against the query engine.

**On going fully static (the $0 option the spec half-anticipates).** Worth taking seriously —
the dataset is read-only and changes monthly, so in principle no server is needed. Two things
kill it as a *whole-product* answer:

- **Cloudflare Pages caps at 20,000 files per site** on free (100,000 on paid). Entity pages
  at `(carrier × origin × dest)` grain will plausibly exceed that. Count it at M1 before
  betting on it.
- **DuckDB-WASM is a ~33MB binary** with known feature-parity gaps against native (Parquet
  compression support has bitten people in production). Loading that before a user sees a
  number contradicts the share-and-screenshot mechanic.

But the *hybrid* is genuinely attractive and cheap: prerender the finite entity sets
(airports ~1k, carriers ~100, aircraft types ~200) as static, keep the server for route pages
and the Explorer, and lazy-load DuckDB-WASM only on `/explorer` if you ever want to shed the
server entirely. That's an optimization, not a v0 requirement — noting it so the decision is
deliberate.

**Recommendation: keep §4 exactly as written and swap Fly → Hetzner.** No cold start, 4GB
for DuckDB, R2 free tier (10GB storage, zero egress) covers artifacts, Cloudflare free CDN
unchanged. Everything else in §4 — no managed Postgres, no Redis, no tiled basemaps, monthly
cache headers, precomputed leaderboards — is well-reasoned and verified sound.

**If $0 matters more than hands-off operation**, the honest ranking is Cloud Run, then
self-host + Tunnel. Both are legitimately free at this traffic and neither compromises
portability. Cloud Run's cold start is the thing to test — measure it with the real image
before committing, since a baked-in DuckDB file is exactly the payload that makes container
starts slow, and it lands on the first click of every shared link.

Worth saying: this swap is a one-line spec change *because* §4 wrote the portability test.
That constraint earned its keep.

---

## Gaps — won't break the build, will need spec text later

- **`ORIGIN_CITY_MARKET_ID` is in the file and unused.** Free city-market rollup (all NYC
  airports as one). A natural dimension for this audience. Decide in or out now, not at M4.
- **Route Birth Tracker's "first-ever appearance" is false** — it's first-since-2015. The
  spec's own honesty standard (§3, §6) requires relabeling.
- **Silent staleness.** If the monthly cron fails, `DATA AS OF` just stops advancing and
  nobody is told. For a product whose credibility *is* that badge, needs a freshness check
  and an alert. Not in §11 or §4.
- **No SEO/indexation policy** despite §8.2 pitching entity pages for SEO. No sitemap
  generation, no canonical rules, no decision on which route pages exist — which is the same
  question as the file-count cap above.
- **No social-card/OG spec** in `DESIGN_BRIEF.md`. The stated growth mechanic is link
  sharing; a pasted link that unfurls as nothing is a missed multiplier. Screenshot-friendly
  ≠ unfurl-friendly, and the brief only covers the former.
- **No empty / loading / error / no-data states** in the design content inventory. A tool
  with quarantine rules and sparse routes will hit all of them.
- **Republic/Mesa merged 2025** (completed Nov 2025). No rollup impact — both are shared
  regionals and correctly excluded — but it's a carrier-continuity discontinuity in
  multi-year charts, alongside Virgin America.
- **`PAYLOAD` field** exists and isn't in the §6 model. Minor; probably correctly ignored.
- **No licensing/attribution line.** Public-domain US Government data; a public tool should
  say so on the methodology surface.

---

## What held up

Worth recording, since the point of this pass is knowing what *not* to revisit:

- The no-database-server insight, the caching-is-the-cost-control argument, and the R2 free
  tier all check out.
- The operating-carrier-is-the-grain analysis is correct and well-argued, including the
  no-marketing-carrier-field constraint and the shared-regional exclusion.
- The "never store `load_factor`" rule is the right structural enforcement.
- The portability test is what makes the hosting fix trivial.
- `CLASS`, the trailing-comma quirk, and the DL_SelectFields response filename pattern all
  match the real files.
