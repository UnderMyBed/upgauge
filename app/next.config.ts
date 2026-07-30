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

  // EXPERIMENT (see the investigation this commit records): does disabling Next's URL
  // normalization preserve the raw query string? The permalink format uses literal `:` and
  // `,` as structural delimiters with data occurrences percent-encoded, and normalization
  // form-encodes the query -- turning `k:a%2Cb,c` into `k%3Aa%2Cb%2Cc`, which collapses the
  // structural and data commas into the same bytes.
  skipProxyUrlNormalize: true,
};

export default nextConfig;
