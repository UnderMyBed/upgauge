import { splitPairs } from "@/lib/pivot/urlstate";
import { resolveCarrier } from "@/lib/carrier";
import { resolveAircraftSlug } from "@/lib/aircraftSlug";

/** `?type=` on `/carrier/:code` and `?carrier=` on `/aircraft/:name` -- the two map-filter query
 * keys (#106), and the admission policy for their VALUES.
 *
 * THESE ARE THE FIRST QUERY KEYS ON THIS SITE WHOSE VALIDATION NEEDS A DATABASE READ ON THE
 * PROXY PATH, and that is a new shape rather than an application of an existing one. Issue #106
 * cites `?y=` and #87 as the precedent; NEITHER resolves anything, and building on that reading
 * produces a filter that is structurally well-formed and refers to nothing:
 *
 *   - `?y=` is a pure, synchronous, database-free structural check. `lib/year.ts:64-70` is
 *     `/^\d{4}$/` plus a numeric range, and that file's own header states the constraint --
 *     "`proxy.ts` reads this file's verdict to decide cacheability BEFORE the page runs ... so
 *     `parseYear` is deliberately synchronous and touches no database".
 *   - #87 reads a dimension's `valueType` off the already-loaded catalog (`render.ts:76-93`),
 *     and says so: "No extra database query: `loadAllowlist()` is the probe the proxy already
 *     makes."
 *
 * A carrier code and an aircraft-type slug have neither property: whether `B737-8` names
 * anything is a fact about the WAREHOUSE, exactly like `canonicalQuery.ts`'s reason for never
 * inspecting a value (`canonicalQuery.ts:14-17`). So the value is RESOLVED, and the decision --
 * made deliberately, with its cost -- is to resolve **only when the filter key is present**.
 * An unfiltered request pays nothing, which is every crawler hit and every one of the entity
 * URLs in `sitemap.xml`. A filtered one pays one extra resolve on top of the slug's. MEASURED
 * here rather than quoting `proxy.ts:679-698`'s 3.6/4.6 ms, which are `isCacheable`'s lookup and
 * not this one -- warm, in-process, mean of 30 calls, BOTH SIDES UNDER THE ONE PROTOCOL:
 *
 *     resolveCarrierFilter  ZZ (unknown)    9.42 ms  ->  7.32 ms
 *     resolveCarrierFilter  PA (ambiguous)  9.37 ms  ->  7.65 ms
 *
 * The saving is one `carrierHoldersByCode`, which costs 1.40 ms measured alone -- and that is
 * the whole of it. `resolveCarrier` already makes that call to word its own `reason`, so the
 * holders now ride on `CarrierResult.notFound` (`carrier.ts`) instead of being re-queried here.
 *
 * COUNTED STATICALLY, because the milliseconds above are the weaker claim: a refused
 * `?carrier=` ran THREE carrier queries inside this function (`lookup_carrier_by_code`, then
 * `lookup_carrier_code_exists` twice) and now runs TWO. Across the whole proxy path for
 * `/aircraft/<slug>?carrier=<refused>`, including the slug's own resolve, that is four queries
 * down to three; the pre-#106 path ran one, because the key did not exist. Two is the FLOOR,
 * not a target missed: the refusal needs both carrier lookups -- one to learn the code is not
 * fact-present, one to learn who holds it -- so "where one would do" is structurally impossible
 * and was never true.
 *
 * The alternative -- a structural bound only -- makes an unresolvable filter a CACHEABLE 200,
 * which is the precise failure this module exists to refuse. What it does NOT close, and what
 * this module cannot close from here, is the ORIGIN cost of a refused value: a `no-store` 200
 * is a full page render the CDN keeps nothing of, and a value that fails the regex above is
 * still a canonical KEY SET, so `canonicalQuery.ts` does not redirect it. Before #106 any
 * unknown key on these paths was a 0.9-1.6 ms 307; a refused `type=` is an 82-104 ms render,
 * repeatable without bound. Named, with the edge rule it is left to, in
 * `docs/architecture/hosting.md` § What this does not close.
 *
 * ONE OWNER, TWO READERS, the relationship `lib/year.ts` has with `/airport` and `bounds.ts`
 * has with `/explore`: `proxy.ts` reads these verdicts to choose a `Cache-Control` before the
 * page runs, and the page reads them again to render. It is a SERVER admission policy, never a
 * codec check -- `bounds.ts:34-44` has the full argument for that split.
 *
 * NOTHING HERE MAY THROW ON A MALFORMED INPUT. `proxy.ts` has no try/catch outside its four
 * probes and that is deliberate (`proxy.ts:164-175`); `canonicalize()` once threw on a leading
 * `?` that "only a wiring bug could produce" and 500ed every matcher path. The two resolvers
 * below propagate a genuine DATABASE failure -- that is not a malformed input, and swallowing
 * it would turn a broken warehouse into a silent "no such carrier" -- and `proxy.ts`'s own
 * `isFilterCacheable` probe catches it there, exactly as `isCacheable` already does. */

