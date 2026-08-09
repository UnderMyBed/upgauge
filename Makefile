.DEFAULT_GOAL := help
.PHONY: help install fetch fetch-reference normalize warehouse verify ingest build goldens stats gate-counts check-gate-counts basemap dev app-check app-build app-smoke test lint lint-actions fmt check check-docs clean

# Every runtime comes from mise (mise.toml pins python, node and uv). Going through
# `mise exec` means the documented commands work in a shell that has NOT run
# `mise activate` -- including a fresh clone, a cron, and this repo's own tooling.
# Set MISE= to bypass when the tools are already on PATH, e.g. inside the Docker image.
MISE ?= mise exec --
UV ?= $(MISE) uv
NPM ?= $(MISE) npm --prefix app

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install:  ## Install the pinned runtimes (mise) + the pipeline deps
	mise install
	$(UV) sync --extra dev

fetch:  ## Fetch BTS T-100 zips -> data/raw/ (skips cached years)
	$(UV) run python -m pipeline.fetch $(ARGS)

fetch-reference:  ## Fetch the BTS support tables -> data/raw/
	$(UV) run python -m pipeline.lookups $(ARGS)

normalize:  ## Raw zips -> data/parquet/t100_segment/year=YYYY/
	$(UV) run python -m pipeline.normalize $(ARGS)

warehouse:  ## Build facts + all dims from data/raw/ -> data/parquet/
	$(UV) run python -m pipeline.build $(ARGS)

verify:  ## M2 GATE: build twice, prove every Parquet artifact AND database object is byte-identical; also proves the basemap regenerates byte-identically (M7 Task 7)
	$(UV) run python -m pipeline.build --verify
	$(MAKE) basemap
	git diff --exit-code --stat app/src/lib/map/basemapPaths.generated.ts

# A plain `fetch` + `fetch-reference` is NOT enough to pick up a new BTS month, and this was a
# permanent silent no-op in the monthly publisher before anyone traced it.
#
#   * fetch.py's cache is keyed by (table, YEAR) -- `latest_raw(raw_dir, table, year)`. A new BTS
#     month lands INSIDE an already-downloaded year's zip: t100d_segment_us_2026_*.zip already
#     holds 2026-01..2026-04, so when BTS publishes 2026-05 the cache still finds a 2026 file,
#     logs "cached", and skips. `make ingest` over a populated data/raw/ therefore rebuilds the
#     SAME warehouse forever, and nothing errors.
#   * BTS also revises months that are already closed -- its own release page carries lines like
#     "10/2025 - 3/2026 updated" next to each new month -- so the current year alone is not the
#     mutable set. The current AND previous year are re-downloaded unconditionally.
#   * Support tables carry no year at all, so ONE cached file suppresses their fetch forever.
#     An aircraft-type RENAME (the class-3 change .github/scripts/classify_warehouse.py exists
#     to catch) is invisible without --force. Three small files; always re-pull them.
#
# 2015..(current-2) still short-circuit on the cache. That is what keeps this polite toward a
# .gov endpoint -- 2 year-pulls instead of 12 -- while making a new month actually reachable.
# --force appends a NEW date-stamped file rather than overwriting (data/raw/ is append-only),
# so the previous download that produced published numbers survives.
#
# The first pass is bounded at (current-2) and that bound is load-bearing, not tidiness. Without
# it, a FRESH clone fetches all 12 years on line 1 and the forced pass immediately re-fetches the
# newest 2 -- same day, same filename, so the second write overwrites the first. Two redundant
# POSTs against a .gov endpoint on the first-ever publisher run, which is precisely what the
# paragraph above claims not to do. Bounded, the two passes partition the window: 10 + 2 = 12.
#
# ARGS is REJECTED rather than composed. Composing would put `$(ARGS)` ahead of the forced flags
# so ours win on conflict -- which silently discards a caller's own `--start`/`--end` and lands
# right back at half-honored, the defect this guard exists to remove. `--raw-dir` is the only
# genuinely useful override and it is one `make fetch` away.
#
# At a year boundary this goes RED and stays red: on 2027-01-02 the forced pass asks BTS for
# 2027, which it will not serve until ~April. That is unchanged from before the bound (line 1
# asked for 2027 too) and it is DELIBERATE -- tolerating a fetch failure is exactly how the
# publisher was silently frozen at 2026-04 in the first place. A loud daily failure is the
# correct signal; only its duration is unfortunate, and shortening it means teaching fetch to
# tell "BTS has not published this year yet" from "the fetch broke", which is its own change.
ingest:  ## Fetch + build everything. The full M1 pipeline.
	@if [ -n "$(strip $(ARGS))" ]; then \
	  echo "  FAIL  make ingest does not accept ARGS (got: $(ARGS))."; \
	  echo "        Two of its four steps must override ARGS to force a refetch, so a"; \
	  echo "        caller's flags would apply to some steps and not others."; \
	  echo "        Call the step you meant directly:"; \
	  echo "          make fetch ARGS=\"$(ARGS)\""; \
	  echo "          make fetch-reference ARGS=\"$(ARGS)\""; \
	  echo "          make warehouse ARGS=\"$(ARGS)\""; \
	  exit 1; \
	fi
	$(MAKE) fetch ARGS="--end $$(( $$(date -u +%Y) - 2 ))"
	$(MAKE) fetch ARGS="--start $$(( $$(date -u +%Y) - 1 )) --force"
	$(MAKE) fetch-reference ARGS="--force"
	$(MAKE) warehouse

