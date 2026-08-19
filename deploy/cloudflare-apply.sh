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

put() { # put <url> <file>
  local url="$1" file="$2" out
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
  echo "  ok   $(basename "$file")"
}

put "${API}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
    "${HERE}/cloudflare/cache-rules.json"
put "${API}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint" \
    "${HERE}/cloudflare/rate-limit.json"
put "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/configurations" \
    "${HERE}/cloudflare/tunnel-config.json"

echo "  cloudflare: desired state applied"
