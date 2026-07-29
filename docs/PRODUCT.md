# Upgauge — Product & Engineering Spec (v0 "skateboard")

> Handoff doc for a Claude Code session. Read this whole file before writing code.
> Section 7 (Data Invariants) is the part that will bite you. Start there.
> Visual design is handed off separately — see `DESIGN_BRIEF.md`. This doc carries
> only the hard product constraints on the UI, not the aesthetic.

---

## 0. Decisions locked (read first)

| # | Decision | Resolution |
|---|---|---|
| Name | Product name | **Upgauge.** Trademark checked — clear in our class (§2). Hosted at **`upgauge.shipman.dev`** (subdomain of an owned domain); no domain purchase for v0. |
| Carrier | Rollup model | **Operating carrier is the grain + truth. Optional _date-ranged_ rollup to parent for wholly-owned subsidiaries only.** (§2, §7) |
| History | Start year | **2015 → present.** COVID is in-window on purpose. (§5) |
| Audience | Public or private | **Public from day one.** (§4) |
| Design | Aesthetic | Handled in a separate design session. This doc sets constraints only. (§3, `DESIGN_BRIEF.md`) |

---

## 1. What this is

A structural intelligence layer over US DOT / BTS airline data. Upgauge answers:

> **"Is this route healthy, and what is the airline about to do to it?"**

It is **not** a flight search tool, a fare tracker, or a real-time product. BTS data is
2–6 months lagged by nature. Design *around* that constraint rather than fighting it —
make the `DATA AS OF` stamp a first-class UI element, not a buried disclaimer.

Two halves, and they need each other:

- **The Explorer** — a real query/pivot surface over T-100. This is the foundation.
- **The Insights** — Gauge Watch, Route Death Watch, Empty Planes. These are *saved
  presets over the Explorer*, not separate systems.

Every insight row must be one click from "show me the raw rows that produced this."
Insights that can't be drilled into feel like astrology.

---

## 2. Name & the carrier decision

### Name: Upgauge

Chosen because the aircraft-gauge story is the product's real differentiator (§8.2), not
load factor. Distinctive, ownable, unmistakably aviation-capacity vocabulary.

> ✅ **Trademark: checked, clear in our class.** The only registered `UPGAUGE™` (USPTO
> 90566561) covers home hardware — faucets, lamps, hair dryers — a different class with no
> overlap with a data tool. Nothing in software/data/aviation-information services uses the
> name. Not a formal legal clearance, but no blocking conflict.
> Note: "upgauge" is a generic aviation-trade term, so the bare word is SEO-noisy — a mild
> headwind, not a naming problem.
>
> **Hosting: `upgauge.shipman.dev`** — a subdomain of a domain we already own. No domain
> purchase for v0 (keeps early cost at ~$0 infra). If the tool takes off, migrating to an
> apex domain later is trivial and *that's* the point to revisit a formal trademark filing.

### Carrier rollup: operating carrier only

**The fact that drives this:** T-100 Segment is filed by the carrier that *operated the
metal*. A Delta-branded regional flight flown by Endeavor files under **9E**, not **DL**.
Mainlines do not file metal they didn't operate. Therefore:

- Summing all carriers on a route **does not double-count** in T-100 Segment. Each
  physical flight is reported once, by its operator.
- There is **no reliable marketing-carrier field** in T-100 Segment. You cannot tell,
  from T-100 alone, that a given SkyWest segment was sold as United Express vs. Delta
  Connection — because SkyWest flies for several mainlines simultaneously.

**Decision — operating carrier is the grain and the source of truth. A `mainline_group`
dimension provides an OPTIONAL rollup, but ONLY for wholly-owned subsidiaries**, where
single-parent exclusivity is guaranteed by ownership.

> ⚠️ **The mapping is DATE-RANGED, not static.** An earlier draft assumed ownership held
> for the entire window and a flat `carrier → parent` map would do. It does not: Alaska
> acquired Virgin America in 2016 and Hawaiian in 2024, both *inside* the window. A static
> map is wrong before the acquisition; omitting them is wrong after it. The map is keyed
> `(airline_id, effective_from, effective_to) → parent`, and the ingest joins on it by
> month.

