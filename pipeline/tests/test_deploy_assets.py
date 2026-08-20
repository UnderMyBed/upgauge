"""The deploy assets are desired state (D8), so their invariants are asserted here rather
than discovered on the box. Every assertion below is a property whose violation is silent:
a published port, a writable root, or a moving tag all work fine until they matter."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import yaml

DEPLOY = Path(__file__).parents[2] / "deploy"


def _compose() -> dict:
    return yaml.safe_load((DEPLOY / "compose.yml").read_text())


def test_no_service_publishes_a_port_to_the_host():
    """The box has NO inbound ports (D4). cloudflared reaches the app over the compose
    network; a published port would put the origin on the public internet with no firewall
    in front of it, and nothing else in this repo would notice."""
    for name, svc in _compose()["services"].items():
        assert "ports" not in svc, f"{name} publishes a port; the box takes no inbound traffic"


def test_the_app_runs_read_only():
    """hosting.md measured --read-only working with no tmpfs: every DB-touching route is
    force-dynamic and db.ts opens READ_ONLY, so no write path survives. Losing this is
    invisible until something writes."""
    assert _compose()["services"]["app"]["read_only"] is True


def test_the_app_tracks_the_one_moving_tag():
    """`:deploy` is the only moving tag this project has (D5). A pinned digest here would
    make promote.yml a no-op; a `:latest` would make the running version time-dependent."""
    assert _compose()["services"]["app"]["image"] == "ghcr.io/undermybed/upguage:deploy"


def test_the_app_gets_a_base_url_that_is_not_localhost():
    """`UPGAUGE_BASE_URL` defaults to `http://localhost:3000` and prefixes every `<loc>` in
    `/sitemap.xml`, the `Sitemap:` line in `/robots.txt`, and every entity page's
    `<link rel="canonical">`. Left unset, the site renders perfectly and every URL it emits
    points at localhost -- a silent failure no served-build check catches by accident, since
    the page still returns 200. This is the exact class of bug the parent issue (#19) exists
    to prevent."""
    env = _compose()["services"]["app"].get("environment") or {}
    assert env.get("UPGAUGE_BASE_URL") == "https://upgauge.shipman.dev"
    assert "localhost" not in env.get("UPGAUGE_BASE_URL", "localhost")


def test_the_timer_fires_every_30_seconds():
    """D5 chose 30s over 5m because the poll sits at the tail of a pipeline that already
    cost minutes. A drift back to minutes would be invisible -- deploys would just feel
    slow."""
    unit = (DEPLOY / "upgauge-deploy.timer").read_text()
    assert "OnUnitActiveSec=30s" in unit
    assert "AccuracySec=1s" in unit, "systemd defaults to 1min accuracy, which eats a 30s period"


def test_cloud_init_installs_every_unit_the_timer_needs():
    """A cloud-init that lands the timer without the service (or the script) produces a box
    that boots clean and never deploys anything."""
    ci = yaml.safe_load((DEPLOY / "cloud-init.yaml").read_text().removeprefix("#cloud-config\n"))
    written = {f["path"] for f in ci["write_files"]}
    assert "/srv/upgauge/compose.yml" in written
    assert "/srv/upgauge/upgauge-deploy.sh" in written
    assert "/etc/systemd/system/upgauge-deploy.service" in written
    assert "/etc/systemd/system/upgauge-deploy.timer" in written


def test_the_tunnel_credential_is_not_committed():
    """The token is delivered at provision time from the operator's environment. A literal
    token here would be in git history forever."""
    text = (DEPLOY / "cloud-init.yaml").read_text()
    assert "TUNNEL_TOKEN=" not in text or "${TUNNEL_TOKEN}" in text


# --- The operator credential file -------------------------------------------------------
#
# Five secrets reach `make provision` / `make cloudflare-apply` from the operator's machine.
# They live in `deploy/.env`, which is gitignored, and `deploy/.env.example` is the committed
# template. Both halves of that arrangement fail silently when broken: an example that has
# drifted from what the scripts require sends an operator into a cryptic mid-apply abort, and
# a `.env` that is NOT ignored puts five live credentials in git history forever.


def _required_vars(script: str) -> set[str]:
    """Variables a script declares mandatory via bash's `: "${VAR:?...}"` guard."""
    text = (DEPLOY / script).read_text()
    return set(re.findall(r'^: "\$\{([A-Z][A-Z0-9_]*):\?', text, re.MULTILINE))


def _example_keys() -> set[str]:
    keys = set()
    for line in (DEPLOY / ".env.example").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        keys.add(line.split("=", 1)[0].removeprefix("export ").strip())
    return keys


def test_every_variable_the_scripts_require_is_in_the_example():
    """The example is the only thing an operator reads before their first apply. A variable
    that a script made mandatory but the template never mentions surfaces as an abort partway
    through provisioning -- after a box may already exist."""
    required = _required_vars("provision.sh") | _required_vars("cloudflare-apply.sh")
    assert required, 'parsed no required vars; the `: "${VAR:?}"` guard shape moved'
    assert required <= _example_keys(), (
        f"missing from deploy/.env.example: {sorted(required - _example_keys())}"
    )


def test_the_credential_file_is_gitignored():
    """`deploy/.env` holds the tunnel token and a Cloudflare token that can rewrite the zone's
    rulesets. Committing it is unrecoverable -- rotation, not deletion, is the only remedy."""
    proc = subprocess.run(
        ["git", "check-ignore", "-q", "deploy/.env"],
        cwd=DEPLOY.parent,
        capture_output=True,
    )
    assert proc.returncode == 0, "deploy/.env is NOT gitignored"


def test_the_example_carries_no_filled_in_value():
    """The template is committed, so a value typed into it ships to everyone. Every key is
    declared empty; the operator fills the copy, never the original."""
    for line in (DEPLOY / ".env.example").read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        assert value == "", f"{key.strip()} carries a value in the committed example: {value!r}"


def _source_loader(env_dir: Path, environ: dict[str, str], probe: str) -> str:
    """Source load-env.sh with `deploy/` relocated to a tmp dir, then echo one variable."""
    script = f'set -euo pipefail\n. "{env_dir}/load-env.sh"\nprintf %s "${{{probe}:-}}"\n'
    return subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        check=True,
        env={"PATH": os.environ["PATH"], **environ},
    ).stdout


