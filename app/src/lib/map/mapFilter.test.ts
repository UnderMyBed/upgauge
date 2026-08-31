import { describe, expect, it } from "vitest";
import { rawFilterValue, resolveCarrierFilter, resolveTypeFilter } from "@/lib/map/mapFilter";
import { slugFor } from "@/lib/aircraftSlug";
import { dataAsOf, runPivot } from "@/lib/db";
import { displayValue, resolutionKey } from "@/lib/resolve";

/** Enumerate one dimension's fact-present values through the EXISTING pivot -- no new SQL, and
 * no inline SQL either (CLAUDE.md: all query logic lives in `.sql` files). This is the idiom
 * `aircraftSlug.test.ts`'s live-catalog test already uses, and the reason both bound tests below
 * can sweep the whole catalog without adding a `03_queries` file and the four gates F22 lists. */
async function factPresentDisplayValues(dimension: string): Promise<string[]> {
  const asOf = await dataAsOf();
  const result = await runPivot({
    grain: "segment",
    dimensions: [dimension],
    measures: ["seats"],
    timeFrom: "2015-01",
    timeTo: asOf,
    filters: [],
    sort: null,
    sortDesc: true,
    limit: 1000,
    grouping: "operating",
  });
  return result.rows.map((r) => {
    const raw = String(r[dimension]);
    return displayValue(result.resolved.get(resolutionKey(dimension, raw)), raw);
  });
}

describe("rawFilterValue", () => {
  it("returns the RAW, still-percent-encoded bytes", () => {
    // THE WHOLE POINT OF THIS FUNCTION, asserted against the alternative rather than alone:
    // `URLSearchParams` percent-decodes, so under that read `%42737-8` IS `B737-8` and a bound
    // running after it cannot tell the two apart. That is the live `?y=` hole (`y=%3201%39` ->
    // "2019") at a much bigger radius, since these values are textual.
    expect(rawFilterValue("type=%42737-8", "type")).toBe("%42737-8");
    expect(new URLSearchParams("type=%42737-8").get("type")).toBe("B737-8");
  });

  it("is total on the shapes the codec's own splitter tolerates", () => {
    expect(rawFilterValue("", "type")).toBeNull();
    expect(rawFilterValue("carrier=DL", "type")).toBeNull();
    expect(rawFilterValue("type", "type")).toBe("");
    expect(rawFilterValue("a=1&type=B737-8&b=2", "type")).toBe("B737-8");
    expect(rawFilterValue("&&type=B737-8&", "type")).toBe("B737-8");
  });

  it("compares the key whole, not as a prefix or a suffix", () => {
    // `splitPairs` splits on the FIRST `=`, so the key is compared whole. A `startsWith`/
    // `endsWith` reader would answer `subtype=X` or `typex=X` for `type`.
    expect(rawFilterValue("subtype=B737-8", "type")).toBeNull();
    expect(rawFilterValue("typex=B737-8", "type")).toBeNull();
  });
});

