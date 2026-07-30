import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Component tests (React + DOM assertions) need jsdom; everything else -- notably
    // db.test.ts, which opens the real upgauge.duckdb file -- must stay on "node". A global
    // `environment: "jsdom"` would make db.test.ts run inside a fake DOM global for no
    // reason and risks breaking native bindings. Vitest 3's `environmentMatchGlobs` config
    // option was removed in Vitest 4 (not present in this version's InlineConfig type at
    // all), so the per-file environment is selected with a `// @vitest-environment jsdom`
    // docblock at the top of each component test file instead; this default stays "node".
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // `npm --prefix app test` starts Node already inside app/, not the repo root npm was
    // invoked from -- so render.ts's QUERIES_DIR (process.env.UPGAUGE_ROOT ?? process.cwd())
    // needs this to find sql/03_queries. Production never sets UPGAUGE_ROOT and relies on
    // cwd() being the repo root per docs/architecture/hosting.md.
    env: { UPGAUGE_ROOT: path.resolve(__dirname, "..") },
    // db.ts itself no longer needs cwd to be the repo root (it passes DuckDB's own
    // file_search_path instead), but this keeps the test process's actual cwd consistent
    // with production's contract anyway -- see vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