/** The outcome of admitting one filter value. A closed union in the idiom `ParsedYear`,
 * `Canonical` and `BoundsVerdict` already use here: a new outcome added later is handled
 * explicitly by every caller rather than falling into a negation.
 *
 * `Id` IS GENERIC, and the pinned wave-2 contract's `id: number` was wrong. An aircraft type's
 * id is a ZERO-PADDED STRING -- `AircraftRef.id` is typed `string` for this reason alone
 * (`resolve.ts:121-125`), CLAUDE.md's hard rule is that `036` becomes `36` if int-parsed and
 * every downstream join breaks silently, and #105's own signature takes
 * `aircraftTypeCode: string`. A carrier's id is a real `AIRLINE_ID` integer. So
 * `resolveCarrierFilter` returns `MapFilter<number>` and `resolveTypeFilter` returns
 * `MapFilter<string>`, and the bare `MapFilter` still names the union both inhabit.
 *
 * `code` is the entity's own DISPLAY code -- `CarrierRef.code` (`DL`), `AircraftRef.code` (the
 * short name, `B737-8`) -- never the URL slug. The two differ for the 15 fact-present short
 * names carrying a `/` or a space (`A320-1/2` -> `A320-1-2`), and a consumer can recover the
 * slug from the name with the already-exported pure `slugFor` while it cannot recover the name
 * from the slug.
 *
 * `unknown` CARRIES A REASON, and the pinned contract's bare `{raw}` was not enough. Three
 * distinct failures land in this variant -- a code that names nothing, a non-canonical
 * spelling, and a percent-spelling -- and this project's rule is that a refusal names which
 * way it failed (`CarrierResult.notFound.reason` and `AircraftSlugResult.notFound.reason` both
 * already carry one). Without it the page must re-derive this module's rule to word its own
 * message, which is the drifting-duplicate-validator failure `bounds.ts` names twice. */
export type MapFilter<Id extends string | number = string | number> =
  /** No filter key on the request at all. The page's default, unfiltered view -- distinct from
   *  a filter that was PROVIDED and rejected, exactly as `ParsedYear`'s `default` is distinct
   *  from its `invalid`. No query is issued for this outcome. */
  | { kind: "none" }
  /** Resolved to exactly one entity. */
  | { kind: "ok"; code: string; id: Id }
  /** Well-formed enough to ask about, and it names nothing this dataset can filter by. */
  | { kind: "unknown"; raw: string; reason: string }
  /** The value names MORE THAN ONE entity, and picking one is the silent-pick failure this
   *  project has already paid for once (`AUS`, docs/data/invariants.md § Entity resolution).
   *  `holders` names every one of them. */
  | { kind: "ambiguous"; raw: string; holders: string[] };

