# syntax=docker/dockerfile:1

# The single Next.js deployable. Layout mirrors the repo so hosting.md's WORKDIR contract holds
# by construction: WORKDIR is the directory containing data/ and sql/, and UPGAUGE_ROOT and
# UPGAUGE_DB stay UNSET in production because their defaults are then already correct.
#
# No `output: "standalone"`. sql/03_queries/*.sql is read with readFileSync at request time and
# is invisible to the module tracer, so standalone would build and start cleanly and then ENOENT
# every query -- hosting.md § "If the Dockerfile ever adopts output: standalone".
# TAG-PINNED, NOT DIGEST-PINNED, and that is a deliberate trade with a consequence: Debian
# security rebuilds re-push `node:24.19.0-slim` under the same tag, so two `make image` runs from
# an identical tree can produce different images, and every layer/size figure measured for this
# image (docs/architecture/hosting.md § The Dockerfile) is only valid for the base that was current
# when it was measured. That is the opposite of the reproducibility argument the Makefile makes for
# WAREHOUSE_TAG six lines from here, and it is knowingly accepted: a digest pin freezes out those
# same security rebuilds until someone bumps the digest by hand. Keep this version equal to
# `mise.toml`'s `node` (24.19.0 today) so the container runs the Node the gates ran against. Do not
# "fix" the tag-vs-digest inconsistency without deciding the patching question first.
ARG NODE_VERSION=24.19.0
# The `warehouse` stage below rebuilds the marts, so it needs the same Python toolchain `make
# build` runs under everywhere else. Both are a second statement of a `mise.toml` pin, exactly as
# NODE_VERSION is, and all three are asserted equal to it by
# `pipeline/tests/test_mart_rebuild.py` -- the Dockerfile comment above and
# image-contract.yml's `mise.toml` path entry both claimed that equality for NODE_VERSION with
# nothing testing it. An image that builds its marts on a different DuckDB than the gates ran
# under proves one thing in CI and serves another.
ARG PYTHON_VERSION=3.12.12
ARG UV_VERSION=0.12.0

# --------------------------------------------------------------------- uv
# The uv binary alone, by its own pinned tag -- the pattern uv documents for containers. Not
# `pip install uv` (there is no Python in node:*-slim to pip with) and not a curl-pipe-to-shell.
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uvbin

