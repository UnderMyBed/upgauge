.DEFAULT_GOAL := help
.PHONY: help install fetch fetch-reference normalize warehouse verify ingest build goldens stats gate-counts check-gate-counts basemap card-fonts dev app-check app-build app-smoke image image-smoke portability promote provision cloudflare-apply test lint lint-actions fmt fmt-check check check-docs clean

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

basemap:  ## Regenerate the pre-projected basemap (app/src/lib/map/basemapPaths.generated.ts) from the three committed inputs: app/geo/ne_110m_us.json, app/geo/ne_50m_car.json and app/geo/ne_50m_pac.json
	$(MISE) node --no-warnings app/scripts/build-basemap.mjs

card-fonts:  ## Regenerate the OG card fonts module (app/src/lib/og/fonts.generated.ts) from the committed app/src/lib/og/fonts/*.ttf sources
	$(MISE) node --no-warnings app/scripts/build-card-fonts.mjs

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

# Pinned, not resolved from the latest release: an image whose dataset changes because someone
# rebuilt on a different day is not reproducible. Bumping this is a deliberate commit.
#
# AND IT IS A TEST FIXTURE, not only a reproducibility pin. `make image-smoke` runs app/smoke.sh's
# dataset-specific needles against THIS asset -- the chart windows, the current year's asterisked
# tick and partial-year sentence, the covered-range message (app/smoke.sh's `check_dataset` call
# sites; the values are deliberately NOT copied here, because a copy rots silently while the
# fixture moves). So when BTS publishes a new month, `make ingest && make build` moves the local
# database, those needles get re-measured, `make app-smoke` goes green -- and `make image-smoke`
# keeps building from the OLD pinned asset, so the same needles go red with no defect present.
# Whoever meets that red beside a green host gate will reach for the needles, which is the wrong
# end. BUMP THIS TAG IN THE SAME COMMIT that re-measures those needles; they are one fixture (the
# project's existing rule -- "when a renamed value was the fixture for a transform, MOVE the
# fixture" -- applied to this coupling).
#
# TWO MECHANISMS HOLD THAT TOGETHER, neither of them a human remembering. warehouse.yml's
# `bump-pin` job opens a PR moving this line when a release publishes (the pin only -- most
# needles cannot be derived without querying the warehouse). image-contract.yml then runs
# `make image-smoke` UNOVERRIDDEN on any PR touching either half, which is the only invocation
# that can see the coupling: image.yml's resolves the newest release and passes
# SMOKE_DATASET_PINNED=0. docs/architecture/hosting.md carries the full rule.
WAREHOUSE_TAG ?= warehouse-2026.05
IMAGE ?= upgauge:local

# `git describe --always --dirty`, never `git rev-parse --short HEAD`: rev-parse ignores
# uncommitted changes, so `make image` labelled a dirty tree with a clean SHA -- and image-smoke
# compared against the same expression, so identity PASSED for an image whose contents are not
# that commit, which is the one thing that gate exists to refuse. /api/health publishes this value
# as provenance (docs/architecture/hosting.md § UPGAUGE_BUILD_SHA). One variable, referenced by
# both targets: two copies of the expression could drift and fail identity for a non-reason.
# `--always` keeps it a bare SHA if no tag describes HEAD, which is the case here: this repo's
# tags are the `warehouse-YYYY.MM` release tags, they are lightweight, and describe ignores
# lightweight tags without --tags. (A count of them is not written here on purpose -- one lands
# every month.)
IMAGE_SHA := $(shell git describe --always --dirty --abbrev=7)

image:  ## Build the deployable image from the published warehouse asset
	docker build -t $(IMAGE) \
	  --build-arg WAREHOUSE_TAG=$(WAREHOUSE_TAG) \
	  --build-arg BUILD_SHA="$(IMAGE_SHA)" .

# `image` as a prerequisite, always -- a stale local tag passing every check while the source
# has moved on is a worse failure than the extra build time (docs/architecture/hosting.md's
# whole point about a gate that passes for the wrong reason). SMOKE_EXPECT_SHA/_WAREHOUSE are
# what turn "the container answers" into "this container is the build under test" -- the same
# distinction port_free_or_die draws for the port, one layer up (app/smoke.sh's own comment on
# the orphan-server incident this second guard exists alongside, not instead of).
image-smoke: image  ## Run the served-build checks against the container, identity asserted
	SMOKE_MODE=container SMOKE_IMAGE=$(IMAGE) \
	SMOKE_EXPECT_SHA="$(IMAGE_SHA)" \
	SMOKE_EXPECT_WAREHOUSE=$(WAREHOUSE_TAG) \
	./app/smoke.sh

