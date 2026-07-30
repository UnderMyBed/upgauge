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
};

export default nextConfig;
