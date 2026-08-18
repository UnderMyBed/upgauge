#!/usr/bin/env bash
# Rebuilding the box is one command against a committed file (D8). Safe to re-run: the
# server is created only if absent, and the firewall is applied either way.
set -euo pipefail

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
if ! hcloud firewall describe upgauge-deny-inbound >/dev/null 2>&1; then
  hcloud firewall create --name upgauge-deny-inbound
fi

if hcloud server describe "$NAME" >/dev/null 2>&1; then
  echo "  server $NAME already exists; not recreating"
else
  hcloud server create \
    --name "$NAME" \
    --type "$TYPE" \
    --location "$LOCATION" \
    --image "$IMAGE" \
    --without-ipv4 \
    --firewall upgauge-deny-inbound \
    --user-data-from-file "$USERDATA"
  echo "  server $NAME created"
fi

hcloud server describe "$NAME" -o format='{{.Name}} {{.ServerType.Name}} {{.Datacenter.Location.Name}} {{.PublicNet.IPv6.IP}}'
