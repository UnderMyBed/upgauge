#!/usr/bin/env bash
# Idempotent by construction: Cloudflare's ruleset entrypoint API is a PUT of the WHOLE
# ruleset, so re-applying re-asserts rather than duplicates. That is what makes the drift fix
# one command, and it is why this project does not carry Terraform for seven resources (D8).
set -euo pipefail

# Operator credentials come from deploy/.env when they are not already exported.
# shellcheck source=load-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/load-env.sh"

: "${CLOUDFLARE_API_TOKEN:?export CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ZONE_ID:?export CLOUDFLARE_ZONE_ID}"
: "${CLOUDFLARE_ACCOUNT_ID:?export CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_TUNNEL_ID:?export CLOUDFLARE_TUNNEL_ID}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API=https://api.cloudflare.com/client/v4

put() { # put <url> <file> [readback]
  local url="$1" file="$2" readback="${3:-}" out
  out=$(curl -sS -X PUT "$url" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data @"$file")
  # `success` is the only field that means it worked. A 200 with "success": false is
  # Cloudflare's normal way of rejecting a rule, and treating HTTP status as the verdict
  # would report a config that was never applied as applied.
  if [ "$(printf '%s' "$out" | jq -r .success)" != "true" ]; then
    echo "  FAIL $url"
    printf '%s\n' "$out" | jq .errors
    exit 1
  fi

  # SUCCESS IS NOT AGREEMENT. Cloudflare returns `success: true` while silently ignoring fields
  # it does not apply -- measured on this very endpoint: a PUT updated the ruleset's description
  # and rules and dropped `name` without a word about it (test_cloudflare_desired_state.py's
  # test_rate_limit_keeps_the_name_the_zone_actually_holds records that measurement). Every gate
  # in this repo constrains what we SEND; without this, nothing compares that to what the zone
  # KEPT, and the committed file could stop describing production with every test green.
  #
  # The response echoes the applied ruleset, so this costs no extra request. It compares every
  # SCALAR LEAF we sent against the same path in `.result`: fields Cloudflare adds (`id`,
  # `version`, `last_updated`, per-rule `ref`, defaulted members of `ratelimit`) are extra keys
  # and are correctly ignored, while anything we sent that came back missing or different is
  # named by its path. Re-applying is idempotent by construction (see the header), so a mismatch
  # is a stop-and-look, not a half-applied state to unpick.
  if [ -n "$readback" ]; then
    local drift
    drift=$(jq -n \
      --argjson sent "$(jq -S . "$file")" \
      --argjson got "$(printf '%s' "$out" | jq -S '.result // {}')" \
      '[ $sent | paths(scalars) as $p
         | select(($got | getpath($p)) != ($sent | getpath($p)))
         | ($p | map(tostring) | join(".")) ]')
    if [ "$(printf '%s' "$drift" | jq -r 'length')" != "0" ]; then
      echo "  FAIL $(basename "$file"): the API reported success and did not keep what it was sent." >&2
      printf '%s' "$drift" | jq -r '.[] | "       dropped or changed: \(.)"' >&2
      echo "       'name' is the field known to be ignored on a ruleset entrypoint PUT; anything" >&2
      echo "       else here means the committed file no longer describes the zone. Re-applying" >&2
      echo "       is idempotent, so fix the file and run this again." >&2
      exit 1
    fi
  fi
  echo "  ok   $(basename "$file")"
}

put "${API}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
    "${HERE}/cloudflare/cache-rules.json" readback
put "${API}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint" \
    "${HERE}/cloudflare/rate-limit.json" readback
# The tunnel PUT is deliberately NOT read back. Both calls above are ruleset entrypoints, whose
# response shape (`.result` echoing the applied ruleset) is what the comparison above is written
# against; the tunnel configuration endpoint returns a different envelope and this repo has not
# established its shape, so asserting against a guess would either pass vacuously or fail an
# apply for the wrong reason. What matters most about the tunnel -- that the hostname resolves,
# reaches THIS tunnel, and is proxied -- is read back from the API below, and its ingress order
# is gated in `test_tunnel_ingress_routes_the_production_host_to_the_app_service`.
put "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/configurations" \
    "${HERE}/cloudflare/tunnel-config.json"

echo "  cloudflare: desired state applied"

# The DNS record is the one piece of state this script does NOT own. The token carries
# Zone > DNS > READ only, deliberately: shipman.dev hosts more than this project, and an Edit
# scope would let a credential sitting in deploy/.env rewrite every record in the zone. Create
# the record once via Zero Trust > the tunnel > Public Hostname, which writes it for you.
#
# Verifying it is therefore this script's job, and all three properties fail differently:
# a missing record does not resolve at all; a record aimed anywhere other than the tunnel
# resolves to the wrong origin; and an UNPROXIED record still serves the site perfectly while
# silently bypassing the cache rule and the rate limit applied above -- the one that looks like
# success. `make cloudflare-apply` once printed "desired state applied" with no record at all.
HOST=$(jq -r '[.config.ingress[] | select(.hostname != null)][0].hostname' \
       "${HERE}/cloudflare/tunnel-config.json")
want="${CLOUDFLARE_TUNNEL_ID}.cfargotunnel.com"

dns=$(curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "${API}/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${HOST}")

if [ "$(printf '%s' "$dns" | jq -r '.success')" != "true" ]; then
  echo "  FAIL could not read DNS for ${HOST}." >&2
  printf '%s' "$dns" | jq -c '.errors' >&2
  echo "       An 'Authentication error' here means the API token is missing" >&2
  echo "       Zone > DNS > Read. That scope is read-only on purpose; do not widen it to Edit." >&2
  exit 1
fi

count=$(printf '%s' "$dns" | jq -r '.result | length')
if [ "$count" != "1" ]; then
  echo "  FAIL expected exactly one DNS record named ${HOST}, found ${count}." >&2
  echo "       Create it in Zero Trust > Networks > Tunnels > (tunnel) > Public Hostname," >&2
  echo "       which writes a proxied CNAME to ${want}." >&2
  exit 1
fi

read -r type content proxied <<<"$(printf '%s' "$dns" | jq -r '.result[0] | "\(.type) \(.content) \(.proxied)"')"
fail=0
[ "$type" = "CNAME" ] || { echo "  FAIL ${HOST} is a ${type} record, expected CNAME." >&2; fail=1; }
[ "$content" = "$want" ] || {
  echo "  FAIL ${HOST} points at ${content}, expected ${want} -- traffic would reach the" >&2
  echo "       wrong origin, or none." >&2; fail=1; }
[ "$proxied" = "true" ] || {
  echo "  FAIL ${HOST} is NOT proxied. The site would still serve, but every request would" >&2
  echo "       bypass the cache rule and the rate limit this script just applied." >&2; fail=1; }
[ $fail -eq 0 ]
echo "  ok   dns ${HOST} -> ${want} (proxied)"
