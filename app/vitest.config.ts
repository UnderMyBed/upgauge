import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
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