# Ports distinct from app/smoke.sh's (3195/3196/3198/3199/3299) so a portability run and a smoke
# run can never answer each other's curls -- the same "a different server answered the check"
# failure port_free_or_die exists for, one gate over. A port already in use makes `docker run -p`
# fail loudly, which is the wanted behaviour; there is no silent fallback.
NEG1_PORT ?= 3397
NEG2_PORT ?= 3396
NEG3_PORT ?= 3395

# The portability test docs/architecture/hosting.md has specified since M2. It proves the
# WORKDIR/data-colocation contract by BREAKING it, three ways, and asserting the DISTINCT
# signature each break produces. One shared "it 500s" assertion would pass for all three and so
# prove none of them -- the failures happen at three different layers (exec, database open,
# Parquet read) and the point of the gate is that they stay distinguishable.
#
# The POSITIVE half is `make image-smoke` (the served-build checks against the real container,
# --read-only, no tmpfs). Repeating it here would double the image builds for zero new coverage.
#
# Nothing here runs --read-only, deliberately: each negative isolates exactly ONE variable (the
# data layout, or the working directory). Adding a second difference would leave a red ambiguous
# between the break under test and the read-only root, and --read-only's own proof is
# image-smoke's, where every check runs under it.
#
# Every case is ONE shell with a `trap ... EXIT`, not a sequence of recipe lines. make aborts the
# target on the first failing line, so a mid-case failure spread over several lines would leak a
# container holding a published port -- and a leaked container answering the NEXT run is exactly
# the defect app/smoke.sh's own history documents.
portability: image  ## Prove the WORKDIR/data contract by breaking it three ways
	@echo "==> negative 1: data/parquet shadowed -- the catalog still opens, every query fails"
	@trap 'docker rm -f upgauge-neg1 >/dev/null 2>&1 || true' EXIT; \
	docker rm -f upgauge-neg1 >/dev/null 2>&1 || true; \
	docker run -d --rm --name upgauge-neg1 \
	  --mount type=tmpfs,destination=/srv/upgauge/data/parquet \
	  -p 127.0.0.1:$(NEG1_PORT):3000 $(IMAGE) >/dev/null || { \
	  echo "  FAIL could not start upgauge-neg1 -- this case tested NOTHING. Most likely"; \
	  echo "       :$(NEG1_PORT) is already allocated, or the daemon is unreachable."; exit 1; }; \
	for i in $$(seq 1 60); do \
	  curl -s -o /dev/null --max-time 2 http://127.0.0.1:$(NEG1_PORT)/api/health && break; \
	  sleep 1; \
	done; \
	code=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:$(NEG1_PORT)/api/health); \
	body=$$(curl -s --max-time 10 http://127.0.0.1:$(NEG1_PORT)/api/health); \
	explore=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://127.0.0.1:$(NEG1_PORT)/explore); \
	logs=$$(docker logs upgauge-neg1 2>&1); \
	echo "    /api/health status=$$code"; \
	echo "    /api/health body=$$body"; \
	echo "    /explore    status=$$explore"; \
	fail=0; \
	[ "$$code" = "503" ] || { \
	  echo "  FAIL /api/health returned $$code, expected 503. A container whose every route"; \
	  echo "       500s must not report healthy -- Docker's HEALTHCHECK and any load balancer"; \
	  echo "       read this status line and nothing else."; fail=1; }; \
	printf '%s' "$$body" | grep -qF '"asOf":null' || { \
	  echo "  FAIL /api/health did not report asOf:null. asOf is the ONLY clause that catches"; \
	  echo "       this break (see the missing:[] assertion below), so without it the endpoint"; \
	  echo "       returns 200 for a container that cannot answer a single query."; fail=1; }; \
	printf '%s' "$$body" | grep -qF '"missing":[]' || { \
	  echo "  FAIL /api/health named missing catalog objects. The (object,column) manifest is"; \
	  echo "       BLIND to this break by construction -- duckdb_columns() answers from the"; \
	  echo "       catalog and never reads a Parquet file. If it now sees it, that is an"; \
	  echo "       improvement: update hosting.md and this assertion in the SAME commit."; \
	  echo "       Or the report grew a new field for the asOf failure and its message landed"; \
	  echo "       in missing[] rather than in data.error -- that is a regression, not an"; \
	  echo "       improvement: the two breaks (catalog unopenable vs. Parquet unreadable) stay"; \
	  echo "       distinguishable from the body alone only while they use separate fields."; fail=1; }; \
	printf '%s' "$$body" | grep -qF '"error":"IO Error' || { \
	  echo "  FAIL /api/health reported a 503 that does not NAME its cause. This is the most"; \
	  echo "       likely production break -- the data volume not mounted -- and data.error is"; \
	  echo "       what saves the operator a trip to the container logs for a message this"; \
	  echo "       endpoint already had. A bare catch{} around asOf() is what removes it."; fail=1; }; \
	case "$$explore" in 5??) ;; *) \
	  echo "  FAIL /explore returned $$explore, expected 5xx. Serving a 2xx off an unreadable"; \
	  echo "       data layer would mean a page rendering something other than the data."; fail=1;; \
	esac; \
	printf '%s' "$$logs" | grep -qF 'No files found that match the pattern' || { \
	  echo "  FAIL the documented error did not appear in the container log. This target proves"; \
	  echo "       a SPECIFIC failure; a different one means the negative case is not"; \
	  echo "       reproducing what hosting.md describes, and the gate would pass for the"; \
	  echo "       wrong reason."; fail=1; }; \
	[ $$fail -eq 0 ]
	@echo "==> negative 2: wrong WORKDIR -- the container never listens at all"
	@trap 'docker rm -f upgauge-neg2 >/dev/null 2>&1 || true' EXIT; \
	docker rm -f upgauge-neg2 >/dev/null 2>&1 || true; \
	docker run -d --name upgauge-neg2 -w /tmp \
	  -p 127.0.0.1:$(NEG2_PORT):3000 $(IMAGE) >/dev/null || { \
	  echo "  FAIL could not start upgauge-neg2 -- this case tested NOTHING. Most likely"; \
	  echo "       :$(NEG2_PORT) is already allocated, or the daemon is unreachable."; exit 1; }; \
	fail=0; rc=$$(timeout 30 docker wait upgauge-neg2); wt=$$?; \
	if [ $$wt -eq 124 ]; then \
	  echo "  FAIL upgauge-neg2 was still running 30s after start. CMD is a RELATIVE path, so a"; \
	  echo "       wrong -w must stop the process before it can listen. A server that comes up"; \
	  echo "       here would serve errors from a wrong cwd instead of refusing to start."; \
	  rc=""; fail=1; \
	elif [ $$wt -ne 0 ]; then \
	  echo "  FAIL \`docker wait upgauge-neg2\` itself failed (exit $$wt) -- the container is not"; \
	  echo "       waitable, so nothing about the start failure was observed. This is NOT the"; \
	  echo "       'still running' case; do not read it as one."; \
	  rc=""; fail=1; \
	fi; \
	logs=$$(docker logs upgauge-neg2 2>&1); \
	code=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:$(NEG2_PORT)/explore || true); \
	echo "    exit code   =$${rc:-<not observed -- see the FAIL above for which case>}"; \
	echo "    /explore    status=$$code"; \
	printf '%s\n' "$$logs" | grep -F 'Cannot find module' | head -1 | sed 's/^/    /'; \
	[ -n "$$rc" ] && [ "$$rc" != "0" ] || { \
	  echo "  FAIL expected a non-zero exit code, got '$${rc:-<none>}'."; fail=1; }; \
	printf '%s' "$$logs" | grep -qF "Cannot find module '/tmp/app/node_modules/.bin/next'" || { \
	  echo "  FAIL the documented start failure did not appear. The base image's own"; \
	  echo "       docker-entrypoint.sh cannot resolve the relative CMD from the wrong cwd and"; \
	  echo "       falls back to \`node <arg>\`, which then resolves it against that cwd. Either"; \
	  echo "       this is failing for a reason hosting.md does not describe, OR the base image's"; \
	  echo "       entrypoint script changed -- NODE_VERSION is a build ARG, so a base bump can"; \
	  echo "       land here. Re-read the failure before touching the assertion."; fail=1; }; \
	[ "$$code" = "000" ] || { \
	  echo "  FAIL something answered on :$(NEG2_PORT) (status $$code). Nothing ever listened in"; \
	  echo "       this case, so a response means a foreign server holds the port."; fail=1; }; \
	[ $$fail -eq 0 ]
	@echo "==> negative 3: wrong WORKDIR, absolute entrypoint -- it listens, and finds no database"
	@trap 'docker rm -f upgauge-neg3 >/dev/null 2>&1 || true' EXIT; \
	docker rm -f upgauge-neg3 >/dev/null 2>&1 || true; \
	docker run -d --rm --name upgauge-neg3 -w /tmp \
	  --entrypoint /srv/upgauge/app/node_modules/.bin/next \
	  -p 127.0.0.1:$(NEG3_PORT):3000 $(IMAGE) start /srv/upgauge/app -p 3000 >/dev/null || { \
	  echo "  FAIL could not start upgauge-neg3 -- this case tested NOTHING. Most likely"; \
	  echo "       :$(NEG3_PORT) is already allocated, or the daemon is unreachable."; exit 1; }; \
	for i in $$(seq 1 60); do \
	  curl -s -o /dev/null --max-time 2 http://127.0.0.1:$(NEG3_PORT)/api/health && break; \
	  sleep 1; \
	done; \
	code=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:$(NEG3_PORT)/api/health); \
	body=$$(curl -s --max-time 10 http://127.0.0.1:$(NEG3_PORT)/api/health); \
	explore=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://127.0.0.1:$(NEG3_PORT)/explore); \
	echo "    /api/health status=$$code"; \
	echo "    /api/health body=$$body"; \
	echo "    /explore    status=$$explore"; \
	fail=0; \
	[ "$$code" = "503" ] || { \
	  echo "  FAIL /api/health returned $$code, expected 503."; fail=1; }; \
	printf '%s' "$$body" | grep -qF 'Cannot open database \"/tmp/upgauge.duckdb\"' || { \
	  echo "  FAIL /api/health did not name the unopenable database. This case must fail EARLIER"; \
	  echo "       and DIFFERENTLY from negative 1 -- DuckDBInstance.create() rejects before any"; \
	  echo "       query runs, so the cause is reported through missing[] rather than asOf. One"; \
	  echo "       message covering both would mean the two breaks are indistinguishable in"; \
	  echo "       production."; fail=1; }; \
	case "$$explore" in 5??) ;; *) \
	  echo "  FAIL /explore returned $$explore, expected 5xx."; fail=1;; \
	esac; \
	[ $$fail -eq 0 ]
	@echo "  portability: all three negative cases reproduced their documented failure ... ok"