/** THE VALUE BOUND, ON THE RAW BYTES -- and mirroring `?y=` here would reproduce a live hole at
 * a much bigger radius.
 *
 * `proxy.ts:430` reads `y` with `new URLSearchParams(rawQuery).get("y")`, which
 * PERCENT-DECODES, and `canonicalQuery.ts` never inspects a value -- so `%`-spellings of a
 * valid year survive as canonical. Machine-verified: `y=%3201%39` decodes to `"2019"`,
 * `parseYear` passes, and `/airport/SEA?y=%32019` is a distinct CDN cache key for a
 * byte-identical page under a one-hour shared cache. That family is bounded for a four-digit
 * year and is pre-existing and OUT OF SCOPE here (recorded in
 * docs/architecture/hosting.md § What this does not close). These two keys carry TEXTUAL
 * values, whose percent-spelling family is far larger, so they take `bounds.ts`'s shape
 * instead: checked on the raw bytes BEFORE any decode, per `bounds.ts:238-243` -- "once the
 * bytes carry no `%`, `pyUnquote` is the identity, so the raw bytes ARE the decoded value".
 *
 * Both patterns forbid `%` structurally rather than by a separate rule, because neither
 * alphabet contains it. They are MEASURED against the real catalog, not guessed:
 *
 *   - every one of `dim_carrier`'s 1,658 distinct codes matches `[A-Z0-9]{2,3}` -- all 114
 *     fact-present ones included, zero lower-case, none longer than 3.
 *   - every one of `dim_aircraft_type`'s 433 distinct short names produces a `slugFor` slug
 *     matching `[A-Z0-9-]+`, none longer than 8 -- all 111 fact-present slugs included.
 *
 * `mapFilter.test.ts` asserts both against the live catalog, so a BTS refresh that ships a
 * four-character carrier code or a slug carrying a new character fails a TEST rather than
 * silently refusing a real entity on a page. That is `MAX_SLUG_SEPARATORS`'s discipline
 * (`aircraftSlug.ts:50-58`), applied to a bound whose whole job is to be narrower than the
 * data it admits.
 *
 * The length ceilings are a COST bound, not a cache bound -- the cache-key family is closed by
 * resolution, since an unresolvable value is `no-store` however it is spelled. 12 is headroom
 * over a measured 8, in the same spirit as `MAX_SLUG_SEPARATORS`' "twice the real world and
 * still finite"; `resolveAircraftSlug` separately refuses an over-separated slug unread, so
 * the candidate expansion behind this cannot blow up.
 *
 * ONE VALUE, ONE SPELLING: both patterns are UPPERCASE-ONLY, so `?type=b737-8` is refused
 * rather than resolved. That is `bounds.ts`'s `LITERAL_KEYS` rule ("every key but `f` spelled
 * ONE way") rather than the path segment's, and it is what makes each resolver's `redirect`
 * outcome structurally unreachable here -- see `resolveTypeFilter` below. A query value has no
 * redirect mechanism available to it the way a path segment does: `canonicalQuery.ts` decides
 * the KEY set and inspects no value, so there is nowhere for a value-canonicalizing 307 to
 * live, and refusing is the honest remaining answer. */
const CARRIER_FILTER_VALUE = /^[A-Z0-9]{2,3}$/;
const TYPE_FILTER_VALUE = /^[A-Z0-9-]{1,12}$/;

/** Read one query key's value as RAW, still-percent-encoded BYTES.
 *
 * NEVER `new URLSearchParams(rawQuery).get(key)`: that percent-decodes, which is the whole of
 * the `?y=` hole above. Walks with the codec's own `splitPairs` rather than a second splitter,
 * for the reason that function's comment gives (`urlstate.ts:126-134`) and `bounds.ts:241-243`
 * repeats -- a second walk of the query string is a second chance to decode before the
 * structural delimiters have done their job.
 *
 * Takes the FIRST occurrence. On the proxy path a second one is unreachable: `canonicalize()`
 * runs before every branch that calls this and `reject`s a duplicate of a non-repeatable key
 * outright (`canonicalQuery.ts:356-363`), and neither of these keys is repeatable -- so
 * reaching a caller of this function at all means the query is already byte-canonical. Stated
 * rather than relied on silently, and total regardless: a caller outside that path gets a
 * defined answer, not a throw. */