def _loader_dir(tmp_path: Path, env_body: str | None) -> Path:
    (tmp_path / "load-env.sh").write_text((DEPLOY / "load-env.sh").read_text())
    if env_body is not None:
        (tmp_path / ".env").write_text(env_body)
    return tmp_path


def test_an_exported_variable_beats_the_file(tmp_path):
    """Environment wins, matching docker compose and dotenv. The reverse -- file wins -- makes
    `CLOUDFLARE_API_TOKEN=$rotated make cloudflare-apply` silently apply with the stale token
    still sitting in .env, which looks like a successful rotation and is not one."""
    d = _loader_dir(tmp_path, "CLOUDFLARE_API_TOKEN=from-file\n")
    got = _source_loader(d, {"CLOUDFLARE_API_TOKEN": "from-environment"}, "CLOUDFLARE_API_TOKEN")
    assert got == "from-environment"


def test_the_file_supplies_a_variable_the_environment_lacks(tmp_path):
    """The whole point: an unset variable is filled from the file, and exported, so the
    `: \"${VAR:?}\"` guard downstream is satisfied."""
    d = _loader_dir(tmp_path, "CLOUDFLARE_ZONE_ID=zone-from-file\n")
    assert _source_loader(d, {}, "CLOUDFLARE_ZONE_ID") == "zone-from-file"


def test_a_missing_file_is_not_an_error(tmp_path):
    """Both scripts run `set -euo pipefail` and both are usable with no .env at all -- CI, or
    an operator passing values inline. A loader that returns non-zero on an absent file kills
    the run before the script's own error message can say what is actually missing."""
    d = _loader_dir(tmp_path, None)
    assert _source_loader(d, {"TUNNEL_TOKEN": "inline"}, "TUNNEL_TOKEN") == "inline"


# --- Measured on a real Hetzner box, 2026-08-19 (Task 6 probe) ---------------------------
#
# Two failures found by provisioning a throwaway cx23 in nbg1 and reading its logs. Both
# produce a box that boots, runs its timer every 30s, and never serves anything -- the
# failure mode this repo has already shipped twice.


