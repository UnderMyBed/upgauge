# Deploying Upgauge

The delivery path and the commands that operate it. Hosting shape, cost, the survey and the
portability contract are [hosting.md](hosting.md); this file is the procedure.

Every step here is a command. Where a step cannot be a command, it says so and why.

## Deploying does not run from a laptop, and needs no credentials

| Step | Where it runs | What starts it |
|---|---|---|
| Build the image, gate it, push to GHCR | `.github/workflows/image.yml` | push to `main`, a `workflow_run` of Warehouse, or a manual dispatch |
| Move the `:deploy` tag to a chosen digest | `.github/workflows/promote.yml` | `workflow_dispatch` with an immutable tag |
| Pull and restart | `upgauge-deploy.timer` on the box | compares digests every 30s |

Promoting is a registry re-tag; nothing reaches into the box (D5). CI holds no Hetzner or
Cloudflare credential and gets no SSH — a compromised workflow must be able to own the tag,
never the box.

**`docker compose up -d --wait` recreates the container**, stopping the healthy one before the
new one is confirmed healthy. An image that pulls but fails its healthcheck takes the site down
and the 30s timer retries it forever. Accepted: every image passes `make image-smoke` before it
can reach the registry, and blue/green on a 4 GB box is not worth it for ~12 deploys a year.
`promote.yml`'s health poll is the detector; **rolling back is the remedy and is the same
operation as deploying.** The poll detects it only when it can read the box — see § What to do
when each alert fires.

## Promote

```bash
gh workflow run promote.yml -f tag=warehouse-2026.05-eb4da0d
```

Tags are listed by the registry, anonymously — the image is public, and this is the same path
the box uses, so it needs no `gh` package scope:

```bash
TOK=$(curl -sS "https://ghcr.io/token?scope=repository:undermybed/upguage:pull&service=ghcr.io" | jq -r .token)
curl -sS -H "Authorization: Bearer $TOK" https://ghcr.io/v2/undermybed/upguage/tags/list | jq -r '.tags[]'
```

Confirm the box picked it up (measured: **55s** from retag to serving):

```bash
curl -sS https://upgauge.shipman.dev/api/health | jq -c '{status, build, data}'
```

**`:deploy` does not share the promoted tag's digest.** `imagetools create` wraps the source
manifest in a new index, so `:deploy` resolves to an index whose only child is the promoted
digest. Verifying a promote by comparing those two digests reports a false failure; compare
what `/api/health` returns, or compare the index's child.

## Roll back

The same operation with the previous tag. Measured: **85s** from retag to the older build
serving.

```bash
gh workflow run promote.yml -f tag=warehouse-2026.05-6ea164b
curl -sS https://upgauge.shipman.dev/api/health | jq -r .build.sha
```

## Provision, or replace the box

The box is cattle. It holds no state — the dataset is baked into the image, and DNS points at
the tunnel rather than an IP — so replacing it is delete plus provision, and nothing else
changes.

```bash
cp deploy/.env.example deploy/.env      # first time only; fill it in
hcloud server delete upgauge            # replacing only
make provision
make cloudflare-apply
```

`make provision` is idempotent: it creates the server only when absent and re-attaches the
deny-all firewall on every run. `make cloudflare-apply` PUTs the whole ruleset, so re-applying
re-asserts rather than duplicates, and it verifies the DNS record it does not own.

**`make provision` exits 0 even when the box is broken.** cloud-init records package failures
that nothing reads, and the box is unreachable by design, so provisioning cannot detect them.
Measured: a box whose `docker-compose` package failed to install provisioned "successfully" and
served 530 indefinitely. **`live-check.yml` is the detector** — after provisioning, confirm the
site serves rather than assuming it:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://upgauge.shipman.dev/api/health   # expect 200
```

Convergence from a fresh box takes a few minutes: apt, then a 372 MiB image pull. `530` means
the tunnel is not connected yet; `502` means it is connected and the origin is not serving yet.
Both are normal during startup and neither is a failure until it persists.

`hcloud server create` prints a **root password** when no SSH key is passed, and none is (D4 —
break-glass is the Hetzner console). It lands in the operator's scrollback.

## The DNS record is created once, by hand

The token carries `Zone > DNS > Read`, not Edit: `shipman.dev` is not only this project, and a
credential in `deploy/.env` must not be able to rewrite the zone. Create it in **Zero Trust >
Networks > Tunnels > (tunnel) > Public Hostname**, which writes a proxied CNAME to
`<tunnel-id>.cfargotunnel.com`. `make cloudflare-apply` then asserts it exists, targets the
tunnel, and is **proxied** — an unproxied record still serves the site while silently bypassing
the cache rule and the rate limit.

## Rotate the tunnel credential

```bash
# Cloudflare dashboard: Zero Trust > Networks > Tunnels > (tunnel) > Refresh token
$EDITOR deploy/.env                     # replace TUNNEL_TOKEN
hcloud server delete upgauge && make provision
```

The token is delivered by cloud-init at provision time, so rotating it means replacing the box.
That is one command and no state is lost.

## Credentials

`deploy/.env.example` is the committed template and names every variable, where each value comes
from, and the exact token scopes. `deploy/.env` is the gitignored copy. **An exported variable
wins over the file**, matching docker compose and dotenv — the reverse would let
`CLOUDFLARE_API_TOKEN=$rotated make cloudflare-apply` apply with the stale token and report
success. Env-var reference for the app itself: [hosting.md](hosting.md).

## What to do when each alert fires

| Alert | Meaning | First command |
|---|---|---|
| **Freshness** (`freshness.yml`) | `max(year_month)` has not advanced in ~45 days. The site keeps serving; `DATA AS OF` silently stops moving | `gh run list --workflow=warehouse.yml --limit 5` |
| **Live check** (`live-check.yml`) | The served site is wrong, down, or could not be read — health, sitemap, release freshness or the rate limit | `curl -sS https://upgauge.shipman.dev/api/health \| jq .` |
| **Scheduled failure** (`scheduled-failure.yml`) | An unattended workflow failed and nobody was watching | `gh run list --limit 10` |