| Parent | Wholly-owned subsidiary | From | To | Note |
|---|---|---|---|---|
| Delta | Endeavor (9E) | window start | present | Delta-owned since 2013, pre-window |
| American | Envoy (MQ) | window start | present | AAG-owned throughout |
| American | PSA (OH) | window start | present | AAG-owned throughout |
| American | Piedmont (PT) | window start | present | AAG-owned throughout |
| Alaska | Horizon (QX) | window start | present | Air Group-owned throughout |
| **Alaska** | **Virgin America (VX)** | **2016-12** | **carrier ceases filing** | Acquisition closed Dec 2016; SOC Jan 2018; brand retired Apr 2018 |
| **Alaska** | **Hawaiian (HA)** | **2024-09** | **present** | AAG acquired Hawaiian Holdings Sept 2024; SOC Oct 2025; `HA` flight numbers retire ~Apr 2026 |
| **United** | **— none —** | | | United owns no subsidiary operators; gets no rollup |

**Note the concept widened:** this is no longer "wholly-owned *regionals*." Virgin America
and Hawaiian are mainline carriers that became wholly-owned subsidiaries. The test is
ownership, not aircraft size.

**Rules for the map:**
- Key on `airline_id` (DOT ID), never the letter code — see §7. `VX` and `HA` are exactly
  the kind of codes that get reused.
- Boundaries are **inclusive at month granularity**: a carrier's rows roll up to the parent
  for `year_month >= effective_from` and `<= effective_to`. Ownership changes mid-month are
  attributed to the whole month; this is a stated approximation, not an accident.
- Verify all dates against filings at ingest. Do not trust the table above as gospel — it is
  a starting point, and it is the single most reviewable thing in the pipeline.
- **Assert the map is total:** every `(airline_id, year_month)` either maps to exactly one
  parent or to itself. Overlapping ranges are a test failure, not a runtime tiebreak.

**Everyone else stays as operating carrier**, for two distinct reasons:
- **Shared regionals** (SkyWest OO, Republic YX, Mesa YV, GoJet…) fly for several
  mainlines at once → not attributable at all, at any date.
- **Serially-exclusive contract regionals** (Air Wisconsin ZW, ExpressJet EV…) flew for
  one mainline *at a time* but *changed masters* mid-window. These are now *mechanically*
  expressible — the date-ranged map above is the same shape they need — but they are still
  out of v0 because sourcing the contract dates correctly is the hard part, not the schema.
  See the backlog note below.

**Critical: the rollup is a grouping layered on the operating-carrier grain, NOT a
replacement.** Aircraft type stays at the grain, so "Delta group downgauged PDX–SLC —
mainline 737 seats down, Endeavor CRJ seats up" is *still fully visible*. We gain an
optional lens without losing the core insight.

**Three honesty caveats that dictate labeling — enforce them in the UI:**
1. **A group is not "all branded flying."** `Delta group` = DL + 9E. It does **not**
   include SkyWest/Republic flights also sold as Delta Connection (unattributable). Label
   it precisely: *"Delta (mainline + wholly-owned subsidiaries)"* — never imply it's every
   flight painted as Delta. Misattribution-by-omission is still misattribution.
2. **United looks artificially small in group view** because it owns no subsidiary
   operators while the others do. A naive group-vs-group comparison is apples-to-oranges.
   Annotate it, and always keep operating-carrier truth one toggle away.
3. **Group composition changes over time, and a time series must show that.** `Alaska
   group` means AS+QX in 2015, AS+QX+VX in 2017, and AS+QX+HA from late 2024. Alaska's
   group capacity will step up at each acquisition, and **that step is an ownership event,
   not organic growth.** Annotate the boundary on any grouped time series that crosses it.
   An unannotated step change here is the single most misleading chart this product can
   draw.

Default view is **operating carrier**; `mainline_group` is an opt-in toggle (§8.1).

