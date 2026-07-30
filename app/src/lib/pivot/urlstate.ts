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
const GRAIN_TO_URL: Record<Grain, string> = { segment: "seg", route: "route" };
const URL_TO_GRAIN: Record<string, Grain> = { seg: "segment", route: "route" };
const GROUPING_TO_URL: Record<Grouping, string> = { operating: "op", mainline: "ml" };
const URL_TO_GROUPING: Record<string, Grouping> = { op: "operating", ml: "mainline" };
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

export function encode(q: PivotQuery): string {
  const parts = [
    `v=${URL_VERSION}`,
    `k=${GRAIN_TO_URL[q.grain]}`,
    `d=${q.dimensions.join(",")}`,
    `m=${q.measures.join(",")}`,
    `t=${q.timeFrom}:${q.timeTo}`,
  ];
  for (const [key, values] of q.filters) {
    parts.push(`f=${quote(key)}:${values.map(quote).join(",")}`);
  }
  if (q.sort !== null) parts.push(`s=${q.sortDesc ? "-" : ""}${q.sort}`);
  parts.push(`n=${q.limit}`);
  parts.push(`g=${GROUPING_TO_URL[q.grouping]}`);
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
  const key = decodeURIComponent(raw.slice(0, i));
  const values = raw.slice(i + 1).split(",").filter((v) => v).map(decodeURIComponent);
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
    single[key] = decodeURIComponent(raw);
  }

  for (const required of ["v", "k", "d", "m", "t", "n", "g"]) {
    if (!(required in single)) throw new UrlStateError(`missing required key '${required}'`);
  }
  if (single.v !== String(URL_VERSION)) {
    throw new UrlStateError(`unsupported version '${single.v}', expected ${URL_VERSION}`);
  }

  const grain = URL_TO_GRAIN[single.k];
  if (!grain) throw new UrlStateError(`unknown grain token '${single.k}'`);
  const grouping = URL_TO_GROUPING[single.g];
  if (!grouping) throw new UrlStateError(`unknown grouping token '${single.g}'`);

  const colon = single.t.indexOf(":");
  if (colon === -1 || single.t.indexOf(":", colon + 1) !== -1) {
    throw new UrlStateError(`malformed time range '${single.t}', expected 'YYYY-MM:YYYY-MM'`);
  }
  const timeFrom = single.t.slice(0, colon);
  const timeTo = single.t.slice(colon + 1);
  if (!MONTH_RE.test(timeFrom) || !MONTH_RE.test(timeTo)) {
    throw new UrlStateError(`malformed time range '${single.t}', expected 'YYYY-MM:YYYY-MM'`);
  }

  if (!/^\d+$/.test(single.n)) throw new UrlStateError(`limit must be a positive integer, got '${single.n}'`);
  const limit = Number(single.n);

  let sort: string | null = null;
  let sortDesc = true;
  if ("s" in single) {
    sortDesc = single.s.startsWith("-");
    sort = sortDesc ? single.s.slice(1) : single.s;
    if (!sort) throw new UrlStateError("malformed sort key");
  }

  const q = normalizeQuery({
    grain,
    dimensions: single.d.split(","),
    measures: single.m.split(","),
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
