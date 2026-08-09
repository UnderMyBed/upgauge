# syntax=docker/dockerfile:1

# The single Next.js deployable. Layout mirrors the repo so hosting.md's WORKDIR contract holds
# by construction: WORKDIR is the directory containing data/ and sql/, and UPGAUGE_ROOT and
# UPGAUGE_DB stay UNSET in production because their defaults are then already correct.
#
# No `output: "standalone"`. sql/03_queries/*.sql is read with readFileSync at request time and
# is invisible to the module tracer, so standalone would build and start cleanly and then ENOENT
# every query -- hosting.md § "If the Dockerfile ever adopts output: standalone".
ARG NODE_VERSION=24.19.0

# --------------------------------------------------------------------- warehouse
# The image's data comes from the published release asset, the same producer CI restores, so
# there is one producer for CI, the image and the portability test.
FROM node:${NODE_VERSION}-slim AS warehouse
ARG WAREHOUSE_TAG
ARG WAREHOUSE_REPO=UnderMyBed/upguage
WORKDIR /w
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl zstd \
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
ARG WAREHOUSE_TAG
ARG BUILD_SHA=dev
ENV NODE_ENV=production \
    UPGAUGE_WAREHOUSE_TAG=${WAREHOUSE_TAG} \
    UPGAUGE_BUILD_SHA=${BUILD_SHA}
WORKDIR /srv/upgauge
COPY app/package.json app/package-lock.json ./app/
RUN npm --prefix app ci --omit=dev && npm cache clean --force
COPY app/next.config.ts ./app/
COPY --from=build /build/app/.next ./app/.next
COPY sql ./sql
COPY --from=warehouse /w/upgauge.duckdb ./upgauge.duckdb
COPY --from=warehouse /w/data/parquet ./data/parquet
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