> 📌 **Backlog (v1+), do not forget:** *Full mainline attribution.* The `mainline_group`
> rollup above covers only wholly-owned metal. To attribute the rest:
> 1. **Serially-exclusive contract carriers** (Air Wisconsin, ExpressJet, CommutAir…) need
>    a date-ranged `(airline_id × period → parent)` mapping. **v0 now ships exactly this
>    mechanism** for the wholly-owned set, so this is no longer a schema change — it is
>    purely a data-sourcing job. Add rows, source the contract dates carefully, ship.
>    That is a meaningfully smaller v1 than originally scoped.
> 2. **Shared regionals** (SkyWest-type) need an external join — operator + flight number +
>    date → marketing carrier, via a schedule feed (OAG/Cirium) or the DOT O&D survey. The
>    only honest way to attribute them. Real work; genuine v1+ scope. **No date-ranged map
>    can fix these** — they fly for several mainlines on the same day.

---

## 3. Design constraints (aesthetic handled in `DESIGN_BRIEF.md`)

Visual direction is a separate design session. **Do not invent an aesthetic here.** These
are the non-negotiable *product* constraints that hold regardless of the look chosen:

- **All numerics in a monospaced, tabular-figure face**, right-aligned, fixed decimals.
  A data product with proportional numerals is not serious.
- **`DATA AS OF: YYYY-MM` is a first-class UI element** on every data view, in the accent
  color. The lag is the product's defining honesty; surface it, don't hide it.
- **Density over whitespace.** This is a chart, not a landing page. Sparklines in table
  rows. Hairline rules. No card-soup.
- **Screenshot- and link-shareable.** Every view must look good pasted into a forum or
  Discord (see §8.1 — sharing is the growth mechanic). This biases toward a lighter,
  print-legible surface over a dark dashboard, but the design session decides.
- **Quality floor:** responsive to mobile, visible keyboard focus, reduced-motion honored.
- **Honest labels:** derived measures are labeled as computed (see §6). Never imply a
  precision the lagged, sampled data doesn't have.

Everything else — palette, type personality, the signature element, the map rendering
style — is the design session's job. See `DESIGN_BRIEF.md`.

---

## 4. Architecture & hosting

### The fact that makes this nearly free

**This is a read-only dataset that changes once a month. There are no writes, ever.**
So you never need a database *server*. That single realization is worth ~$25/mo.

### Shape

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

**Single Next.js deployable.** No separate API service — one container, one box, one
deploy. Python exists only in the ingest pipeline, which runs in CI, never in prod.

**Query logic lives in `.sql` files, never in Python or TS string literals.** This lets
the Python pipeline and the TS server share definitions, and keeps a future DuckDB-WASM
port possible.

### Cost

| Item | Cost |
|---|---|
| Ingest — GitHub Actions monthly cron | $0 |
| Artifacts — Cloudflare R2 (10GB + zero egress on free tier) | $0 |
| App — **Hetzner CX22-class, 2 vCPU / 4GB, always-on** | ~€4/mo |
| CDN + DNS — Cloudflare free tier | $0 |
| Domain — subdomain of owned `shipman.dev` | $0 |
| **Total** | **~€4/mo** |

> **Why not Fly (the original pick)?** Two reasons, and the second is the real one.
> Fly's shared-cpu-1x 1GB is $5.70/mo — *more* than Hetzner — and its free tier is gone for
> new orgs. But the disqualifier is sizing: **DuckDB aggregation wants 1–2GB per thread**,
> so 1GB spills to disk on exactly the Explorer group-bys this product exists to serve.
> Fly's 2GB tier is $10.70 and still marginal. Hetzner gives 4GB for less than Fly's 1GB.
>
> **Cold start is a product constraint here, not a latency nit.** The growth mechanic (§8.1)
> is someone clicking a link pasted into a forum. A scale-to-zero box cold-starting a fat
> DuckDB image on that first click is the worst possible first impression. Prefer always-on.
>
> **If $0 matters more than hands-off ops**, two paths are genuinely free and neither breaks
> the portability test below:
> - **Google Cloud Run** — free tier is 2M req + 180k vCPU-s + 360k GiB-s/mo, which this
>   traffic profile won't approach. Container-based, so portable. Measure cold start with
>   the real image before committing; per-*account* (not per-project) quota; `us-central1`/
>   `us-east1`/`us-west1` only.
> - **Self-host + Cloudflare Tunnel** — `cloudflared` is free and unlimited, needs no open
>   ports or static IP, and the domain is already required to be on Cloudflare (below), so
>   it composes. Trades cash for home uptime/power/ISP risk.
>
> Confirm Hetzner's exact current price in their console before relying on it — published
> third-party figures for the same box ranged €3.79–€4.59 as of 2026-07, and there was an
> April 2026 price change.

