import { PivotError, normalizeQuery, type Grain, type Grouping, type PivotQuery } from "@/lib/pivot/types";
import { renderPivot } from "@/lib/pivot/render";
import type { Allowlist } from "@/lib/pivot/allowlist";

export const URL_VERSION = 1;

export class UrlStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlStateError";
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Maps, not object literals -- `URL_TO_GRAIN["constructor"]` etc. on a plain object would
// return a truthy Function and sail past an `if (!grain)` guard, only caught later (and
// confusingly, as "unknown dimension 'function Object() { ... }'") by renderPivot's own
// re-validation. A Map has no prototype chain to collide with.
const GRAIN_TO_URL: ReadonlyMap<Grain, string> = new Map([
  ["segment", "seg"],
  ["route", "route"],
]);
const URL_TO_GRAIN: ReadonlyMap<string, Grain> = new Map([
  ["seg", "segment"],
  ["route", "route"],
]);
const GROUPING_TO_URL: ReadonlyMap<Grouping, string> = new Map([
  ["operating", "op"],
  ["mainline", "ml"],
]);
const URL_TO_GROUPING: ReadonlyMap<string, Grouping> = new Map([
  ["op", "operating"],
  ["ml", "mainline"],
]);
const ALLOWED_KEYS = new Set(["v", "k", "d", "m", "t", "f", "s", "n", "g"]);

/** Python's urllib.parse.quote(v, safe=""). encodeURIComponent leaves ! * ' ( ) literal;
 * Python does not, and the goldens pin Python. Real data hits this: 119 carrier codes
 * carry BTS's parenthesised suffix. */
export function quote(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Python's urllib.parse.unquote: decodes well-formed `%XX` escapes and leaves malformed
 * ones (a `%` not followed by two hex digits) untouched, byte-for-byte and character-for-
 * character -- it never throws. `decodeURIComponent` throws `URIError` on exactly that input
 * (`decodeURIComponent("%ZZ")` -- a hand-edited or garbled permalink hits this constantly),
 * which is not a `UrlStateError` and would escape `decode` as an unhandled exception. Runs of
 * consecutive valid escapes are collected as raw bytes and decoded together as UTF-8 with
 * `errors="replace"` (an invalid/incomplete multi-byte sequence becomes U+FFFD per byte-run,
 * matching Python's `bytes.decode("utf-8", "replace")` exactly -- verified against Python
 * across malformed single escapes, multi-byte UTF-8, and mixed valid/invalid runs). */
export function pyUnquote(s: string): string {
  if (!s.includes("%")) return s;
  const pending: number[] = [];
  let out = "";
  const flushPending = () => {
    if (pending.length === 0) return;
    out += new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(pending));
    pending.length = 0;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "%") {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        pending.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
      // Malformed escape: the '%' (and whatever follows it) passes through literally, same
      // as Python's unquote_to_bytes falling through to KeyError on an invalid hex pair.
      flushPending();
      out += "%";
      i += 1;
      continue;
    }
    flushPending();
    out += c;
    i += 1;
  }
  flushPending();
  return out;
}

/** Python's `int(s)`: strips surrounding whitespace, an optional leading sign, and permits
 * single underscores between digit groups as separators (`int("1_000") == 1000`) -- used for
 * both `v` and `n`, since `urlstate.py` calls bare `int(...)` on both (lines 224 and 253).
 * Anything else -- a decimal point, exponent, empty string, doubled/leading/trailing
 * underscore -- is `ValueError` there and `UrlStateError` here. */
const PY_INT_RE = /^[ \t\n\r\f\v]*[+-]?\d+(?:_\d+)*[ \t\n\r\f\v]*$/;

function parsePyInt(raw: string, label: string): number {
  if (!PY_INT_RE.test(raw)) {
    throw new UrlStateError(`${label} must be an integer, got '${raw}'`);
  }
  return Number(raw.trim().replace(/_/g, ""));
}

export function encode(q: PivotQuery): string {
  const parts = [
    `v=${URL_VERSION}`,
    `k=${GRAIN_TO_URL.get(q.grain)}`,
    `d=${q.dimensions.join(",")}`,
    `m=${q.measures.join(",")}`,
    `t=${q.timeFrom}:${q.timeTo}`,
  ];
  for (const [key, values] of q.filters) {
    parts.push(`f=${quote(key)}:${values.map(quote).join(",")}`);
  }
  if (q.sort !== null) parts.push(`s=${q.sortDesc ? "-" : ""}${q.sort}`);
  parts.push(`n=${q.limit}`);
  parts.push(`g=${GROUPING_TO_URL.get(q.grouping)}`);
  return parts.join("&");
}

/** Split on the literal & and the first =. Deliberately NOT URLSearchParams: decoding must
 * happen only after every structural delimiter -- including f's own : and , -- has done its
 * job, or a percent-encoded structural comma is silently corrupted. */
