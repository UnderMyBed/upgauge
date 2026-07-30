.DEFAULT_GOAL := help
.PHONY: help install ingest build goldens dev app-check app-build test lint fmt check clean

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

verify:  ## M2 GATE: build twice, prove every Parquet artifact AND database object is byte-identical
	$(UV) run python -m pipeline.build --verify

ingest: fetch fetch-reference warehouse  ## Fetch + build everything. The full M1 pipeline.

build:  ## Run sql/02_marts/ in order -> upgauge.duckdb
	$(UV) run python -m pipeline.marts $(ARGS)

goldens:  ## Regenerate the Explorer contract fixtures from the reference implementation
	$(UV) run python -m pipeline.pivot --write-goldens

dev:  ## Next.js dev server
	$(NPM) run dev

app-check:  ## Typecheck + test the app
	$(NPM) run typecheck
	$(NPM) test

app-build:  ## Production build
	$(NPM) run build

test:  ## Run the pipeline test suite
	$(UV) run pytest

lint:  ## Lint (ruff)
	$(UV) run ruff check .

fmt:  ## Format (ruff)
	$(UV) run ruff format .

check: lint test  ## Lint + test. Run this before every commit.

clean:  ## Remove build artifacts and caches (NOT data/raw — that's the audit trail)
	rm -rf .pytest_cache .ruff_cache **/__pycache__ *.egg-info
	rm -f upgauge.duckdb upgauge.duckdb.wal