### Public from day one — what that commits us to

The architecture already assumes public-scale read traffic, so this is cheap:

- **Host at `upgauge.shipman.dev`** — a subdomain of an already-owned domain, so no
  purchase for v0. To keep the caching cost model below, the subdomain must sit **behind
  Cloudflare (proxied / "orange cloud")**: point `upgauge.shipman.dev` at the app host
  (CNAME + provisioned cert) with Cloudflare in front. If `shipman.dev`'s nameservers
  aren't already on Cloudflare, either move them or use a partial (CNAME) setup — the free
  CDN in front is what makes the numbers work, so don't skip it. Keep the `DATA AS OF` /
  methodology transparency that makes a public data tool trustworthy.
- **Basic rate limiting** at the Cloudflare edge (free tier) on the API routes — enough
  to stop a scraper from waking the box constantly. No app-level auth.
- **Nothing private ever goes in it.** All data is public DOT filings; keep it that way.

### The actual cost control is caching, not the tier

Data changes monthly. Every response gets:

```
Cache-Control: public, s-maxage=2592000, stale-while-revalidate=86400
```

With Cloudflare's free tier in front, near-zero repeat traffic touches the box.
**Precompute all leaderboards as static JSON at build time.** A $5 machine serves real
traffic without breathing hard.

### Avoid

- Managed Postgres (~$20+/mo, pointless — no writes)
- Mapbox tiles (usage-priced; see §8.3 for the free alternative)
- Always-on Redis
- Vercel, if traffic spikes (bandwidth pricing bites)

### Portability test

`docker run` it locally against the same `.duckdb` file and it must behave identically.
Everything is Docker + Parquet + env vars. R2 is S3-compatible. **Do not build on
provider-specific runtimes** (Workers, D1, KV). This must stay a normal app.

---

## 5. Data scope

**v0 uses exactly one dataset:** T-100 Domestic Segment (US carriers), **2015 → present.**

Start at 2015: ~10 years of history, and the only in-window merger to reconcile is
Alaska/Virgin America (2016–18). **COVID (2020–21) is deliberately inside the window** —
it's the most dramatic route-death-and-rebirth event in the data and a natural showcase
for Death Watch, Birth Tracker, and the time-machine diff.

Plus lookups: Master Coordinate (airport lat/lon), Carrier Decode, Aircraft Type Decode.

### Acquisition

> ⚠️ **PREZIP is a dead end for T-100 — verified 2026-07.** An earlier draft made
> `https://transtats.bts.gov/PREZIP/` the primary source. The directory is live and
> browsable, but **every T-100 file in it is dated 2015-09-02** — abandoned one-off job
> outputs, never refreshed. (On-Time Performance files in the same directory *are* current
> to 2026, which is what makes the directory look maintained.) There is no pre-zipped
> annual T-100 feed. Do not spend a day rediscovering this.

- **Primary (and only) path: POST to `DL_SelectFields.aspx`**, which returns
  `{jobid}_T_T100D_SEGMENT_US_CARRIER_ONLY.zip`. This is a form-driven job endpoint, not a
  static file server, which means the fetcher must:
  - loop per (year, month) rather than pulling annual files;
  - request **all fields** — the ID columns in §7 are not in the default selection;
  - cache aggressively on disk so a re-run doesn't re-hit BTS;
  - back off and retry politely, and fail loudly rather than silently producing a short file.
- **Budget for this in M1.** It is materially more work than downloading annual zips, and
  the original milestone did not account for it.
- Re-check PREZIP once at ingest time anyway and log what's found. If BTS ever restores a
  current T-100 feed there, it becomes the cheaper path — but never assume it.
- Known quirk: T-100 CSVs ship a **trailing comma** → phantom empty column (`EMPTYFIELD`).
  Handle it.
- Land raw zips in `data/raw/`. **Never mutate them** — they are the audit trail.

### The wider universe (context; all out of scope for v0)

