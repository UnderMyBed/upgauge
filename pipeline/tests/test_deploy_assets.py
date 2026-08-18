"""The deploy assets are desired state (D8), so their invariants are asserted here rather
than discovered on the box. Every assertion below is a property whose violation is silent:
a published port, a writable root, or a moving tag all work fine until they matter."""

from __future__ import annotations

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