export function rawFilterValue(rawQuery: string, key: string): string | null {
  for (const [k, raw] of splitPairs(rawQuery)) {
    if (k === key) return raw;
  }
  return null;
}

/** `what` carries its own article: "an aircraft type", not "a" + "aircraft type". This string is
 *  not internal -- it exists so #107/#108 can word the page's refusal without re-deriving this
 *  module's rule, so it reaches a reader the moment wave 2 renders it. */
function spellingReason(raw: string, what: string, shape: string): string {
  return (
    `'${raw}' is not ${what} this server will filter by -- ${shape}, spelled literally and ` +
    "without percent-encoding, because one value must have exactly one spelling"
  );
}

/** `?type=<aircraft slug>` on `/carrier/:code`.
 *
 * Calls `resolveAircraftSlug`, NEVER `lookupAircraftByName`. Ambiguity for an aircraft type
 * arrives as a THROWN `AmbiguousCodeError` out of `insertUniqueByCode`, caught at
 * `aircraftSlug.ts:134-146` -- calling the lookup directly inherits the throw onto the proxy
 * path, where nothing catches it. (`resolveFromMatches`'s own `matches.length > 1` branch is a
 * DIFFERENT case -- two short names flattened onto one slug -- and is unreachable on today's
 * data; it says so at `aircraftSlug.ts:96-100`. Both arrive here as `ambiguous` and both are
 * refused, so this function does not care which one fired.)
 *
 * `CE-180` is the reachable fixture: BTS codes 030 (CESSNA 180) and 031 (CESSNA 180A/B) share
 * that short name and both really flew.
 *
 * `holders` are the BTS codes, SORTED. Sorted because an unsorted list is driver row order,
 * which renders the same URL two different ways across restarts -- `not-found.tsx:82-87` makes
 * exactly this correction for exactly this data. They are bare codes rather than the airframe
 * NAMES because naming them needs a whole extra `runPivot` (`aircraft/[name]/not-found.tsx:
 * 67-78`), and this function runs on the proxy path where the budget is one extra query. The
 * page that wants names runs that query itself, as that 404 page already does. This is the one
 * asymmetry with `resolveCarrierFilter` below, which gets names for free because
 * `carrierHoldersByCode` is a lookup it was already going to make. */
export async function resolveTypeFilter(raw: string | null): Promise<MapFilter<string>> {
  if (raw === null) return { kind: "none" };
  if (!TYPE_FILTER_VALUE.test(raw)) {
    return {
      kind: "unknown",
      raw,
      reason: spellingReason(raw, "an aircraft type", "up to 12 of A-Z, 0-9 and '-'"),
    };
  }

  const resolved = await resolveAircraftSlug(raw);
  switch (resolved.kind) {
    case "ok":
      return { kind: "ok", code: resolved.type.code, id: resolved.type.id };
    case "ambiguous":
      return { kind: "ambiguous", raw, holders: [...resolved.ids].sort() };
    case "notFound":
      return { kind: "unknown", raw, reason: resolved.reason };
    case "redirect":
      // UNREACHABLE under the bound above, and handled anyway rather than asserted away. The
      // canonical slug is `slugFor(short_name)` -- uppercase, with `/` and ` ` mapped to `-` --
      // and every candidate the lookup can match re-slugs to the input, so an already-canonical
      // input can only come back equal. The spellings that WOULD produce a redirect (`b737-8`,
      // `A320-1/2`) are refused above, before any query. Mapped to `unknown` rather than `ok`
      // so that if the transform ever changes underneath this, the failure is a declined cache
      // and a named refusal -- never a filter quietly applied for a value the URL did not name.
      return {
        kind: "unknown",
        raw,
        reason: `'${raw}' is not the canonical spelling of an aircraft type ('${resolved.canonical}' is)`,
      };
  }
}

