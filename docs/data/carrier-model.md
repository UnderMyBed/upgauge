# The carrier model

The single most consequential modeling decision in the product. Getting it wrong produces
numbers that look plausible forever.

---

## Operating carrier is the grain and the truth

**The fact that drives this:** T-100 Segment is filed by the carrier that *operated the
metal*. A Delta-branded regional flight flown by Endeavor files under **9E**, not **DL**.
Mainlines do not file metal they didn't operate. Therefore:

- Summing all carriers on a route **does not double-count**. Each physical flight is
  reported once, by its operator.
- There is **no reliable marketing-carrier field**. You cannot tell, from T-100 alone, that
  a given SkyWest segment was sold as United Express vs. Delta Connection — because SkyWest
  flies for several mainlines simultaneously.

**Decision: operating carrier is the grain and the source of truth. A `mainline_group`
dimension provides an OPTIONAL rollup for wholly-owned subsidiaries and serially-exclusive
contract carriers, in the months each was exclusive** — single-parent exclusivity guaranteed
by ownership or shown by a sourced contract. Each map row is labelled `owned` or `contract`.

---

## ⚠️ The mapping is DATE-RANGED, not static

**A flat `carrier → parent` map does not work here**, however obvious it looks: ownership does
not hold for the whole window. Alaska acquired Virgin America in 2016 and Hawaiian in 2024, both
*inside* the window. A static map is wrong before each acquisition; omitting them is wrong
after it.

The map is keyed `(airline_id, effective_from, effective_to) → parent`, and the ingest
joins on it by month.

| Parent | Carrier | Basis | From | To (exclusive) | Note |
|---|---|---|---|---|---|
| Delta | Endeavor (9E) | owned | window start | present | Delta-owned since 2013, pre-window |
| American | Envoy (MQ) | owned | window start | present | AAG-owned throughout |
| American | PSA (OH) | owned | window start | present | AAG-owned throughout |
| American | Piedmont (PT) | owned | window start | present | AAG-owned throughout |
| Alaska | Horizon (QX) | owned | window start | present | Air Group-owned throughout |
| **Alaska** | **Virgin America (VX)** | owned | **2016-12** | **2018-04** | Acquisition closed Dec 2016; SOC Jan 2018; brand retired Apr 2018; last filing under VX is 2018-03 |
| **Alaska** | **Hawaiian (HA)** | owned | **2024-09** | **present** | AAG acquired Hawaiian Holdings Sept 2024; SOC Oct 2025; `HA` flight numbers retire ~Apr 2026 |

Contract rows, each with the passengers it moves (passenger configs, non-quarantined,
2015-01..2026-06) and the evidence for its boundary months. The `source` column of
`pipeline/reference/mainline_group.csv` carries each row's primary URL.

| Parent | Carrier | Basis | From | To (exclusive) | Pax | Evidence |
|---|---|---|---|---|---|---|
| United | CommutAir (C5) | contract | window start | present | 26.6M | United Express only (commuteair.com/about); United holds 40% since 2016. Hub share ~100% United every quarter |
| American | Air Wisconsin (ZW) | contract | window start | 2017-09 | 12.9M | Harbor Diversified 10-K FY2019: American flying ended before March 2018, United began 2017-09. Hub share ~90% American to 2017-Q3 |
| United | Air Wisconsin (ZW) | contract | 2018-03 | 2023-03 | 15.3M | Harbor 10-K FY2022; FY2024 note R9: second American contract from 2023-03, United withdrawn early 2023-06. Hub-share overlap visible 2017-Q4/2018-Q1 |
| American | Air Wisconsin (ZW) | contract | 2023-07 | 2025-04 | 3.7M | Harbor FY2024 R9; 8-K EX-99.1: American contract ended 2025-04-03. Off United hubs from 2023-Q2 |
| United | Mesa (YV) | contract | 2023-05 | 2025-12 | 13.3M | Mesa 10-K FY2023: American wound down by 2023-04-03. Republic–Mesa merger closed 2025-11-25. Hub share ~100% United from 2023-Q2 |
| United | GoJet (G7) | contract | 2021-01 | present | 13.0M | Delta 10-K FY2019: GoJet ends by end of 2020; absent from FY2020. United hub share jumps 2021-Q4 |
| United | ExpressJet (EV) | contract | 2019-02 | 2020-10 | 6.4M | Delta flying ended 2018-11 (Bend Bulletin 2018-12-19), American 2019-01; last United flight 2020-09-30 (AirlineGeeks 2020-08-24); SkyWest 10-K FY2018 |
| United | Trans States (AX) | contract | 2019-01 | 2020-05 | 3.6M | American flying lasted until December 2018 (Cranky Flier 2020-08-20); last United flight 2020-04-01. Medium source; American hub share 10% → 0% at 2019-Q1 corroborates |
| Hawaiian | Empire (EM) | contract | window start | 2021-02 | 1.1M | 'Ohana by Hawaiian 2014-03 → 2021-01-14 (Civil Beat 2014-03; Maui Now 2021-05-27; Star-Advertiser 2021-01-06) |