describe("resolveTypeFilter", () => {
  it("reports 'none' when the key is absent", async () => {
    expect(await resolveTypeFilter(null)).toEqual({ kind: "none" });
  });

  it("resolves a real type to its display code and its zero-padded id", async () => {
    expect(await resolveTypeFilter("B737-8")).toEqual({ kind: "ok", code: "B737-8", id: "614" });
  });

  it("keeps a leading zero on the id rather than int-parsing it", async () => {
    // CLAUDE.md's hard rule and the reason `MapFilter` is generic in its id: 13 fact-present
    // types carry a leading zero, and `010` becomes `10` the moment this is typed as a number
    // -- a join that breaks SILENTLY. `B737-8` above cannot catch that: `Number("614")` still
    // reads 614, so only a leading-zero type distinguishes the correct code from the buggy one.
    // BONANZA, code 010: fact-present, and its short name is unique so it resolves rather than
    // going ambiguous.
    const f = await resolveTypeFilter("BONANZA");
    expect(f).toEqual({ kind: "ok", code: "BONANZA", id: "010" });
  });

  it("refuses an ambiguous type rather than picking one airframe", async () => {
    // THE ONE THIS FUNCTION EXISTS FOR. `CE-180` names BTS codes 030 (CESSNA 180) and 031
    // (CESSNA 180A/B), both of which really flew, and no scoping resolves it. Ambiguity here
    // arrives as a THROWN `AmbiguousCodeError` out of `insertUniqueByCode`, not as a return
    // branch -- calling `lookupAircraftByName` directly instead of `resolveAircraftSlug` would
    // inherit that throw onto the proxy path, where nothing catches it.
    expect(await resolveTypeFilter("CE-180")).toEqual({
      kind: "ambiguous",
      raw: "CE-180",
      holders: ["030", "031"],
    });
  });

  it("sorts the holders rather than returning driver row order", async () => {
    // Asserted as an ORDERING, not as a set: an unsorted list is whatever order the driver
    // returned, so the same URL renders two different ways across restarts. A `toContain` pair
    // passes under that bug. `not-found.tsx:82-87` makes this same correction for this same data.
    const f = await resolveTypeFilter("CE-180");
    if (f.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${f.kind}`);
    expect(f.holders).toStrictEqual([...f.holders].sort());
  });

  it("names a type that resolves to nothing, and says which way it failed", async () => {
    const f = await resolveTypeFilter("NOPE-1");
    if (f.kind !== "unknown") throw new Error(`expected unknown, got ${f.kind}`);
    expect(f.raw).toBe("NOPE-1");
    expect(f.reason).toContain("NOPE-1");
  });

  it("refuses a percent-spelling of a REAL type, before any query", async () => {
    // `%42737-8` decodes to `B737-8`. Under a decoded-value bound this is admitted and becomes
    // a second CDN cache key for a byte-identical page; the raw-byte bound refuses it. The
    // reason must name the SPELLING rule -- an "unknown type" message here would be a lie,
    // since the type exists.
    const f = await resolveTypeFilter("%42737-8");
    if (f.kind !== "unknown") throw new Error(`expected unknown, got ${f.kind}`);
    expect(f.reason).toContain("percent-encoding");
  });

  it("refuses a lower-case spelling of a REAL type", async () => {
    // One value, one spelling (`bounds.ts`'s LITERAL_KEYS rule). The path segment 308s on case;
    // a query VALUE has no redirect mechanism available to it, because `canonicalQuery.ts`
    // decides the key set and inspects no value. Refusing is the honest remaining answer, and
    // it is what makes `resolveAircraftSlug`'s `redirect` outcome unreachable from here.
    const f = await resolveTypeFilter("b737-8");
    if (f.kind !== "unknown") throw new Error(`expected unknown, got ${f.kind}`);
    expect(f.reason).toContain("b737-8");
  });

  it("refuses the slash spelling that would otherwise reach the redirect branch", async () => {
    // `A320-1/2` is a real short name whose canonical slug is `A320-1-2`, so it is the ONLY
    // shape of input that could return `redirect`. Refused at the bound, before any query.
    expect((await resolveTypeFilter("A320-1/2")).kind).toBe("unknown");
  });

  it("refuses an over-long value unread", async () => {
    expect((await resolveTypeFilter("A".repeat(13))).kind).toBe("unknown");
  });
});

describe("resolveCarrierFilter", () => {
  it("reports 'none' when the key is absent", async () => {
    expect(await resolveCarrierFilter(null)).toEqual({ kind: "none" });
  });

  it("resolves a real carrier to its code and its numeric AIRLINE_ID", async () => {
    const f = await resolveCarrierFilter("DL");
    if (f.kind !== "ok") throw new Error(`expected ok, got ${f.kind}`);
    expect(f.code).toBe("DL");
    // A number here, where the type filter's id is a string -- the two vocabularies genuinely
    // differ, which is why `MapFilter` is generic rather than picking one.
    expect(typeof f.id).toBe("number");
    expect(f.id).toBeGreaterThan(0);
  });

  it("refuses a code held by MORE THAN ONE airline, naming every holder", async () => {
    // `/carrier/PA` is `notFound`, NOT `ambiguous` -- `CarrierResult` is a three-way union with
    // no ambiguous kind. `lookupCarriersByCode(["PA"])` returns nothing because it filters to
    // fact-present airlines, so `resolveCarrier` takes its notFound branch, and
    // `carrierHoldersByCode` is what surfaces the collision: two Pan Am eras (20384, 20386)
    // plus 20389 Florida Coastal, an unrelated carrier sharing the code.
    const f = await resolveCarrierFilter("PA");
    if (f.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${f.kind}`);
    expect(f.holders.length).toBe(3);
    expect(f.holders.join(" | ")).toContain("Florida Coastal");
    // The two Pan Am rows are BYTE-IDENTICAL by name, so the id is what distinguishes them: a
    // bare name list would print one string twice and explain nothing about why it cannot
    // resolve. This assertion goes red if the id is dropped from the format.
    expect(new Set(f.holders).size).toBe(3);
  });

  it("refuses a code with EXACTLY TWO holders -- the `> 1` threshold, which PA cannot pin", async () => {
    // WHAT THIS ACTUALLY CATCHES, corrected after review: not the formatting. Traced against
    // both formatting mutants, `2T` stays GREEN for each -- ids-only reddens `PA`'s
    // `toContain("Florida Coastal")` and names-only reddens `PA`'s `Set(...).size === 3`, and
    // `PA` alone is sufficient for both.
    //
    // Its discriminating power is the THRESHOLD. Mutate `holders.length > 1` to `> 2` and `PA`
    // (three holders) stays ambiguous while this goes `unknown`; `02Q` above pins the other
    // side (one holder must NOT be ambiguous). Between them the boundary is closed on both
    // edges, which nothing did before -- `PA` and `02Q` alone leave `> 2` passing.
    //
    // FIXTURE RISK, stated because this repo has been bitten by exactly this: `2T`'s second
    // holder is airline_id 22146, BermudAir, which is currently operating. One T-100 filing
    // makes it fact-present, `resolveCarrier` then resolves `2T` to it, and this test goes red
    // rather than silently weakening -- fail-loud, which is why it is acceptable. An
    // all-defunct pair would be stabler if that day comes.
    const f = await resolveCarrierFilter("2T");
    if (f.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${f.kind}`);
    expect(f.holders.length).toBe(2);
    expect(f.holders.join(" | ")).toContain("Canada 3000");
    expect(f.holders.join(" | ")).toContain("BermudAir");
  });

  it("sorts the holders by airline_id rather than returning driver row order", async () => {
    const f = await resolveCarrierFilter("PA");
    if (f.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${f.kind}`);
    const ids = f.holders.map((h) => Number(/airline_id (\d+)\)$/.exec(h)?.[1]));
    expect(ids).toStrictEqual([...ids].sort((a, b) => a - b));
  });

  it("calls a code held by NOBODY unknown, not ambiguous", async () => {
    const f = await resolveCarrierFilter("ZZ");
    if (f.kind !== "unknown") throw new Error(`expected unknown, got ${f.kind}`);
    expect(f.reason).toContain("ZZ");
  });

  it("calls a code held by exactly ONE never-filing airline unknown, not ambiguous", async () => {
    // THE BOUNDARY BETWEEN THE TWO REFUSALS, and the reason the test is `> 1` and not `> 0`.
    // One holder is not a refusal to choose: there is a single airline and it has simply never
    // filed a T-100 Segment row, which is the COMMON carrier 404. Measured against this
    // warehouse: of the 1,544 codes no fact-present airline holds, 1,450 have exactly one
    // holder and 94 have more (`carrier.ts:52-63` records the same split). `02Q` is Titan
    // Airways, airline_id 21040, one holder, never filed -- so a `> 0` bug would word this as a
    // collision naming a single airline, which is nonsense a reader would have to decode.
    const f = await resolveCarrierFilter("02Q");
    if (f.kind !== "unknown") throw new Error(`expected unknown, got ${f.kind}`);
    expect(f.reason).toContain("02Q");
  });

  it("refuses a percent-spelling of a REAL carrier, before any query", async () => {
    const f = await resolveCarrierFilter("%44L");
    if (f.kind !== "unknown") throw new Error(`expected unknown, got ${f.kind}`);
    expect(f.reason).toContain("percent-encoding");
  });

  it("refuses a lower-case spelling of a REAL carrier", async () => {
    expect((await resolveCarrierFilter("dl")).kind).toBe("unknown");
  });
});

