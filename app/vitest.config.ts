import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Vitest chdirs to app/ (its own config root), not the repo root npm was invoked from --
    // so render.ts's QUERIES_DIR (process.env.UPGAUGE_ROOT ?? process.cwd()) needs this to
    // find sql/03_queries. Production never sets UPGAUGE_ROOT and relies on cwd() being the
    // repo root per docs/architecture/hosting.md.
    env: { UPGAUGE_ROOT: path.resolve(__dirname, "..") },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