| Dataset | Grain | Lag | Unlocks |
|---|---|---|---|
| **T-100 Domestic Segment (28DS)** | carrier × O × D × aircraft type × month | ~2–4 mo | **v0. Everything below.** |
| T-100 Domestic Market (28DM) | on-flight O&D | ~2–4 mo | Connecting vs. local traffic |
| T-100 International | + foreign carriers | ~6 mo | Transborder / long-haul |
| DB1B | 10% ticket sample, quarterly | ~6 mo | **Fares.** Monopoly premium, yield |
| On-Time Performance | flight + tail number | ~2 mo | Delays, cancellations, rotations |
| Schedule B-43 | aircraft by tail | annual | Fleet age, retirement curves |
| Form 41 | carrier financials | quarterly | CASM/RASM → profitability proxy |

---

## 6. Data model

```
fct_segment_month     grain: (year_month, op_airline_id, origin_airport_id,
                              dest_airport_id, aircraft_type)
                      departures_scheduled, departures_performed, seats, passengers,
                      freight, mail, distance, air_time, ramp_to_ramp_time,
                      aircraft_config, service_class,
                      origin_airport_seq_id, dest_airport_seq_id,   -- point-in-time attrs
                      download_date,                                -- amended-filing resolution
                      is_quarantined, quarantine_reason

fct_route_month       grain: (year_month, op_airline_id, origin_airport_id, dest_airport_id)

dim_airport           airport_id, airport_seq_id, code, name, city, state, lat, lon,
                      effective_from, effective_to
                      -- airport_id = identity; airport_seq_id = point-in-time attributes
dim_carrier           airline_id, code, name, is_regional, ownership_type,
                      bts_carrier_group   -- BTS's OWN revenue-based reporting class.
                                          -- NOT our rollup. Preserved under a distinct
                                          -- name so the collision is impossible.
dim_aircraft_type     code, name, manufacturer, family, seats_typical

map_mainline_group    airline_id, parent_airline_id, effective_from, effective_to
                      -- DATE-RANGED. Wholly-owned subsidiaries ONLY. See §2 for the
                      -- rows and the totality/overlap assertions.
                      -- Never populated for shared or contract regionals.

mart_route_health     one row per (op_airline_id, origin_airport_id, dest_airport_id)
mart_leaderboards     precomputed JSON, built at pipeline time
```

`op_airline_id` is the **operating carrier** throughout — the source of truth (§2) — and it
is the DOT `AIRLINE_ID`, not the letter code (§7).

> Note `dim_aircraft_type` no longer carries `is_freighter`. Freighter/passenger is a
> property of *the operation*, not the type — the same airframe flies both. `AIRCRAFT_CONFIG`
> on the fact row is the truth. See §7.

### Measures

**Additive (store these):** departures_scheduled, departures_performed, seats,
passengers, freight, mail, air_time, ramp_to_ramp_time

**Derived (compute at query time):** load_factor, asm, rpm, completion_factor,
avg_gauge (seats/departure), block_hours, avg_stage_length, frequency

> 🔴 **Derived measures are computed from summed numerators and denominators — never
> averaged.**
>
> ```sql
> -- WRONG. Silently produces plausible-looking garbage.
> AVG(load_factor)
> -- RIGHT. Always.
> SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)
> ```
>
> Enforce it structurally: **do not store a `load_factor` column on any fact table.**
> Can't average what doesn't exist. This is the #1 bug in every homemade T-100 tool.

---

## 7. Data invariants — write these as tests FIRST

- **Key on DOT IDs, never letter codes.** T-100 ships `AIRLINE_ID` (DOT-assigned, stable
  across code / name / holding-company changes) alongside `UNIQUE_CARRIER` (an IATA-style
  code that **gets reused by different airlines over time**). Same story for airports:
  `ORIGIN_AIRPORT_ID` is identity, `ORIGIN_AIRPORT_SEQ_ID` is the point-in-time key that
  changes when an airport's attributes change, and the 3-letter code is neither. **Join on
  IDs; display codes.** Over a 2015→present window with `VX`, `HA`, and reused regional
  codes in play, this is not academic — it is the difference between a correct time series
  and a silently merged one.
