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
};

export default nextConfig;