describe("the value bounds against the live catalog", () => {
  // The `MAX_SLUG_SEPARATORS` discipline (`aircraftSlug.ts:50-58`) applied to a bound whose
  // whole job is to be NARROWER than the data it admits. A bound derived from a guess refuses
  // real entities on served pages and nothing says so; these three sweep the catalog so that a
  // BTS refresh shipping a four-character carrier code, or a short name carrying a character
  // the pattern omits, fails HERE instead. Exercised through the resolver rather than by
  // re-stating the regex, so widening the pattern without widening reality cannot pass either.
  //
  // RESOLVED CONCURRENTLY, not one `await` at a time (#135). Sequentially awaiting 114 then 112
  // then ~50-60 single-code resolves -- 226+ round trips through a fresh DuckDB connection each
  // (`db.ts:97-109`'s documented per-call connection) -- put each of these three tests' own
  // runtime a few hundred ms under Vitest's default 5,000 ms ceiling on an idle box, and
  // measurably over it under concurrent load: three isolated runs of this file measured 3.09s,
  // 5.72s, 6.53s, and under load the "admits every fact-present carrier code" test alone was
  // seen at 5,003ms -- 3ms past the timeout, roughly one run in three. The runtime scaled with
  // `sitemap_carriers` + the fact-present aircraft-type count, both of which grow with every
  // BTS refresh, so the margin only shrinks. `Promise.all` over the same per-code resolver
  // calls -- still `resolveCarrierFilter`/`resolveTypeFilter`, one call per code, so the
  // property under test and its coverage are unchanged -- turns 226+ sequential round trips
  // into concurrent ones.
  //
  // Measured on this box, idle (mean of 3 runs each): the carrier sweep dropped from ~560ms to
  // ~226ms, the aircraft sweep from ~594ms to ~272ms, the separator sweep from ~405ms to
  // ~203ms -- roughly 2-2.5x, because the sequential form's cost is dominated by one-at-a-time
  // round-trip/IPC overhead that concurrency amortizes across cores.
  //
  // Measured under 8-way concurrent load (8 full copies of this file launched at once, A/B'd
  // back-to-back on the same box state, mean of 8 runs each) that improvement shrinks a lot:
  // carrier 1832ms -> 1698ms, aircraft 2399ms -> 2190ms, separator 1632ms -> 1353ms -- roughly
  // 10-20%, not 2-2.5x. Once the box is CPU-saturated by concurrent processes, the bottleneck
  // stops being "how many round trips does one process serialize" and becomes "how much CPU is
  // there to go around", which fanning out within one process cannot manufacture more of. Say so
  // plainly: this is a real improvement, not a restated one, but it is a smaller one than the
  // idle number would suggest, and neither figure crossed the 5,000ms ceiling in either form on
  // this box (worst observed here: sequential, 3,408ms).
  //
  // NOT measured here: a real CI runner, which is typically 2 vCPU rather than this box's core
  // count, and unpooled `Promise.all` opens all 114 (then 112, then the separator subset)
  // DuckDB connections for a sweep at once rather than the sequential form's one at a time -- a
  // different resource shape, not just a faster one. `db.ts` pools or caps nothing (confirmed by
  // reading it -- `connect()` is a bare `getInstance().connect()` per call, no pool, no limiter),
  // so there is nothing here for this fan-out to exceed, but this file's own measurement does
  // not reach a small-CPU runner under real CI concurrency -- CI green on the PR built from this
  // commit is the evidence for that case, not this comment.
  //
  // TIMEOUT, BOUND TO THE GATED COUNT, not Vitest's flat 5,000ms default and not a second round
  // number chosen to feel safe -- the same failure mode the issue named for the original 5,000ms
  // ("goes stale the same way the original 5s did"). PER_SLUG_BUDGET_MS is derived from the
  // worst PER-SLUG rate measured above, not the idle one: idle this box resolved at ~2-2.7ms per
  // slug, but the worst single 8-way-concurrent-load run measured ~2,318ms / 112 aircraft codes
  // and ~2,002ms / 114 carrier codes -- both ~17.6-20.7ms/slug. 100ms/slug is that worst rate
  // with roughly 5x headroom for a real CI runner this file's own measurement does not reach
  // (typically 2 vCPU against this box's larger core count, per the paragraph above). Multiplied
  // by each test's own gated count -- `EXPECTED_CARRIER_COUNT` / `EXPECTED_AIRCRAFT_COUNT`, the
  // same numbers the assertions below already pin -- the ceiling grows exactly as the workload
  // does on a future BTS refresh, rather than going stale silently the way a flat number would.
  // NOT a timing assertion: nothing here asserts a duration, so a fast box still just passes fast
  // -- this only bounds how long a genuinely hung resolve is allowed to block the suite.
  const PER_SLUG_BUDGET_MS = 100;
  const EXPECTED_CARRIER_COUNT = 114;
  const EXPECTED_AIRCRAFT_COUNT = 112;

  it("admits every fact-present carrier code, and refuses the NULL carrier group", async () => {
    // 115 groups, not 114: T-100 carries rows with NO `AIRLINE_ID` at all -- 51 of them over
    // 2015-2026 (CLAUDE.md's data gotchas; `docs/data/invariants.md` has the per-year split),
    // and a `GROUP BY op_airline_id` gives them their own group whose display value is the
    // literal string "null". That is the pivot behaving correctly, not a defect, so it is named
    // here rather than filtered away silently -- and it must be REFUSED by the bound, because a
    // filing with no airline is not something a reader can filter a map by. Discovered by
    // running this test, not assumed: the first version asserted 114 and went red at 115.
    const groups = await factPresentDisplayValues("op_airline_id");
    expect(groups.length).toBe(115);
    expect(groups.filter((g) => g === "null")).toStrictEqual(["null"]);
    expect((await resolveCarrierFilter("null")).kind).toBe("unknown");

    const codes = groups.filter((g) => g !== "null");
    // 114, matching `sitemap_carriers` -- the count of carriers this site gives a page to.
    expect(codes.length).toBe(EXPECTED_CARRIER_COUNT);
    const results = await Promise.all(codes.map((code) => resolveCarrierFilter(code)));
    const refused: string[] = [];
    codes.forEach((code, i) => {
      if (results[i].kind !== "ok") refused.push(code);
    });
    expect(refused).toStrictEqual([]);
  }, PER_SLUG_BUDGET_MS * EXPECTED_CARRIER_COUNT);

  it("admits every fact-present aircraft-type slug, CE-180 excepted", async () => {
    const names = await factPresentDisplayValues("aircraft_type");
    expect(names.length).toBe(EXPECTED_AIRCRAFT_COUNT);
    const results = await Promise.all(names.map((name) => resolveTypeFilter(slugFor(name))));
    const refused: string[] = [];
    names.forEach((name, i) => {
      const kind = results[i].kind;
      if (kind !== "ok") refused.push(`${slugFor(name)}:${kind}`);
    });
    // CE-180 twice: it is the one slug two fact-present BTS codes share, so it is `ambiguous`
    // by design rather than admitted, and it appears once per code in this enumeration.
    expect(refused).toStrictEqual(["CE-180:ambiguous", "CE-180:ambiguous"]);
  }, PER_SLUG_BUDGET_MS * EXPECTED_AIRCRAFT_COUNT);

  it("admits the separator-bearing slugs a `[A-Z0-9]`-only bound would silently drop", async () => {
    // The 15 short names carrying a `/` or a space become slugs carrying an extra `-`. They are
    // the ones an over-tight alphabet loses, and losing them is invisible: the page still
    // renders, the filter just never applies. Asserted as a population, not one fixture, since
    // BTS renamed type 699 out from under this repo's separator fixture set once already.
    //
    // Exercised THROUGH THE RESOLVER, per this block's header. An earlier version re-stated
    // `/^[A-Z0-9-]{1,12}$/` here as a literal -- a second copy of the rule, hand-synced to the
    // first, which is the drifting-duplicate-validator failure `mapFilter.ts` itself complains
    // about: tightening `TYPE_FILTER_VALUE` left it green.
    const names = await factPresentDisplayValues("aircraft_type");
    const separated = names.filter((n) => slugFor(n).includes("-"));
    expect(separated.length).toBeGreaterThan(50);
    const results = await Promise.all(separated.map((name) => resolveTypeFilter(slugFor(name))));
    const refused: string[] = [];
    separated.forEach((name, i) => {
      const kind = results[i].kind;
      if (kind !== "ok") refused.push(`${slugFor(name)}:${kind}`);
    });
    expect(refused).toStrictEqual(["CE-180:ambiguous", "CE-180:ambiguous"]);
    // `separated` has no fixed expected count of its own (`toBeGreaterThan(50)` above is a
    // floor, not a pin), but it is always a SUBSET of `names` -- `names.filter(...)` cannot
    // exceed `names.length` -- so EXPECTED_AIRCRAFT_COUNT is a safe, structurally-true upper
    // bound for its timeout rather than a second hand-maintained constant that could drift
    // from the real (currently 75) count.
  }, PER_SLUG_BUDGET_MS * EXPECTED_AIRCRAFT_COUNT);
});