A live-check failure that is **not** a bad promote and **not** an unreadable body is almost
always the box: confirm with `hcloud server describe upgauge`, and replace it rather than
debugging in place — replacement is one command and the box holds nothing.

### "Could not read the box" is a verdict, and it is not evidence about the deploy

Both watchdogs report an `/api/health` body they could not parse as what it is: an observation,
carried with its HTTP status and the first characters of the body, never raised and never defaulted.
An edge challenge page, an HTML error page and an origin that is down are indistinguishable from
a runner, so that reading argues in neither direction. **The status code never decides it** —
`/api/health` answers 503 with a complete, valid report when the data layer is degraded, and a
build read from one of those is as real as any other.

**`promote.yml` orders a rollback only when the box reported a build and it was the wrong one.**
Where no build was read it names what came back instead and hands over the check that separates
the two readings. Run that check from a network that reaches the site, and act on what it shows,
not on the failed run:

```bash
curl -sS -D - https://upgauge.shipman.dev/api/health
```

Down, or serving a build other than the promoted one → roll back. Reporting the promoted build →
the run was blind and the deploy is fine.

**`live-check.yml` files its alert either way**, because an alert that cannot read the site is
the one thing it must never fail silently on. **A body that parsed is not thereby a report** —
`{}` and a Cloudflare JSON error body both parse — so the test is whether it carries the
`status`, `build` and `data` that a `HealthReport` always has.

**Every finding names something measured**, and a check whose evidence is missing is withheld
rather than answered from a default. A promote is only "forgotten" against a warehouse tag the
site actually served; `UPGAUGE_BASE_URL` is only wrong against a `<loc>` actually found carrying
another host; the edge is only "not caching" when it returned a `cf-cache-status` saying so; the
rate limit is only "not in force" when the burst actually reached `/api/pivot`. A blocked runner
trips all four conditions at once, and each one of those diagnoses would send an operator after a
setting that is fine.

## Rate limiting

**The thresholds are `deploy/cloudflare/rate-limit.json`, not a sentence here.** That file is the
record and is applied verbatim. Note the plan constrains both numbers: the window must be 10s and
the mitigation timeout must be 10s, so the sustained rate is 1 req/s per IP on `/api/` and a
blocked client resumes after 10s. It caps throughput; it is not a wall.

A burst test must send a request the endpoint **accepts** — `/api/pivot` answers a non-canonical
query with 400, and a burst of 400s measures the rejection path while looking like a broken rate
limit:

```bash
Q='v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op'
for i in $(seq 1 40); do curl -sS -o /dev/null -w '%{http_code} ' "https://upgauge.shipman.dev/api/pivot?$Q" & done; wait
```

**Running that burst blocks your own next checks for 10 seconds.** `/api/health` is under
`/api/`, so it matches the same rule — after a burst, health polls from the same address return
429 and read as "the site is down" or "the deploy failed". Wait out the mitigation timeout
before believing a health check that follows a burst. The pollers themselves are safely under
the limit: `promote.yml` polls once per 10s (30 attempts), and `live-check.yml` makes single
calls, with its own burst step last.

## Cost, and when to revisit

`cx23` at **$6.49/mo** plus a **$0.60/mo IPv4** — the IPv4 is required, not optional: `ghcr.io`
publishes no AAAA record and Hetzner provides no NAT64, so an IPv6-only box cannot reach the
registry at all. **$7.09/mo**, against a $25 account credit ≈ **3.5 months**. Revisit before it
runs out.

## Infrastructure is committed desired state, not IaC

`deploy/cloud-init.yaml` and `deploy/cloudflare/*.json` are the state; `make provision` and
`make cloudflare-apply` apply it idempotently (D8). **Adoption trigger for OpenTofu:** a second
environment, a second operator, or the surface outgrowing ~15 resources. OpenTofu can import
what exists, so this is reversible.

## Two traps the OS puts in the way

Both cost a live outage and both are pinned by tests in `pipeline/tests/test_deploy_assets.py`.

- **`docker.io` on Debian 13 is the daemon only.** `/usr/bin/docker` ships in `docker-cli`.
- **There is no `docker-compose-v2` on Debian 13** — that is the Ubuntu name. Compose V2 is
  `docker-compose` (2.26.1-4, a version string that reads like v1 and is not).

Package names are facts about the OS image. If `UPGAUGE_OS_IMAGE` changes, re-measure them.