build:  ## Run sql/02_marts/ in order -> upgauge.duckdb
	$(UV) run python -m pipeline.marts $(ARGS)

goldens:  ## Regenerate the Explorer contract fixtures from the reference implementation
	$(UV) run python -m pipeline.pivot --write-goldens

stats:  ## Regenerate the reference-values artifact (pipeline/reference/stats.generated.json)
	$(UV) run python -m pipeline.stats --write

gate-counts:  ## Regenerate the gate-counts artifact (pipeline/reference/gates.generated.json)
	$(UV) run python -m pipeline.gatecounts --write

# Deliberately NOT folded into the `data-contract` job's `make stats` diff. The two reds must
# stay distinguishable: a stats diff means the upstream BTS dataset moved; a gate-counts diff
# means someone added a test and did not regenerate. Merging them would make the message
# CLAUDE.md gives for a red data-contract ("the upstream dataset no longer matches this commit's
# reference values") wrong half the time.
#
# The tracked-file check is not defensive padding. `git diff` reports NOTHING for an untracked
# file, so before the artifact was committed this target printed `ok` for every possible count --
# including with a brand-new test added and with the committed number hand-edited to 999. Both
# mutants passed. A generated-artifact gate whose artifact is not tracked is not a gate.
check-gate-counts:  ## Fail if the committed gate counts no longer match the suite
	@git ls-files --error-unmatch pipeline/reference/gates.generated.json >/dev/null 2>&1 \
	  || { echo "  FAIL pipeline/reference/gates.generated.json is not tracked by git."; \
	       echo "       \`git diff\` reports NOTHING for an untracked file, so this gate would"; \
	       echo "       print ok for every possible count. Commit the artifact."; exit 1; }
	@$(MAKE) --no-print-directory gate-counts >/dev/null
	@git diff --exit-code --stat pipeline/reference/gates.generated.json \
	  || { echo "  FAIL gate counts moved. Run \`make gate-counts\` and commit the result"; \
	       echo "       in the SAME commit as the test that moved it."; exit 1; }
	@echo "  gate counts match ... ok"

basemap:  ## Regenerate the pre-projected basemap (app/src/lib/map/basemapPaths.generated.ts) from the two committed inputs, app/geo/ne_110m_us.json and app/geo/ne_50m_car.json
	$(MISE) node --no-warnings app/scripts/build-basemap.mjs

