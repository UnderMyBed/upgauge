/** The request header `proxy.ts` uses to hand the page the RAW, still-percent-encoded query
 * string. Next decodes `searchParams` before a page sees it -- parse-url.js builds `query`
 * via `searchParamsToUrlQuery(parsedURL.searchParams)`, i.e. URLSearchParams semantics -- and
 * this format's filter values can legally contain the delimiters `,` `:` `&` `=` that the
 * decoded form is no longer distinguishable from (docs/product/features.md). Reconstructing a
 * query string from the decoded object is lossy in a way no amount of re-encoding can undo:
 * a `,` that was inside a value is, by then, indistinguishable from a `,` that separated two.
 *
 * `/api/pivot` never had this problem -- it reads `new URL(request.url).search` directly.
 * This header is how `/explore` gets the same raw string. */
export const RAW_QUERY_HEADER = "x-upgauge-raw-query";

/** Thrown when the header is absent, which means `proxy.ts` did not run for this request.
 * Deliberately NOT a silent fall back to rebuilding the string from `searchParams`: this
 * page's entire contract is that a permalink means exactly one query, and a fallback that is
 * exact for most inputs and quietly wrong for the rest is the failure mode this project
 * refuses everywhere else ("the cron must fail loudly"; an invalid permalink renders a named
 * error rather than a default view). See docs/architecture/hosting.md for the deploy
 * requirement this enforces. */
export class MissingRawQueryError extends Error {
  constructor() {
    super(
      `request header '${RAW_QUERY_HEADER}' is absent -- proxy.ts did not run for this ` +
        "request. This route cannot read a permalink without the raw query string, and will " +
        "not guess one from the decoded searchParams. Check that app/src/proxy.ts is " +
        "deployed and that its matcher covers this route.",
    );
    this.name = "MissingRawQueryError";
  }
}

/** Pure so it can be tested against a real `Headers` object rather than a mocked `headers()`.
 * An empty query string is legitimate (`/explore` with no params) and must be distinguished
 * from an absent header, so this checks for null rather than falsiness. */
export function rawQueryFromHeaders(headers: { get(name: string): string | null }): string {
  const raw = headers.get(RAW_QUERY_HEADER);
  if (raw === null) throw new MissingRawQueryError();
  return raw;
}