/** `?carrier=<code>` on `/aircraft/:name`.
 *
 * `/carrier/PA` IS `notFound`, NOT `ambiguous`, and that is why this MAPS rather than inventing
 * a fourth resolver outcome. `CarrierResult` is a THREE-way union with no `ambiguous` kind
 * (`carrier.ts:4-7`): `lookupCarriersByCode(["PA"])` returns nothing, because it filters to
 * fact-present airlines, so `resolveCarrier` takes its `notFound` branch and makes a SECOND
 * query -- `carrierHoldersByCode` (`resolve.ts:356-365`) -- purely to word the 404. Executed
 * against the real warehouse, that second query is what surfaces the collision: `PA` yields
 * airline_id 20384 and 20386 (both "Pan American World Airways") plus 20389 "Florida Coastal
 * Airlines", an unrelated carrier sharing the code.
 *
 * So: more than one holder is `ambiguous`; zero or one is `unknown`. One holder is NOT
 * ambiguous -- there is a single airline, it simply has never filed a T-100 Segment row, which
 * is the COMMON carrier 404 (1,544 of `dim_carrier`'s 1,658 distinct codes -- measured, and
 * pinned by this module's own test; `carrier.ts:52-63` states 1,543/1,657, one lower on both,
 * which is a pre-existing staleness in four files rather than a disagreement with this one) and
 * is honestly "nothing to filter by", not "we refuse to choose".
 *
 * `holders` name the airline AND its id, because the two Pan Am rows are BYTE-IDENTICAL by
 * name -- a bare name list would print the same string twice and tell a reader nothing about
 * why the code cannot resolve. Sorted by id, for `resolveTypeFilter`'s reason: this is a list
 * a page renders, and `carrierHoldersByCode` returns driver row order.
 * (`carrierNotFoundReason` deliberately does NOT sort its own prose version -- `carrier.ts:
 * 97-103` explains that it is one `<p>` rather than a list someone compares across loads. A
 * rendered list is the case that comment excludes, so it sorts.)
 *
 * `AmbiguousCodeError` from `lookupCarriersByCode` PROPAGATES, deliberately: fact-present
 * carrier codes collide zero times today and `carrier.ts:65-70` refuses to catch it precisely
 * so that a future collision is loud rather than a silently-picked airline. `proxy.ts`'s probe
 * catches it into a declined cache; the page 500s, which is the documented contract. */
export async function resolveCarrierFilter(raw: string | null): Promise<MapFilter<number>> {
  if (raw === null) return { kind: "none" };
  if (!CARRIER_FILTER_VALUE.test(raw)) {
    return {
      kind: "unknown",
      raw,
      reason: spellingReason(raw, "a carrier code", "two or three of A-Z and 0-9"),
    };
  }

  const resolved = await resolveCarrier(raw);
  if (resolved.kind === "ok") {
    return { kind: "ok", code: resolved.carrier.code, id: resolved.carrier.id };
  }
  if (resolved.kind === "redirect") {
    // Unreachable under the bound, for `resolveTypeFilter`'s reason and one more that is
    // measured: `resolveCarrier` redirects when `carrier.code !== slug`, and every one of
    // dim_carrier's 1,658 codes is already upper-case `[A-Z0-9]`, so an upper-case input that
    // matches a row equals that row's stored code. Handled in the same fail-safe direction.
    return {
      kind: "unknown",
      raw,
      reason: `'${raw}' is not the canonical spelling of a carrier code ('${resolved.canonical}' is)`,
    };
  }

  // `resolveCarrier` ALREADY made this query -- it needs the holders to word its `reason` --
  // so they ride on the result (`carrier.ts`) rather than being fetched again here. The first
  // version called `carrierHoldersByCode` a second time: three carrier queries per refused code
  // where two is the floor, measured at 9.42 ms against this version's 7.32 ms (see the header).
  const holders = resolved.holders;
  if (holders.length > 1) {
    return {
      kind: "ambiguous",
      raw,
      holders: [...holders]
        .sort((a, b) => a.id - b.id)
        .map((h) => `${h.name} (airline_id ${h.id})`),
    };
  }
  return { kind: "unknown", raw, reason: resolved.reason };
}
