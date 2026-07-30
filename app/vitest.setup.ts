// Belt-and-braces alongside db.ts's `file_search_path` fix: DuckDB no longer depends on
// process.cwd() to resolve the catalog's relative Parquet paths (see db.ts's header
// comment), but chdir-ing the test process to the repo root is still harmless and keeps any
// other repo-root-relative assumption (present or future) correct under `npm --prefix app
// test`, which starts Node with cwd already inside app/ rather than the repo root.
//
// Safe here specifically because Vitest 4's default pool is "forks" (worker *processes*,
// not worker *threads*) -- process.chdir() throws ERR_WORKER_UNSUPPORTED_OPERATION inside a
// Node `worker_threads` thread, which is exactly why db.ts does not do this chdir itself.
if (process.env.UPGAUGE_ROOT) {
  process.chdir(process.env.UPGAUGE_ROOT);
}