dev:  ## Next.js dev server
	# `next dev app` from the REPO ROOT, not `npm --prefix app run dev`. The --prefix form
	# starts Node with cwd=app/, and db.ts anchors DB_PATH and QUERIES_DIR on process.cwd()
	# per the WORKDIR contract (docs/architecture/hosting.md) -- so every route 500s with
	# `Cannot open database ".../app/upgauge.duckdb"`. Passing the app directory as an
	# ARGUMENT leaves cwd at the repo root, which is exactly what production does
	# (`next start app`, see app/smoke.sh) and what the Docker image's WORKDIR is.
	$(MISE) npx next dev app

app-check:  ## Typecheck + lint + test the app
	$(NPM) run typecheck
	$(NPM) run lint
	$(NPM) test

app-build:  ## Production build
	$(NPM) run build

app-smoke:  ## Build, serve, and curl real URLs. Catches production-only bugs no unit test can.
	./app/smoke.sh

test:  ## Run the pipeline test suite
	$(UV) run pytest

lint:  ## Lint (ruff)
	$(UV) run ruff check .

# The Actions EXPRESSION layer sits above YAML. An empty `${{ }}` in a bash comment inside a
# `run:` block made warehouse.yml unparseable on main while staying valid YAML, and every check
# applied before that merge was a YAML check.
#
# Scope is workflows ONLY, deliberately: actionlint 1.7.12 parses a composite action as a
# workflow and reports `"jobs" section is missing` for `.github/actions/setup/action.yml`.
# Measured: with the empty-expression defect injected into that composite, actionlint exits 0.
# `pipeline/tests/test_workflow_expressions.py` is what covers composites, and it runs in
# `test` below -- do not "fix" this target by pointing actionlint at action.yml.
lint-actions:  ## Lint GitHub Actions workflows (expressions, `needs:`, `uses:` inputs, shellcheck)
	mise exec -- actionlint

fmt:  ## Format (ruff)
	$(UV) run ruff format .

# CLAUDE.md is loaded into context every session, so its size is a running cost paid on every
# request -- not a tidiness preference. It reached 909 lines before anyone measured it, of which
# 596 (66.7%) were milestone narrative duplicated in docs/architecture/pipeline.md. Milestone
# closeouts were adding ~110 lines each (M5 +120, M6 +111, M7 +113) and nothing was ever removed.
#
# The budget is a BACKSTOP for the rule in CLAUDE.md § Working agreements, not the rule itself:
# a closeout may add a RULE, never narrative or measurements. A budget alone would just pressure
# someone into deleting a load-bearing rule to stay under the number.
#
# Raising it is allowed and is a deliberate act -- change the number here and say why in the
# commit message. What is not allowed is the number drifting upward unremarked.
#
# 475 is derived, not round: the file is 443 after the M7-era compaction, and a rule costs
# 8-15 lines, so this is headroom for about three more before a prune is forced. A budget of
# 450 was tried first and left 7 lines -- it would have failed on the very next rule, which
# makes the gate noise instead of signal. Set it close enough to bite, far enough to mean
# something when it does.
CLAUDE_MD_BUDGET ?= 475

check-docs:  ## Enforce the CLAUDE.md line budget (see CLAUDE.md § Working agreements)
	@n=$$(wc -l < CLAUDE.md); \
	if [ "$$n" -gt "$(CLAUDE_MD_BUDGET)" ]; then \
	  echo "  FAIL CLAUDE.md is $$n lines, budget $(CLAUDE_MD_BUDGET)."; \
	  echo "       A closeout may add a RULE, not narrative or measurements."; \
	  echo "       Narrative -> the commit message. Measurements -> generated output."; \
	  echo "       Remove something, or raise CLAUDE_MD_BUDGET in the Makefile and say why."; \
	  exit 1; \
	fi; \
	echo "  CLAUDE.md is $$n lines (budget $(CLAUDE_MD_BUDGET)) ... ok"

check: lint lint-actions check-docs check-gate-counts test  ## Lint + test. Run this before every commit.

clean:  ## Remove build artifacts and caches (NOT data/raw — that's the audit trail)
	rm -rf .pytest_cache .ruff_cache **/__pycache__ *.egg-info
	rm -f upgauge.duckdb upgauge.duckdb.wal