- **Service class + aircraft config.** Scheduled service is `CLASS = 'F'` (*Scheduled
  Passenger/Cargo* — a composite class; dedicated scheduled all-cargo files as `G`).
  **`CLASS` alone does not isolate passenger operations** — use `AIRCRAFT_CONFIG` for that.
  Sources conflict on whether `F` can carry freighter-configured aircraft, so **resolve it
  empirically**: write a test asserting the observed `CLASS × AIRCRAFT_CONFIG` distribution
  and verify against the BTS lookup table. Do not assume, and do not resolve it from a blog
  post.
- **Operating-carrier keying (§2).** Regionals file under their own IDs (Endeavor, SkyWest…).
  Key on the operating carrier — it is the grain and the truth. Summing operators on a route
  does *not* double-count; each physical flight is filed once.
- **`mainline_group` rollup is wholly-owned only, and DATE-RANGED.** `map_mainline_group`
  may cover ONLY the wholly-owned subsidiaries in the §2 table, each with its own
  `effective_from`/`effective_to`. **Never roll up shared regionals (SkyWest/Republic/Mesa)
  or serially-exclusive contract carriers (Air Wisconsin/ExpressJet)** — that fabricates
  attribution T-100 can't support. **Test that the map has no overlapping ranges per
  `airline_id`**, and that Hawaiian rolls up from 2024-09 but *not* from 2024-08. That
  single assertion is the one that catches the whole class of bug.
  The rollup is a display grouping; it must never collapse the operating-carrier +
  aircraft-type grain of the fact tables.
- **Do not blend Segment with Market data.** The classic "double count" people warn about
  comes from mixing T-100 Segment with T-100 Market (or DB1B), not from Segment itself.
  v0 uses Segment only — keep it that way.
- **`seats = 0`** → quarantine as a data error, do not divide. **This is not the freighter
  filter** — `AIRCRAFT_CONFIG` is. Treating `seats = 0` as "this is a freighter" will
  quarantine real passenger rows and silently pass cargo ops that report seats.
- **`load_factor > 1.0`** → quarantine as a filing error. **Do not silently clamp.**
- **Route identity.** Store both directional (`PDX→AUS`) and undirected (`AUS-PDX`) keys.
  Undirected key is the two airport IDs sorted, so it's stable regardless of filing order.
- **BTS accepts amended filings and silently overwrites.** Stamp every ingest with a
  `download_date` and retain prior Parquet partitions. **Resolution rule: latest
  `download_date` wins per `(year_month, grain key)`; prior partitions are audit-only and
  never feed a mart.** Without this the marts are non-deterministic across rebuilds, which
  breaks the M2 reproducibility guarantee.

Quarantined rows are **excluded from aggregates but surfaced in the UI** with a count and
reason. Showing the dirt is a trust feature.

---

## 8. Feature set

### 8.1 The Explorer — the base layer (build this first)

A pivot surface: pick dimensions, measures, filters, time range → table + chart.

**Dimensions:** month/quarter/year · operating carrier · **carrier grouping (operating vs.
mainline-group toggle, §2)** · origin · dest · route · origin/dest state · aircraft type ·
aircraft group · distance group

**Then the things that make it good:**

1. **URL-encoded query state.** Every view is a permalink. This is the entire growth
   mechanic for a nerd tool — people paste links into forums and Discords. Don't skip it.
2. **CSV / Parquet export of any result.** Nerds want the data, not just the picture.
3. **Compare mode.** Pin 2–5 entities (routes, carriers, airports, *aircraft types*) and
   overlay on one chart. Most-requested feature in every data explorer ever built.
4. **Rolling-12 toggle.** Month / quarter / rolling-12. Rolling-12 kills seasonality and
   makes trends legible. Skipping it gives you unreadable sawtooth charts.
5. **Seasonality heatmap.** Year × month grid per route. Cheap, satisfying, and the
   *honest* way to present an "empty plane" claim.
6. **Generic Top-N builder.** "Top N `<dimension>` by `<measure>` in `<period>`." The
   §8.4 presets are all saved instances of this. Build the generic thing once.
7. **The omnibox.** One field resolving `PDX` · `Portland` · `Alaska` · `AS` · `A220` ·
   `PDX-AUS`. Sounds trivial. It is the whole UX.
