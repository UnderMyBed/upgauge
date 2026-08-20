#!/usr/bin/env bash
# The promote hop (D5). A human points :deploy at a digest; this notices and applies it.
#
# The box takes no inbound traffic, so a push-style deploy would need an ingress this design
# refuses. Polling an outbound registry read is what lets "no inbound ports" and "a human
# decides when" both hold.
set -euo pipefail
cd /srv/upgauge
# `set -a` is load-bearing, not tidiness. deploy.env holds BARE assignments
# (`TUNNEL_TOKEN=...`), so plain sourcing makes them shell variables -- visible to `echo` here
# and invisible to every child process. `docker compose` interpolates `${TUNNEL_TOKEN:?}` from
# its OWN environment, so without this the very first compose call below dies with "required
# variable TUNNEL_TOKEN is missing a value", `set -e` kills the unit, and the timer repeats
# that every 30s forever while the site stays down and the tunnel never connects.
# shellcheck disable=SC1091
set -a
[ -f /etc/upgauge/deploy.env ] && . /etc/upgauge/deploy.env
set +a

TAG=ghcr.io/undermybed/upguage:deploy

before=$(docker image inspect --format '{{.Id}}' "$TAG" 2>/dev/null || echo none)
docker compose pull --quiet app
after=$(docker image inspect --format '{{.Id}}' "$TAG" 2>/dev/null || echo none)

if [ "$before" != "$after" ]; then
  logger -t upgauge-deploy "image moved ${before} -> ${after}; applying"
fi

# Runs every tick, not only on change: this is also the reconciler. A box that rebooted, or
# whose container died in a way `restart: unless-stopped` did not cover, converges here
# without anyone noticing it drifted. `--wait` gates on the container's own HEALTHCHECK, so
# a container that starts and fails its probe never counts as deployed.
docker compose up -d --wait
