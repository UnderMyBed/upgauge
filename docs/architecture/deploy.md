# Deploying Upgauge

The delivery path, and the credentials that bootstrap it. Hosting shape, cost and the
portability contract are [hosting.md](hosting.md); this file is the operating procedure.

## Deploying does not run from a laptop, and needs no credentials

| Step | Where it runs | What starts it |
|---|---|---|
| Build the image, gate it, push to GHCR | `.github/workflows/image.yml` | push to `main`, a `workflow_run` of Warehouse, or a manual dispatch |
| Move the `:deploy` tag to a chosen digest | `.github/workflows/promote.yml` | `workflow_dispatch` with an immutable tag, e.g. `warehouse-2026.05-9a9511d` |
| Pull and restart | `upgauge-deploy.timer` on the box | compares digests every 30s |

Promoting is a registry re-tag; nothing reaches into the box (D5). **Rollback is the same
dispatch with the previous tag**, which is what keeps the emergency path exercised. CI holds no
Hetzner or Cloudflare credential, and gets no SSH access — a compromised workflow must not be
able to own the box, only the tag it points at.

`docker compose up -d --wait` **recreates** the container: it stops the healthy one before the
new one is confirmed healthy, so an image that pulls but fails its healthcheck takes the site
down, and the 30s timer retries that same image forever rather than reverting. This is accepted
— every image passes `make image-smoke` before it can reach the registry, and blue/green on a
4 GB box is not worth it for roughly twelve deploys a year. `promote.yml`'s health poll is the
detector; promoting the previous tag is the remedy.

## Credentials, and where they live

Five secrets exist, and they bootstrap infrastructure rather than deploy code — `make provision`
and `make cloudflare-apply` only. They belong on the operator's machine, **not** in GitHub
Secrets: the Cloudflare token can rewrite the zone's rulesets and the Hetzner context can destroy
the box, which is a poor trade for a path that runs about twice.

```bash
cp deploy/.env.example deploy/.env    # then fill deploy/.env in
```

`deploy/.env.example` is the committed template and names every variable, where each value comes
from, and the exact token scopes. `deploy/.env` is gitignored — `.gitignore`'s `.env` pattern has
no slash, so it matches at any depth; a test asserts this, because tightening the pattern to
`/.env` would silently make the file committable.

Both scripts source `deploy/load-env.sh` before their `: "${VAR:?}"` guards. **A variable already
exported wins over the file**, matching docker compose and dotenv: the reverse would let
`CLOUDFLARE_API_TOKEN=$rotated make cloudflare-apply` apply with the stale token still in `.env`
and report success. A missing `deploy/.env` is not an error — values may be passed inline, and the
guards give the better message about what is absent.

## Bootstrap

Infrastructure is committed desired state applied by `make`, not IaC (D8). `deploy/cloud-init.yaml`
and `deploy/cloudflare/*.json` are that state; both commands re-assert it on every run, so drift
is fixed by re-applying. Cloudflare's ruleset API is a PUT of the whole ruleset and DNS is an
upsert by name; `make provision` creates the server only when absent but attaches the
deny-all-inbound firewall unconditionally.

```bash
make provision          # Hetzner cx23 in nbg1, IPv6-only, all inbound denied
make cloudflare-apply   # cache rule, rate limit, tunnel ingress
```

Provisioning is keyed on the server **name**, so `UPGAUGE_SERVER_NAME` pointed at a second name
creates a second billable box rather than reconfiguring the first.

**Adoption trigger for OpenTofu, per D8:** a second environment, a second operator, or the surface
outgrowing roughly fifteen resources. OpenTofu can import what exists, so this is reversible.