8. **Methodology page.** The class filter, operating-carrier keying, the lag, the
   quarantine rules. Trust feature; also free SEO content. (The design session may fold
   this into the UI rather than a standalone page — see `DESIGN_BRIEF.md`.)

### 8.2 Entity pages (canonical hubs, good for SEO)

| Route | Contents |
|---|---|
| `/route/PDX-AUS` | LF over time by carrier · seats & departures · **aircraft type mix over time (stacked area)** · competitor list |
| `/airport/PDX` | Route map (§8.3) · top routes by seats · capacity YoY · carrier share · routes added/dropped last 12mo |
| `/carrier/DL` | Network map · fleet mix over time · capacity trend · biggest gainers/losers. Offers the **operating vs. mainline-group toggle** (§2): default shows DL metal; grouped shows DL + Endeavor, labeled *"mainline + wholly-owned subsidiaries."* Note `/carrier/OO` (SkyWest) is operating metal across *all* the mainlines it flies for — label clearly so it's not mistaken for a mainline brand, and it is never rolled into any group. **`/carrier/AS` is the one to get right:** its group composition changes twice in-window (VX from 2016-12, HA from 2024-09), so the grouped series must annotate both boundaries as ownership events (§2 caveat 3). |
| `/aircraft/A220` | **Underserved. Possibly the real differentiator.** Where it flies, who flies it, stage length, is it growing? Pure T-100, nobody does it well. |

> **Build the aircraft-type-mix chart before the load-factor chart.** Everyone does load
> factor. The gauge story is what makes this yours.

### 8.3 Maps

Tied to entities, never global. A global all-routes map is a hairball.

| Map | Encoding | Why |
|---|---|---|
| **Airport network** `/airport/PDX` | Arcs from one node; weight = seats, style = LF | Add a **year slider** → watch the network grow/contract. The screenshot people post. |
| **Carrier network** `/carrier/OO` | Full network, **filterable by aircraft type** | "Every route SkyWest flies the E175 on" is one filter and a legible map. |
| **Aircraft type** `/aircraft/A220` | All routes flown by a type | Genuinely novel. |
| **Diff map** | new vs. dropped vs. downgauged | Death Watch + Birth Tracker rendered *spatially*. 10× more visceral. |

**Skip:** a map on the route detail page. A single arc is not information.

**Tech:** deck.gl `GreatCircleLayer` over MapLibre.

