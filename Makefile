.DEFAULT_GOAL := help
.PHONY: help install ingest build dev test lint fmt check clean

UV ?= uv

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install:  ## Create the venv and install pipeline deps (Python 3.12)
	$(UV) sync --extra dev

ingest:  ## Fetch BTS T-100 -> data/raw/ -> data/parquet/   [M1 phase 2/4]
	@echo "not implemented — M1 phase 2 (fetch) and phase 4 (normalize)"
	@exit 1

build:  ## Run sql/ in order -> upgauge.duckdb              [M2]
	@echo "not implemented — M2"
	@exit 1

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
