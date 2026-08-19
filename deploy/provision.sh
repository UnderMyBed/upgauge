#!/usr/bin/env bash
# Rebuilding the box is one command against a committed file (D8). Safe to re-run: the
# server is created only if absent; the firewall is attached to it UNCONDITIONALLY on every
# run, on a path that does not depend on whether the server was just created or already
# existed -- see the attach step below for why that distinction matters.
set -euo pipefail

# Operator credentials come from deploy/.env when they are not already exported.
# shellcheck source=load-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/load-env.sh"

: "${TUNNEL_TOKEN:?export TUNNEL_TOKEN -- the credential from the Cloudflare tunnel}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${UPGAUGE_SERVER_NAME:-upgauge}"
TYPE=cx23
LOCATION=nbg1
IMAGE="${UPGAUGE_OS_IMAGE:-debian-13}"

# Render cloud-init from the sibling files so each unit exists in exactly one place.
USERDATA=$(mktemp)
trap 'rm -f "$USERDATA"' EXIT
mise exec -- python - "$HERE" "$USERDATA" <<'PY'
import os, pathlib, sys
here, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
INDENT = "      "  # matches cloud-init.yaml's write_files[].content block-scalar indent
lines = (here / "cloud-init.yaml").read_text().split("\n")
for marker, name in [
    ("__COMPOSE__", "compose.yml"),
    ("__DEPLOY_SH__", "upgauge-deploy.sh"),
    ("__SERVICE__", "upgauge-deploy.service"),
    ("__TIMER__", "upgauge-deploy.timer"),
]:
    # Replace the placeholder as a whole LINE, never a bare substring. cloud-init.yaml's own
    # header comment names all four markers in one sentence to document them, so a plain
    # `tpl.replace(marker, ...)` matches that sentence too -- splicing a whole file's content
    # into the header and leaving invalid YAML with no error anywhere in this pipeline. The
    # assert makes a future second match (in either place) fail loudly here instead of
    # rendering silently wrong on the box.
    target = INDENT + marker
    hits = [i for i, ln in enumerate(lines) if ln == target]
    assert len(hits) == 1, (
        f"expected exactly one {target!r} placeholder line, found {len(hits)}"
    )
    body_lines = (here / name).read_text().split("\n")
    if body_lines and body_lines[-1] == "":
        body_lines = body_lines[:-1]  # the file's own trailing newline; YAML `|` re-adds one
    i = hits[0]
    lines[i:i + 1] = [INDENT + bl for bl in body_lines]
tpl = "\n".join(lines).replace("${TUNNEL_TOKEN}", os.environ["TUNNEL_TOKEN"])
out.write_text(tpl)
PY

# The firewall denies all inbound. cloudflared dials out, so nothing legitimate needs an
# ingress rule -- including SSH. Break-glass is Hetzner's browser console, which needs no
# network configuration and therefore survives a mistake in this very rule.
#
# `list`, never `describe` piped to /dev/null: `describe`'s non-zero exit means EITHER "this
# does not exist" OR "the API could not answer", and folding both into one
# `if ! describe >/dev/null 2>&1; then create; fi` risks creating a duplicate on a transient
# outage -- and for the firewall specifically, risks treating an outage as "already exists"
# and silently never attaching it. `list` keeps the two questions separate the same way
# freshness.yml's `gh release list` does: a non-zero exit is ONLY "the API did not answer" (a
# failed listing is an outage, never an empty answer), and a zero exit's content -- possibly
# empty, which is a legitimate "does not exist yet" -- is the only thing that says whether the
# name is present. stderr is never redirected to /dev/null here, so a transient failure is
# visible on the terminal, not silently swallowed.
firewalls=$(hcloud firewall list -o noheader -o columns=name) || {
  echo "  FAIL could not list firewalls -- the Hetzner API did not answer. Refusing to guess" >&2
  echo "       whether upgauge-deny-inbound exists rather than risk creating a duplicate." >&2
  exit 1
}
if printf '%s\n' "$firewalls" | grep -qx upgauge-deny-inbound; then
  echo "  firewall upgauge-deny-inbound already exists; not recreating"
else
  hcloud firewall create --name upgauge-deny-inbound
fi

servers=$(hcloud server list -o noheader -o columns=name) || {
  echo "  FAIL could not list servers -- the Hetzner API did not answer. Refusing to guess" >&2
  echo "       whether $NAME exists rather than risk creating a duplicate box." >&2
  exit 1
}
if printf '%s\n' "$servers" | grep -qx "$NAME"; then
  echo "  server $NAME already exists; not recreating"
else
  # An IPv4 is REQUIRED, not a convenience: ghcr.io publishes no AAAA record and
  # Hetzner's resolvers do not synthesize one -- there is no DNS64/NAT64. Measured on
  # an IPv6-only cx23 in nbg1: `curl -6 https://ghcr.io/v2/` fails to resolve, so the
  # image can never be pulled. Costs ~$0.60/mo on top of the server.
  hcloud server create \
    --name "$NAME" \
    --type "$TYPE" \
    --location "$LOCATION" \
    --image "$IMAGE" \
    --firewall upgauge-deny-inbound \
    --user-data-from-file "$USERDATA"
  echo "  server $NAME created"
fi

# Attach the firewall UNCONDITIONALLY, every run, on a path that runs regardless of which
# branch above fired. The previous version passed `--firewall` to `server create` ONLY, so a
# re-run against an already-existing box never re-attached anything -- and the box carries a
# public IPv6 address with Debian's sshd listening by default, so "not attached" means SSH
# reachable from the internet. That falsifies "no inbound ports on the box, ever" (D4) and the
# exact property D8 relies on to justify a committed script over Terraform: that re-applying
# RE-ASSERTS desired state, not just the parts that differ between "just created" and
# "already existed". Also covers the just-created path (belt and suspenders with the
# `--firewall` flag above, which minimises the exposure window between create and attach); if
# `server create` already attached it, this call is a documented no-op, not a duplicate.
if apply_out=$(hcloud firewall apply-to-resource --type server --server "$NAME" upgauge-deny-inbound 2>&1); then
  echo "$apply_out"
elif printf '%s' "$apply_out" | grep -q firewall_already_applied; then
  # Hetzner's own stable API error code for "it's already exactly what you asked for" --
  # https://github.com/hetznercloud/hcloud-go's ErrorCodeFirewallAlreadyApplied. This IS the
  # idempotent success case, not a retry target. Matched on the machine-readable code, not
  # free-text, so a CLI wording change can't silently turn this back into a swallowed failure.
  echo "  firewall upgauge-deny-inbound already attached to $NAME"
else
  echo "$apply_out" >&2
  echo "  FAIL could not attach upgauge-deny-inbound to $NAME" >&2
  exit 1
fi

# Plain describe, never `-o format='{{...}}'`. Those are Go-template paths into hcloud's
# own structs and they move: `.Datacenter.Location.Name` was valid until Hetzner removed
# datacenters on 2026-07-01, after which this line failed AFTER the box was already
# created -- reporting a good provision as a red one, which is the direction an operator
# cannot safely act on.
hcloud server describe "$NAME"