def test_cloud_init_installs_the_docker_client_not_just_the_daemon():
    """MEASURED on debian-13: `docker.io` ships /usr/sbin/dockerd, /usr/sbin/docker-proxy and
    /usr/bin/docker-init -- the DAEMON ONLY. /usr/bin/docker comes from `docker-cli`, and
    `docker-compose-v2` does not pull it in (verified by installing it and still having no
    `docker` on PATH). upgauge-deploy.sh's first command is `docker image inspect`, so without
    this the unit dies with `docker: command not found` on every run, forever, silently."""
    packages = yaml.safe_load((DEPLOY / "cloud-init.yaml").read_text())["packages"]
    invokes_docker = any(
        re.search(r"^\s*docker\s", (DEPLOY / f).read_text(), re.MULTILINE)
        for f in ("upgauge-deploy.sh",)
    )
    assert invokes_docker, "nothing invokes `docker`; this test's premise moved"
    assert "docker-cli" in packages, (
        f"cloud-init installs {packages} -- none of which provides /usr/bin/docker on Debian 13"
    )


def test_provision_gives_the_box_an_ipv4():
    """MEASURED: ghcr.io publishes NO AAAA record, and Hetzner's resolvers
    (2a01:4ff:ff00::add:1/2) do NOT synthesize one -- there is no DNS64/NAT64. On an
    IPv6-only box `curl -6 https://ghcr.io/v2/` fails with "Could not resolve host", so the
    image can never be pulled and the site never comes up. `--without-ipv4` (D3) is
    incompatible with pulling from GHCR (D1); the IPv4 costs about $0.60/mo."""
    text = (DEPLOY / "provision.sh").read_text()
    assert "--without-ipv4" not in text, (
        "provision.sh creates an IPv6-only box, which cannot resolve or reach ghcr.io"
    )


def test_provision_does_not_depend_on_hcloud_output_templates():
    """MEASURED: `make provision` exited 1 AFTER successfully creating the box, because its
    final line used `-o format='{{.Datacenter.Location.Name}}'` and Hetzner removed
    datacenters on 2026-07-01. hcloud's Go-template field paths track their API's Go structs
    and are not stable across CLI versions, so a template is a latent failure that reports a
    good provision as a bad one -- the worst direction for an operator, who cannot tell
    whether to re-run. `-o columns=` (used for the list calls) is a stable, documented
    surface; `{{.Field.Path}}` is not."""
    code = [
        ln
        for ln in (DEPLOY / "provision.sh").read_text().splitlines()
        if not ln.lstrip().startswith("#")
    ]
    offenders = [ln for ln in code if "{{." in ln]
    assert not offenders, (
        f"provision.sh references an hcloud Go-template field path: {offenders}. A renamed "
        f"field turns a successful provision into a red exit."
    )


def test_the_deploy_script_exports_the_token_to_its_children(tmp_path):
    """MEASURED: the box ran its timer every 30s from first boot and never served anything.
    `upgauge-deploy.sh` sources /etc/upgauge/deploy.env, which cloud-init writes as a BARE
    assignment (`TUNNEL_TOKEN=...`, no export), so the token is a shell variable and not part
    of the environment. `docker compose` is a child process and interpolates
    `${TUNNEL_TOKEN:?}` from its OWN environment, so it failed with "required variable
    TUNNEL_TOKEN is missing a value" -- on `docker compose pull`, the script's first compose
    call, under `set -euo pipefail`. Every tick, forever, on any box.

    This asserts the real property across a real process boundary rather than the presence of
    `set -a`: it runs the script's actual sourcing idiom and checks whether a CHILD sees the
    value. A shell that can echo the variable proves nothing -- that was true while production
    was down."""
    # Run the script's real PROLOGUE -- everything before it first touches docker. Selecting
    # only the lines that mention deploy.env would drop the very construct under test.
    lines = (DEPLOY / "upgauge-deploy.sh").read_text().splitlines()
    cut = next(
        i for i, ln in enumerate(lines) if "docker" in ln and not ln.lstrip().startswith("#")
    )
    prologue = "\n".join(lines[:cut])
    assert "deploy.env" in prologue, "the prologue no longer sources deploy.env; premise moved"

    env_file = tmp_path / "deploy.env"
    env_file.write_text("TUNNEL_TOKEN=pretend-token\n")
    snippet = prologue.replace("/etc/upgauge/deploy.env", str(env_file)).replace(
        "cd /srv/upgauge", f"cd {tmp_path}"
    )

    # `printenv` is a separate process, exactly like `docker compose`.
    proc = subprocess.run(
        ["bash", "-c", f"set -euo pipefail\n{snippet}\nprintenv TUNNEL_TOKEN"],
        capture_output=True,
        text=True,
        env={"PATH": os.environ["PATH"]},
    )
    assert proc.stdout.strip() == "pretend-token", (
        "a child process does not inherit TUNNEL_TOKEN -- docker compose will fail "
        f"interpolation and the box will never deploy (stdout={proc.stdout!r})"
    )
