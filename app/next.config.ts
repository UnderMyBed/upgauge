import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @duckdb/node-bindings picks its native binding with a runtime
  // `require(\`@duckdb/node-bindings-${platform}-${arch}\`)` switch (one branch per
  // platform/arch pair). Left to the default Server Components bundling, Next's bundler
  // statically resolves every branch of that switch and fails the production build on
  // whichever platform packages aren't installed for the machine actually running it (only
  // one platform's optional dependency is ever installed) -- confirmed by running
  // `next build` before this option was added: it fails on every branch except
  // linux-x64-gnu, the platform this repo builds on. Declaring both packages external
  // routes them through plain Node `require` at request time instead, which is what this
  // package already expects (docs/architecture/pipeline.md: no writes, read-only, in-process
  // DuckDB) and matches serverExternalPackages' documented purpose -- "Dependencies used
  // inside Server Components and Route Handlers ... using Node.js specific features".
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],

  // LOAD-BEARING, not an experiment (it was framed as one here until 2026-08, long after it
  // was settled). The permalink format uses literal `:` and `,` as structural delimiters with
  // data occurrences percent-encoded. Next's URL normalization form-encodes the query --
  // turning `k:a%2Cb,c` into `k%3Aa%2Cb%2Cc`, collapsing the structural and data commas into
  // the same bytes. Without this option EVERY filtered query fails on BOTH `/explore` and
  // `/api/pivot`, reserved characters or not. It is one mechanism with `src/proxy.ts`, which
  // reads the raw query from a header -- neither works without the other, and a page can never
  // use `searchParams` for this. See docs/architecture/hosting.md § What `proxy.ts` owns.
  skipProxyUrlNormalize: true,

  // A SECURITY CONTROL, not a tidy-up (#186). `/_next/image?url=<local path>` does not read a
  // file: for any path `localPatterns` admits, `fetchInternalImage` calls the server's OWN
  // request handler (node_modules/next/dist/server/image-optimizer.js --
  // `handleRequest(mocked.req, mocked.res, parseReqUrl(href))`), so the PAGE RENDERS IN FULL,
  // DuckDB reads included, and the buffer is refused for not being an image only afterwards.
  // With no `images` block at all every local path is admitted by construction --
  // shared/lib/match-local-pattern.js: "if the user didn't define localPatterns, we allow all
  // local images" -- so the endpoint rendered any page on the site.
  //
  // That is the cost class #113, #117 and #172 closed, reached through the ONE prefix the edge
  // deliberately leaves out: deploy/cloudflare/rate-limit.json excludes `/_next/` because a
  // single real page view asks for more static chunks than 1 req/s allows, and every distinct
  // `url=` is its own CDN key that misses. MEASURED on a served build 2026-09-19 with probes on
  // `proxy()` and on db.ts's `connect()`: `?url=/airport/SEA` fired two proxy invocations and
  // **24 DuckDB connections**, the same 24 a direct `GET /airport/SEA` makes; after this line,
  // one invocation and zero. The app imports `next/image` nowhere, so nothing here needs the
  // endpoint.
  //
  // `[]`, not a pattern set that "matches nothing": server/config.js APPENDS
  // `/_next/static/media/**` and `/_next/static/immutable/media/**` to whatever array it is
  // given, so static imports keep working and that append is also the residual this does not
  // close (docs/architecture/hosting.md, which carries the measurement table and why
  // `unoptimized: true` is the weaker of the two options). The refusal is `validateParams`'
  // 400 `"url" parameter is not allowed`, emitted before anything is fetched -- the status is
  // 400 either way, so app/smoke.sh § 8d asserts the BODY.
  images: { localPatterns: [] },
};

export default nextConfig;