The nine contract rows move 95.9M passengers, 1.1% of the window's; 78.3M of it rolls up to
United, +8.2% on the 951.3M United carries itself.

**The concept is single-parent exclusivity, by ownership or by contract — not aircraft
size.** Virgin America and Hawaiian are mainline carriers that became wholly-owned
subsidiaries; Empire rolls up to Hawaiian years before Hawaiian rolls up to Alaska, and the
two ranges never share a month.

### Rules for the map

- Key on `airline_id` (DOT ID), never the letter code. `VX` and `HA` are exactly the kind of
  codes that get reused — see [invariants.md](invariants.md).
- Boundaries, as the Explorer's pivot actually joins them (`sql/03_queries/
  pivot_mainline_join.sql`): **inclusive at `effective_from`, EXCLUSIVE at
  `effective_to`** — `year_month >= effective_from AND (effective_to IS NULL OR year_month <
  effective_to)`. `effective_from`/`effective_to` are `VARCHAR 'YYYY-MM'`, so the comparison
  is lexical, not a parsed date. A carrier whose `effective_to` is `'2018-04'` has already
  stopped rolling up *by* 2018-04, not after it — read it as "the first month it's back to
  itself," not "the last month it still rolls up." Ownership changes mid-month are
  attributed to the whole month; a stated approximation, not an accident.
  - Both boundaries are tested against the real 2015–2026 warehouse in
    `pipeline/tests/test_pivot_real_data.py`: Virgin America rolls up from 2016-12 (not
    2016-11) and Hawaiian from 2024-09 (not 2024-08) — real traffic straddles both months, so
    those two are observable through the pivot's aggregated output. The upper boundary is
    NOT observable that way for VX: it has zero `fct_segment_month` rows on or after
    2018-04 (its last real filing is 2018-03, consistent with the brand retiring), so a
    query filtered to VX at 2018-04 returns nothing regardless of `<` vs `<=` — there's
    nothing on the left side of the join to begin with. That gap is closed by a second test
    that loads the actual join fragment and probes it against one synthetic row standing in
    for a segment filed in VX's exclusive thru month. Verified by mutation: flipping `>=` to
    `>` breaks both real-traffic boundary tests; flipping `<` to `<=` breaks only the
    synthetic-probe test — proof the naive "real data will catch it" assumption was false for
    this specific boundary.
  - `pipeline/mainline_map.py`'s `MapEntry.covers()` and `check_no_overlaps()` now use the
    same inclusive-`effective_from`/exclusive-`effective_to` semantics as this SQL join —
    this was flagged as a doc-only mismatch in Task 5's first pass, then found to be a real
    bug: `parent_for(21171, "2018-04")` returned Alaska on the real shipped VX row (build-time
    validation only, never reached query time, so it never produced a wrong pivot answer, but
    it contradicted this doc and the SQL). A **gap-free handoff between two parents is one
    row's `effective_to` equal to the next row's `effective_from`** — `check_no_overlaps` was
    also fixed, since under the old inclusive reading it rejected that exact shape as an
    overlap, which would have broken `make ingest`/`make warehouse` the next time a
    date-ranged acquisition was entered using this convention. See
    `pipeline/reference/mainline_group.csv`'s header comment, corrected to match.
- **Admission rule.** `basis = owned`: a wholly-owned subsidiary, for the months of
  ownership. `basis = contract`: a regional admitted ONLY for months in which ALL of its
  scheduled passenger flying was for this one parent (capacity purchase or prorate) — no
  concurrent second partner, no own-brand flying. Every contract row cites a fetched source
  for its boundary months, and its per-quarter hub share must not contradict it. Transition
  months (flying for two partners) are left as GAPS between rows: they stay at the operating
  carrier. Never shared regionals (SkyWest OO, Republic YX): they fly for several mainlines in
  the same month, which no date range can express. The loader refuses a `basis` outside
  `owned`/`contract` and a `contract` row with no `source`.
- Verify all dates against filings at ingest. **Do not trust the table above as gospel** —
  it is a starting point, and the single most reviewable artifact in the pipeline. Keep it
  as a checked-in declarative file (CSV/YAML), not code, so a reviewer needn't read Python
  to audit it.
- **Assert the map is total:** every `(airline_id, year_month)` maps to exactly one parent
  or to itself. Overlapping ranges are a test failure, not a runtime tiebreak.

---

## Everyone else stays as operating carrier

Two distinct reasons:

- **Shared regionals** (SkyWest OO, Republic YX, and Mesa YV before 2023-05) fly for several
  mainlines at once → not attributable in those months.
- **Contract months that fail the admission rule.** Excluded, and why:
  - **SkyWest OO, Republic YX, Shuttle America S5** — concurrent partners throughout.
  - **Mesa before 2023-05** — concurrent American and United. **Mesa from 2025-12** —
    post-merger flying unsourced.
  - **Compass CP 2015-01..2015-02 (Delta)** — sourced, but the hub data shows no change at the
    claimed 2015-03 switch, so nothing corroborates it; 0.6M pax.
  - **GoJet 2020-04..2020-12** — only Wikipedia dates the Delta exit to 2020-03.
  - **ExpressJet aha! 2021-10..2022-08** — own brand.
  - Every month outside the contract rows above — multi-partner, transition or own-brand:
    Air Wisconsin 2017-09..2018-02, 2023-03..2023-06 and from 2025-04; ExpressJet before
    2019-02 and from 2020-10; Trans States before 2019-01; GoJet before 2021-01; Empire from
    2021-02.

**The rollup is a grouping layered on the operating-carrier grain, NOT a replacement.**
Aircraft type stays at the grain, so "Delta group downgauged PDX–SLC — mainline 737 seats
down, Endeavor CRJ seats up" is *still fully visible*.

---

## Three honesty caveats — enforce in the UI

1. **A group is not "all branded flying."** `Delta group` = DL + 9E. It does **not** include
   SkyWest/Republic flights also sold as Delta Connection (unattributable). Label precisely:
   *"Delta (mainline + subsidiaries + exclusive contract carriers)"* — never imply it's every
   flight painted as Delta. Misattribution-by-omission is still misattribution.
2. **Group-vs-group is still not all-branded flying vs all-branded flying.** United owns no
   subsidiary operators, so its group is United plus contract carriers only: CommutAir
   throughout, plus Air Wisconsin, GoJet, Mesa, ExpressJet and Trans States in their months.
   The shared regionals carry most of every mainline's Express/Connection flying and roll up
   to none of them. Annotate it, and always keep operating-carrier truth one toggle away.
3. **Group composition changes over time, and a time series must show that.** `Alaska group`
   means AS+QX in 2015, AS+QX+VX in 2017, and AS+QX+HA from late 2024. United's group changes
   composition at 2018-03, 2019-01, 2019-02, 2020-05, 2020-10, 2021-01, 2023-03, 2023-05 and
   2025-12; Air Wisconsin moves American → United → American. Group capacity steps at each
   boundary, and **that step is an ownership or contract event, not organic growth.**
   Annotate the boundary on any grouped series that crosses it. An unannotated step change
   here is the single most misleading chart this product can draw.

Default view is **operating carrier**; `mainline_group` is an opt-in toggle.

---

## 📌 Backlog (v1+): full mainline attribution

The rollup above covers owned and exclusive-contract metal. To attribute the rest:

- **Shared regionals** (SkyWest-type) need an external join — operator + flight number +
   date → marketing carrier, via a schedule feed (OAG/Cirium) or the DOT O&D survey. The
   only honest way to attribute them. Genuine v1+ scope. **No date-ranged map can fix
   these** — they fly for several mainlines on the same day.
