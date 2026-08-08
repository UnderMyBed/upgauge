.DEFAULT_GOAL := help
.PHONY: help install ingest build goldens basemap dev app-check app-build app-smoke test lint fmt check check-docs clean

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

ingest: fetch fetch-reference warehouse  ## Fetch + build everything. The full M1 pipeline.

build:  ## Run sql/02_marts/ in order -> upgauge.duckdb
	$(UV) run python -m pipeline.marts $(ARGS)

goldens:  ## Regenerate the Explorer contract fixtures from the reference implementation
	$(UV) run python -m pipeline.pivot --write-goldens

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

check: lint check-docs test  ## Lint + test. Run this before every commit.

clean:  ## Remove build artifacts and caches (NOT data/raw — that's the audit trail)
	rm -rf .pytest_cache .ruff_cache **/__pycache__ *.egg-info
	rm -f upgauge.duckdb upgauge.duckdb.wal
