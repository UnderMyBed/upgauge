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

  it("names holders that do NOT share a name, where PA's two Pan Am rows do", async () => {
    // A second live ambiguous code, and it tests the FORMATTING differently from `PA`. `PA`'s
    // first two holders are byte-identical by name, so a formatter that dropped the id would
    // still produce three entries there and only the `new Set(...).size` assertion above would
    // notice. `2T` is held by airline_id 20116 (Canada 3000 Airlines Ltd.) and 22146
    // (BermudAir) -- visibly distinct airlines, so this pins that the NAMES reach the caller
    // rather than a list of ids that happens to be the right length.
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
  // real entities on served pages and nothing says so; these two sweep the catalog so that a
  // BTS refresh shipping a four-character carrier code, or a short name carrying a character
  // the pattern omits, fails HERE instead. Exercised through the resolver rather than by
  // re-stating the regex, so widening the pattern without widening reality cannot pass either.

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
    expect(codes.length).toBe(114);
    const refused: string[] = [];
    for (const code of codes) {
      if ((await resolveCarrierFilter(code)).kind !== "ok") refused.push(code);
    }
    expect(refused).toStrictEqual([]);
  });

  it("admits every fact-present aircraft-type slug, CE-180 excepted", async () => {
    const names = await factPresentDisplayValues("aircraft_type");
    expect(names.length).toBe(112);
    const refused: string[] = [];
    for (const name of names) {
      const kind = (await resolveTypeFilter(slugFor(name))).kind;
      if (kind !== "ok") refused.push(`${slugFor(name)}:${kind}`);
    }
    // CE-180 twice: it is the one slug two fact-present BTS codes share, so it is `ambiguous`
    // by design rather than admitted, and it appears once per code in this enumeration.
    expect(refused).toStrictEqual(["CE-180:ambiguous", "CE-180:ambiguous"]);
  });

  it("admits the separator-bearing slugs a `[A-Z0-9]`-only bound would silently drop", async () => {
    // The 15 short names carrying a `/` or a space become slugs carrying an extra `-`. They are
    // the ones an over-tight alphabet loses, and losing them is invisible: the page still
    // renders, the filter just never applies. Asserted as a population, not one fixture, since
    // BTS renamed type 699 out from under this repo's separator fixture set once already.
    const names = await factPresentDisplayValues("aircraft_type");
    const separated = names.map(slugFor).filter((s) => s.includes("-"));
    expect(separated.length).toBeGreaterThan(50);
    for (const slug of separated) {
      expect(/^[A-Z0-9-]{1,12}$/.test(slug)).toBe(true);
    }
  });
});