# stdlib only, so `mise exec -- python` rather than `uv run` -- this must work in a clone
# that has never run `make install`, which is the state an operator rolling back at 3am is in.
# TAG= skips the picker for exactly that case.
promote:  ## Promote a built image to :deploy (picker; TAG=... to skip it). Dispatches promote.yml and watches it
	$(MISE) python deploy/promote.py $(TAG)

provision:  ## Create or re-assert the Hetzner box from deploy/cloud-init.yaml (creds: deploy/.env, see .env.example)
	./deploy/provision.sh

cloudflare-apply:  ## PUT the committed Cloudflare desired state (creds: deploy/.env, see .env.example)
	./deploy/cloudflare-apply.sh

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

# `check` ran `ruff check` and never `ruff format --check`, so format drift accumulated on main
# invisibly: every gate stayed green while the tree drifted from what `ruff format` produces.
# Measured before this gate landed: 10 of 67 files would be reformatted, 403 diff lines, 199 of
# them in pipeline/pivot.py alone. The failure that costs is documented `make fmt` -> documented
# `make check`: the first person to follow the command table lands ten files they never touched.
#
# The two tools do not fight. The longest line `ruff format` produces is
# test_workflow_expressions.py:62 at exactly 100 characters against `line-length = 100`
# (pyproject.toml); E501 fires ABOVE 100, so a format-clean tree is also `ruff check`-clean.
fmt-check:  ## Fail if the tree is not `ruff format`-clean
	@$(UV) run ruff format --check . \
	  || { echo "  FAIL the tree is not format-clean. Run \`make fmt\` and commit the result"; \
	       echo "       in the SAME commit -- reformatting only the files your change touched"; \
	       echo "       smears this diff across every future commit instead of isolating it."; \
	       exit 1; }

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
# The number is derived, not round, and the derivation is restated whenever it moves -- a budget
# whose stated justification names a different figure than the constant is the same rot this gate
# exists to catch, and the prose is the half that rots first.
#
# It sits a LINE OR TWO above the file, not a rule above it. Headroom for a whole rule would let
# the next rule land unremarked, which is precisely the drift the gate exists to catch; two lines
# means the next one fails this target and has to raise the number in the same commit, with the
# why in the message. That makes "raising it is a deliberate act" unavoidable rather than
# optional. The gate is not there to stop the file growing -- it is there to stop it growing
# QUIETLY.
#
# 490 as of #52: the file is 488 after that issue's value-bounds rule (nine lines, replacing a
# clause that had become false -- `canonicalQuery.ts` inspects no value, but values are no longer
# unvalidated, and a shape check downstream of pyUnquote bounds no spelling). Previously 480
# against a 479-line file.
CLAUDE_MD_BUDGET ?= 501

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

check: fmt-check lint lint-actions check-docs check-gate-counts test  ## Format + lint + test. Run this before every commit.

clean:  ## Remove build artifacts and caches (NOT data/raw — that's the audit trail)
	rm -rf .pytest_cache .ruff_cache **/__pycache__ *.egg-info
	rm -f upgauge.duckdb upgauge.duckdb.wal
