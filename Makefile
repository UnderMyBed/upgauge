.DEFAULT_GOAL := help
.PHONY: help install ingest build dev test lint fmt check clean

UV ?= uv

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install:  ## Create the venv and install pipeline deps (Python 3.12)
	$(UV) sync --extra dev

fetch:  ## Fetch BTS T-100 zips -> data/raw/ (skips cached years)
	$(UV) run python -m pipeline.fetch $(ARGS)

fetch-reference:  ## Fetch the BTS support tables -> data/raw/
	$(UV) run python -m pipeline.lookups $(ARGS)

normalize:  ## Raw zips -> data/parquet/t100_segment/year=YYYY/
	$(UV) run python -m pipeline.normalize $(ARGS)

warehouse:  ## Build facts + all dims from data/raw/ -> data/parquet/
	$(UV) run python -m pipeline.build $(ARGS)

verify:  ## M1 GATE: build twice, prove every artifact is byte-identical
	$(UV) run python -m pipeline.build --verify

ingest: fetch fetch-reference warehouse  ## Fetch + build everything. The full M1 pipeline.

build:  ## Run sql/02_marts/ in order -> upgauge.duckdb
	$(UV) run python -m pipeline.marts $(ARGS)

dev:  ## Next.js dev server                                 [M3, needs node]
	@echo "not implemented — M3"
	@exit 1

test:  ## Run the pipeline test suite
	$(UV) run pytest

lint:  ## Lint (ruff)
	$(UV) run ruff check .

fmt:  ## Format (ruff)
	$(UV) run ruff format .

check: lint test  ## Lint + test. Run this before every commit.

clean:  ## Remove build artifacts and caches (NOT data/raw — that's the audit trail)
	rm -rf .pytest_cache .ruff_cache **/__pycache__ *.egg-info
	rm -f upguage.duckdb upguage.duckdb.wal
