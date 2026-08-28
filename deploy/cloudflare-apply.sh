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

# Read-back drift, accumulated across every PUT and judged once at the end (see put()).
DRIFTED=""

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
  # it does not apply -- measured on the http_ratelimit entrypoint: a PUT updated the ruleset's
  # description and rules and dropped `name` without a word about it
  # (test_rate_limit_keeps_the_name_the_zone_actually_holds records that measurement). Every gate
  # in this repo constrains what we SEND; without this, nothing compares that to what the zone
  # KEPT, and the committed file could stop describing production with every test green.
  #
  # The response echoes the applied ruleset, so this costs no extra request. It walks every
  # SCALAR LEAF of what we sent and looks it up at the same path in `.result`, so fields
  # Cloudflare ADDS (`id`, `version`, `last_updated`, per-rule `ref`, defaulted members of
  # `ratelimit`) are extra keys and are correctly ignored. What it reports is therefore
  # DROPPED-OR-ALTERED, not "different": an added field is invisible to it except where a value
  # is compared as a whole (below). The send side is what forbids unknown fields, by key-set
  # equality, and the two halves are deliberately different questions.
  #
  # `name` is EXEMPT, and that is the whole reason this is not a blanket comparison. The zone
  # freezes a ruleset's name at creation and ignores it on every later PUT, so a divergence here
  # is not a mistake anyone can fix by editing the file -- flagging it would halt the deploy with
  # a remedy that cannot converge. It is reported as a note instead.
  #
  # `characteristics` is compared as a SET. It is set-valued at the edge while `rules` is
  # order-significant, so index-by-index comparison would turn a harmless reordering into two
  # spurious drifts; comparing it whole also means an ADDED member is caught here, which is the
  # one place this check sees an addition at all.
  if [ -n "$readback" ]; then
    local drift got_name
    drift=$(jq -n \
      --argjson sent "$(jq -S . "$file")" \
      --argjson got "$(printf '%s' "$out" | jq -S '.result // {}')" \
      '[ $sent | paths(scalars) as $p
         | select($p != ["name"])
         | select(($p | index("characteristics")) == null)
         | select(($got | getpath($p)) != ($sent | getpath($p)))
         | ($p | map(tostring) | join(".")) ]
       + [ $sent | paths as $p
         | select(($sent | getpath($p) | type) == "array")
         | select($p[-1] == "characteristics")
         | select(((($got | getpath($p)) // []) | sort) != (($sent | getpath($p)) | sort))
         | (($p | map(tostring) | join(".")) + " (compared as a set)") ]')
    got_name=$(printf '%s' "$out" | jq -r '.result.name // empty')
    if [ -n "$got_name" ] && [ "$got_name" != "$(jq -r '.name // empty' "$file")" ]; then
      echo "  note $(basename "$file"): the zone holds name '${got_name}'. A ruleset's name is"
      echo "       fixed at creation and ignored by every later PUT, so this is not editable"
      echo "       from here -- it is stated so nobody re-litigates it as a diff."
    fi
    if [ "$(printf '%s' "$drift" | jq -r 'length')" != "0" ]; then
      # ACCUMULATE, never exit here. Exiting inside put() halts the sequence at whichever file
      # tripped, and the ordering makes that worst-case: cache-rules is PUT first and carries no
      # security control, while rate-limit.json -- which does -- is second, and the tunnel third.
      # A drift on the first file would leave the edge rate limit and the tunnel unapplied. The
      # PUTs are idempotent, so applying all of them and failing ONCE at the end is strictly
      # better than stopping half way. Same shape as the DNS block's `fail=0` ... `[ $fail -eq 0 ]`
      # below, which is why that pattern is reused rather than reinvented.
      echo "  DRIFT $(basename "$file"): the API reported success and did not keep what it was sent." >&2
      printf '%s' "$drift" | jq -r '.[] | "        dropped or altered: \(.)"' >&2
      DRIFTED="${DRIFTED}$(basename "$file") "
    fi
  fi
  echo "  ok   $(basename "$file")"
}

put "${API}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
    "${HERE}/cloudflare/cache-rules.json" readback
put "${API}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint" \
    "${HERE}/cloudflare/rate-limit.json" readback
# The tunnel PUT is deliberately NOT read back, and the reason is narrower than it looks. The
# comparator enumerates paths from what was SENT, so an envelope carrying extra keys is tolerated
# by construction -- it would not "pass vacuously", and with four scalar leaves it could not. The
# real reason is that nobody has established WHERE this endpoint echoes the applied config: if
# `.result` is the configuration itself rather than an object containing `.config`, every one of
# those four leaves resolves to null and a correct apply reports four drifts. Guessing costs a
# false alarm on the highest-consequence file, so it is left off until someone reads one real
# response and writes the shape down.
#
# The DNS block below is NOT a substitute, and should not be read as one: it establishes that the
# hostname resolves to THIS tunnel and is proxied. It says nothing about what the tunnel then
# routes that hostname to -- `test_tunnel_ingress_routes_the_production_host_to_the_app_service`
# pins the ingress order in the committed file, and nothing here confirms the zone kept it.
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
[ -z "$DRIFTED" ] || {
  echo "  FAIL read-back drift on: ${DRIFTED}" >&2
  echo "       Every file above WAS applied -- the API accepted each PUT. What it did not do is" >&2
  echo "       keep everything it was sent, so the committed file no longer describes the zone." >&2
  echo "       Re-applying is idempotent; fix the file and run this again." >&2
  fail=1
}
[ $fail -eq 0 ]
echo "  ok   dns ${HOST} -> ${want} (proxied)"