# --------------------------------------------------------------------- warehouse
# The image's data comes from the published release asset, the same producer CI restores, so
# there is one producer for CI, the image and the portability test.
FROM node:${NODE_VERSION}-slim AS warehouse
ARG WAREHOUSE_TAG
ARG WAREHOUSE_REPO=UnderMyBed/upguage
WORKDIR /w
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl zstd make \
 && rm -rf /var/lib/apt/lists/*
RUN test -n "${WAREHOUSE_TAG}" \
 || { echo "FAIL: --build-arg WAREHOUSE_TAG is required (e.g. warehouse-2026.04)"; exit 1; }
RUN curl -fsSL --retry 3 -o w.tar.zst \
      "https://github.com/${WAREHOUSE_REPO}/releases/download/${WAREHOUSE_TAG}/${WAREHOUSE_TAG}.tar.zst" \
 && tar --zstd -xf w.tar.zst \
 && rm w.tar.zst
# The tarball's MEMBER PATHS are the WORKDIR contract: warehouse.yml packs it as
# `tar --zstd -cf … upgauge.duckdb data/parquet` from the repo root, so a correct extraction IS
# the layout. Assert it here so a future change to that packing step fails the image build
# instead of the first query in production.
RUN test -f upgauge.duckdb || { echo "FAIL: upgauge.duckdb not at the tarball root"; exit 1; }
RUN test -d data/parquet  || { echo "FAIL: data/parquet not at the tarball root"; exit 1; }
# data/raw is 156 MB of audit trail and ships as its OWN release asset. If it ever appears here,
# the wrong asset was fetched.
RUN test ! -e data/raw || { echo "FAIL: data/raw is in the warehouse asset"; exit 1; }

# ---- and then REBUILD the marts from THIS COMMIT's sql/, because they are not the asset's to
# carry. `mart_route_health` and the other nine objects are a pure function of data/parquet plus
# sql/02_marts/ (pipeline/marts.py's build_database reads the existing upgauge.duckdb not at all
# -- it builds a staging file and renames over it), and sql/ ships with the code while the asset
# republishes only when BTS advances a month. Baked, a mart change could not reach production
# until then: measured, sql/'s mart SQL plus one new column raised `BinderException: Referenced
# column "t12_months_flown" not found in FROM clause!` against warehouse-2026.05. The shape that
# failure takes in a container is the worst this repo names -- every /watch/<preset> 500s under
# HTML_CACHE while /api/health reports ok, since health_catalog.sql asks that table for only
# op_airline_id and health_score.
#
# EVERYTHING BELOW IS BUILDER-ONLY. This stage is discarded; `runtime` is node:*-slim and stays
# Node-only, per CLAUDE.md ("pipeline/: CI only, never runs in prod"). No COPY in `runtime`
# names pipeline/, pyproject.toml, uv.lock or this uv binary, and
# pipeline/tests/test_mart_rebuild.py asserts that per stage rather than by grepping the file.
#
# ORDER IS DELIBERATE. The curl and tar layers above depend only on WAREHOUSE_TAG, so they stay
# ahead of every COPY here -- an edit to sql/ or pipeline/ invalidates from `COPY sql` down and
# does NOT re-download the release asset.
ARG PYTHON_VERSION
COPY --from=uvbin /uv /usr/local/bin/uv
# UV_MANAGED_PYTHON, because there is no system interpreter here at all: uv fetches the exact
# CPython mise pins rather than resolving `>=3.12,<3.13` to whatever it finds. UV_NO_SYNC and
# UV_FROZEN so the `uv run` inside `make build` neither re-locks nor re-installs -- the sync
# below is the one and only resolution, and it is uv.lock's (duckdb==1.5.5), so this image's
# marts are built by the DuckDB every gate ran against.
ENV UV_PYTHON=${PYTHON_VERSION} \
    UV_MANAGED_PYTHON=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_NO_SYNC=1 \
    UV_FROZEN=1
COPY pyproject.toml uv.lock ./
# --no-install-project: the marts need duckdb, not a built wheel of `pipeline`. `python -m`
# puts the CWD on sys.path, so /w/pipeline imports directly.
RUN uv sync --frozen --no-dev --no-install-project
COPY Makefile ./
COPY sql ./sql
COPY pipeline ./pipeline
# `make build MISE=`, never a re-spelling of the command. Makefile:8 declares that override for
# this exact case ("Set MISE= to bypass when the tools are already on PATH, e.g. inside the
# Docker image"), so there is one definition of what building the marts means rather than two
# that drift. --parquet-dir defaults to the RELATIVE `data/parquet`, which marts.py requires:
# DuckDB resolves it against the process CWD, which is this stage's /w.
RUN make build MISE=

# --------------------------------------------------------------------- deps
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
RUN npm ci

# --------------------------------------------------------------------- build
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /build
COPY --from=deps /build/app/node_modules ./app/node_modules
COPY app ./app
# Touches no data/ and no sql/ -- the build is independent of the warehouse stage, so they run
# concurrently.
RUN npm --prefix app run build

# --------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/upgauge
COPY app/package.json app/package-lock.json ./app/
RUN npm --prefix app ci --omit=dev && npm cache clean --force
COPY app/next.config.ts ./app/
COPY --from=build /build/app/.next ./app/.next
COPY sql ./sql
COPY --from=warehouse /w/upgauge.duckdb ./upgauge.duckdb
COPY --from=warehouse /w/data/parquet ./data/parquet
# LAST, and below every RUN and COPY above -- BUILD_SHA changes on every commit, and an ARG is
# consumed where its ENV sits. Declared at the top of this stage it invalidated `npm ci` and all
# five COPYs beneath it, so every commit re-installed the production deps and re-materialised the
# 96 MB data/parquet layer for a one-line identity change. Nothing below this line reads either
# value at build time; lib/health.ts reads them at request time. Measurement and the
# both-directions check: docs/architecture/hosting.md, "ARG BUILD_SHA and its ENV go LAST".
ARG WAREHOUSE_TAG
ARG BUILD_SHA=dev
ENV UPGAUGE_WAREHOUSE_TAG=${WAREHOUSE_TAG} \
    UPGAUGE_BUILD_SHA=${BUILD_SHA}
USER node
EXPOSE 3000
# node's global fetch, not curl: the runtime stage has no network CLI and needs none.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Explicit path, never npx: npx from this WORKDIR cannot resolve app/node_modules and would
# fetch next@latest from the registry at container start. Same fix as smoke.sh Task 1.
#
# RELATIVE, and that is load-bearing -- do not "tidy" it to /srv/upgauge/app/node_modules/.bin/next.
# A relative CMD cannot resolve from a wrong working directory, so `docker run -w /tmp` exits 1
# before anything listens. Absolute, the same wrong -w brings up a server that answers every
# request off a wrong cwd instead -- strictly worse, and measured: hosting.md § "The test itself"
# negatives 2 and 3 are exactly those two outcomes, and `make portability` asserts both.
CMD ["app/node_modules/.bin/next", "start", "app", "-p", "3000"]