function splitPairs(qs: string): [string, string][] {
  if (!qs) return [];
  const out: [string, string][] = [];
  for (const chunk of qs.split("&")) {
    if (!chunk) continue;
    const i = chunk.indexOf("=");
    out.push(i === -1 ? [chunk, ""] : [chunk.slice(0, i), chunk.slice(i + 1)]);
  }
  return out;
}

function parseFilter(raw: string): [string, string[]] {
  const i = raw.indexOf(":");
  if (i === -1) throw new UrlStateError(`malformed filter '${raw}', expected 'key:val1,val2,...'`);
  const key = pyUnquote(raw.slice(0, i));
  const values = raw.slice(i + 1).split(",").filter((v) => v).map(pyUnquote);
  if (!key || values.length === 0) {
    throw new UrlStateError(`malformed filter '${raw}', expected 'key:val1,val2,...'`);
  }
  return [key, values];
}

export function decode(qs: string, a: Allowlist): PivotQuery {
  const seen = new Set<string>();
  const filters: [string, string[]][] = [];
  const single: Record<string, string> = {};

  for (const [key, raw] of splitPairs(qs)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new UrlStateError(
        `unknown query key '${key}': allowed keys are ${[...ALLOWED_KEYS].sort().join(", ")}`,
      );
    }
    if (key === "f") {
      filters.push(parseFilter(raw));
      continue;
    }
    if (seen.has(key)) {
      throw new UrlStateError(
        `duplicate key '${key}': a permalink that quietly renders a different query than it ` +
          "encodes is worse than one that errors",
      );
    }
    seen.add(key);
    single[key] = pyUnquote(raw);
  }

  // v/k/d/m/t are always required. n (limit) and g (grouping) are optional with defaults --
  // resolved per repo-owner decision: matching pipeline/urlstate.py exactly (lines 250-259)
  // takes precedence over stricter-than-reference totality, since an absent optional key with
  // a documented default is not the failure the totality rule targets (that rule is about
  // unknown keys, duplicate keys, and invalid values -- all still rejected below).
  for (const required of ["v", "k", "d", "m", "t"]) {
    if (!(required in single)) throw new UrlStateError(`missing required key '${required}'`);
  }

  const version = parsePyInt(single.v, "url version ('v')");
  if (version !== URL_VERSION) {
    throw new UrlStateError(`unrecognised url version '${single.v}', expected ${URL_VERSION}`);
  }

  const grain = URL_TO_GRAIN.get(single.k);
  if (grain === undefined) throw new UrlStateError(`unknown grain token '${single.k}'`);

  let grouping: Grouping;
  if ("g" in single) {
    const resolved = URL_TO_GROUPING.get(single.g);
    if (resolved === undefined) throw new UrlStateError(`unknown grouping token '${single.g}'`);
    grouping = resolved;
  } else {
    grouping = "operating";
  }

  const colon = single.t.indexOf(":");
  if (colon === -1 || single.t.indexOf(":", colon + 1) !== -1) {
    throw new UrlStateError(`malformed time range '${single.t}', expected 'YYYY-MM:YYYY-MM'`);
  }
  const timeFrom = single.t.slice(0, colon);
  const timeTo = single.t.slice(colon + 1);
  if (!MONTH_RE.test(timeFrom) || !MONTH_RE.test(timeTo)) {
    throw new UrlStateError(`malformed time range '${single.t}', expected 'YYYY-MM:YYYY-MM'`);
  }

  const limit = "n" in single ? parsePyInt(single.n, "limit ('n')") : 100;

  let sort: string | null = null;
  let sortDesc = true;
  if ("s" in single) {
    sortDesc = single.s.startsWith("-");
    sort = sortDesc ? single.s.slice(1) : single.s;
    if (!sort) throw new UrlStateError("malformed sort key");
  }

  // Falsy (missing-from-URL or explicitly empty, e.g. 'd=') collapses to an empty list rather
  // than [''], mirroring pipeline/urlstate.py's `if single.get("d") else ()` -- an empty 'd'
  // is then a candidate PivotQuery with no dimensions, letting renderPivot reject it with its
  // own "at least one dimension is required" message instead of a spurious "unknown dimension
  // ''" from an allowlist lookup on the empty string.
  const q = normalizeQuery({
    grain,
    dimensions: single.d ? single.d.split(",") : [],
    measures: single.m ? single.m.split(",") : [],
    timeFrom,
    timeTo,
    filters,
    sort,
    sortDesc,
    limit,
    grouping,
  });

  // Identifier and structural validation is reused as-is -- one allowlist, not two.
  try {
    renderPivot(q, a);
  } catch (e) {
    if (e instanceof PivotError) throw new UrlStateError(e.message);
    throw e;
  }
  return q;
}