> 💰 **No tiled basemap.** Mapbox tiles are usage-priced. Render a **Natural Earth
> coastline/state GeoJSON** as a static layer beneath the arcs — zero tile cost. If you
> later want real tiles, use **PMTiles**: one file on object storage, no tile server.
> (Exact arc/basemap styling is the design session's call — see `DESIGN_BRIEF.md`.)

### 8.4 Insight presets (`/watch`)

Saved Explorer queries with editorial framing. Each row links back into the Explorer with
its filters pre-applied. Ship whichever three are ready first; **lead with Gauge Watch.**

- **Gauge Watch** — biggest upgauges/downgauges, trailing 12mo. *The differentiator.*
- **Empty Planes** — lowest seasonally-adjusted LF (min 30 departures/mo). *The hook.*
- **Route Birth Tracker** — first appearance of a carrier × O&D pair **since 2015**. Label
  it that way. It is *not* "first ever" — the window starts in 2015 and a route flown in
  2014 and resumed in 2019 will look new. Claiming "first ever" is precisely the false
  precision §3 and §6 forbid. *Cheap + fun.*
- **Route Death Watch** — risk score desc (§9). *Follows once the score model's in.*
- **Time-machine diff** — "PDX, Jul 2019 vs Jul 2025." Added/dropped/upgauged side by
  side, table + diff map. *Most shareable artifact in the product.*

---

## 9. Route Health score (v0 — deliberately dumb)

Per (op_airline_id, route), trailing 12 months vs. prior 12:

| Component | Signal |
|---|---|
| `lf_delta` | Δ load factor |
| `capacity_delta` | Δ total seats |
| `gauge_delta` | Δ mean seats-per-departure (negative = downgauge) |
| `frequency_delta` | Δ departures performed |
| `completion` | departures_performed / departures_scheduled |

Score = weighted z-score composite. Exclude routes with <30 departures in trailing 12mo.

**Show the components in the UI, not just the score.** The components are the insight; the
score is a sort key. Label it plainly as a heuristic. Do not over-engineer this.

---

## 10. Repo scaffold

```
upgauge/
├── PRODUCT.md                  ← this file
├── DESIGN_BRIEF.md             ← visual design handoff (separate session)
├── Makefile                    make ingest / make build / make dev
├── Dockerfile
├── pipeline/                   Python 3.12 + uv. Runs in CI only.
│   ├── fetch.py                DL_SelectFields POST loop + cache → data/raw/  (§5)
│   ├── normalize.py            raw → data/parquet/t100_segment/year=YYYY/
│   ├── build.py                runs sql/ in order → upgauge.duckdb
│   └── tests/                  §7 invariants. These gate the pipeline.
├── sql/
│   ├── 01_staging/             shared by pipeline AND server. Never inline SQL.
│   ├── 02_marts/
│   └── 03_queries/             the Explorer's parameterized queries
├── app/                        Next.js 15, App Router, TS, Tailwind, shadcn/ui
│   ├── api/                    route handlers → @duckdb/node-api → sql/03_queries/
│   └── (routes)/               explorer, route, airport, carrier, aircraft, watch
└── data/                       gitignored
```

**Charts:** Observable Plot (better than Recharts for dense multi-series time series).
**Maps:** deck.gl + MapLibre + Natural Earth GeoJSON.

---

## 11. Milestones

| | |
|---|---|
| **M1** | Ingest: `DL_SelectFields` POST loop → raw → Parquet, 2015→present. **§7 invariant tests passing.** Note §5 — this is a per-month form-scrape with caching and retries, not an annual-file download. Budget accordingly. |
| **M2** | Marts built by SQL, fully reproducible from scratch via `make`. |
| **M3** | Explorer: pivot query + URL state + table. The foundation — get it right. |
| **M4** | Entity pages: route, airport, carrier, aircraft. Charts. Design system (from `DESIGN_BRIEF.md`) applied. |
| **M5** | Maps (airport + carrier + aircraft), then `/watch` presets. |
| **M6** | Deploy + Cloudflare cache + edge rate limit + monthly cron + **freshness alert** (below). |

> 🔔 **The cron must fail loudly.** If the monthly ingest breaks, nothing errors — the site
> keeps serving happily and `DATA AS OF` just quietly stops advancing. For a product whose
> entire credibility is that badge (§3), silently serving stale data while claiming freshness
> is the worst failure mode available. Ship a check that alerts when `max(year_month)` hasn't
> moved in ~45 days, and surface staleness in the UI rather than only in a log.

---

## 12. Open decisions (resolve before the milestone that needs them)

Surfaced by the pre-commit spec review (`SPEC_REVIEW.md`). None block M1; each has a
milestone where deferring stops being free.

| # | Decision | Needed by | Notes |
|---|---|---|---|
| D1 | **City-market dimension in or out?** T-100 ships `ORIGIN_CITY_MARKET_ID` / `DEST_CITY_MARKET_ID` free. Enables "all NYC airports as one" — a natural cut for this audience. | M3 | Costs almost nothing at ingest; retrofitting it into the Explorer's dimension model later is the expensive path. Decide at M1, not M3. |
| D2 | **Which entity pages actually exist, and which get indexed?** §8.2 pitches entity pages for SEO but never bounds them. `(carrier × origin × dest)` is a large set. | M4 | Doubles as the answer to the static-hosting file-count question (`SPEC_REVIEW.md` §hosting). Needs a minimum-traffic threshold and a sitemap/canonical rule. |
| D3 | **Licensing / attribution line.** All source data is public-domain US Government filings. | M4 | One line on the methodology surface. Trivial, but a public data tool should say it. |

## 13. Out of scope for v0

DB1B / fares · On-time performance · International · Form 41 / profitability · **Full
mainline attribution for shared & serially-exclusive contract regionals — see §2 backlog**
(the wholly-owned rollup *is* in v0) · User accounts · Alerts · Email digests · Anything
predictive beyond the trailing-window heuristic.

These are v1+. **Do not let them leak into the skateboard.**
