#!/usr/bin/env python3
"""Health-gated, pull-based releases for an existing Mint NAS Compose VM."""

import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request
from zoneinfo import ZoneInfo

SHA = re.compile(r"^[0-9a-f]{40}$")
REPO = "ChickenBone/mint"
ROOT = Path(os.environ.get("MINT_DIR", "/srv/mint"))
SETTINGS = Path(os.environ.get("MINT_SETTINGS_FILE", "/etc/mint/settings.env"))
WINDOW = ZoneInfo("America/Chicago")
SLOTS = ("blue", "green")
WAIT = "900"


class MaintenanceRequired(RuntimeError):
    pass


def log(message):
    print(f"[mint-deploy] {message}", flush=True)


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def write(path, content):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".mint-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save(path, value):
    write(path, json.dumps(value, indent=2) + "\n")


def save_compose(path, value):
    # Compose interpolates even JSON produced by `config`; preserve literal dollars in secrets/commands.
    def escape(item):
        if isinstance(item, str):
            return item.replace("$", "$$")
        if isinstance(item, list):
            return [escape(child) for child in item]
        if isinstance(item, dict):
            return {key: escape(child) for key, child in item.items()}
        return item
    save(path, escape(value))


def load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "mint-esxi-deploy"})
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def api(path):
    return json.loads(fetch(f"https://api.github.com/repos/{REPO}/{path}"))


def eligible(cache):
    """Require the latest CI attempt and all deployed image jobs for the same SHA."""
    releases = api("actions/workflows/release.yml/runs?branch=main&event=push&per_page=20")
    checks = api("actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100")
    latest = {}
    for check in checks["workflow_runs"]:
        latest.setdefault(check["head_sha"], check)
    seen = set()
    for release in releases["workflow_runs"]:
        sha = release["head_sha"]
        if sha in seen:
            continue
        seen.add(sha)
        if not SHA.fullmatch(sha) or release.get("head_branch") != "main":
            continue
        if release.get("head_repository", {}).get("full_name", "").lower() != REPO.lower():
            continue
        check = latest.get(sha)
        if not check or check.get("conclusion") != "success" or release["status"] != "completed":
            continue
        key = f"{release['id']}:{release['run_attempt']}:{release['updated_at']}"
        if key not in cache:
            jobs = api(f"actions/runs/{release['id']}/jobs?per_page=100")["jobs"]
            cache[key] = {job["name"]: job["conclusion"] for job in jobs}
        if all(cache[key].get(f"image ({name})") == "success" for name in ("web", "worker", "realtime", "chart-source")):
            return sha
    return None


def maintenance_time(now=None):
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(WINDOW)
    # Admission window, not a promise that a migration/recovery finishes in 30 minutes.
    return now.hour == 4 and now.minute < 30


def reason_for_maintenance(base, target):
    if not SHA.fullmatch(base or "") or not SHA.fullmatch(target):
        return "missing verified baseline"
    comparison = api(f"compare/{base}...{target}")
    if comparison["status"] not in ("ahead", "identical"):
        raise RuntimeError("release is not a descendant of the deployed commit; refusing rollback/divergence")
    files = comparison.get("files", [])
    if len(files) >= 300:
        return "GitHub compare file limit"
    for file in files:
        for name in (file["filename"], file.get("previous_filename", file["filename"])):
            web = name.startswith("apps/web/") and name != "apps/web/package.json"
            docs = name.startswith(("docs/", "agents/", ".github/skills/"))
            if not (web or docs or name in ("README.md", "PRODUCT.md", "DESIGN.md", "AGENTS.md")):
                return f"shared/backend/infrastructure change: {name}"
    return None


def compose(path, *args, capture=False):
    return run(["docker", "compose", "--project-directory", str(ROOT), "-f", str(path), *args],
               capture_output=capture)


def current_config():
    return json.loads(run(["docker", "compose", "--project-directory", str(ROOT),
                           "-f", str(ROOT / "compose.yml"), "-f", str(ROOT / "compose.vm.yml"),
                           "config", "--format", "json"], capture_output=True).stdout)


def render(source, settings, sha):
    if not SHA.fullmatch(sha):
        raise ValueError("invalid release SHA")
    for raw in settings.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError("invalid settings line")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        pattern = rf'^(\s+{re.escape(key)}:\s*&[\w-]+\s+)"[^"\n]*"[ \t]*$'
        source, count = re.subn(pattern, lambda m: m[1] + json.dumps(value.replace("$", "$$")), source, flags=re.M)
        if count != 1:
            raise ValueError(f"{key} is not a supported quoted NAS setting")
    return re.sub(r"(image:\s*ghcr\.io/[^/\s]+/mint-[a-z-]+):latest\b",
                  rf"\1:sha-{sha[:7]}", source)


def private_networks(config):
    for service in config["services"].values():
        if service.get("network_mode") in ("host", "none") and service is not config["services"].get("init"):
            raise ValueError("unexpected network isolation")
        for port in service.get("ports", []):
            if port.get("host_ip") not in ("127.0.0.1", "::1"):
                raise ValueError("published ports must remain loopback-only")


def stable_storage(old, new):
    """Never silently move a database, generated secret or music mount."""
    for name, service in old["services"].items():
        if name not in new["services"]:
            raise ValueError(f"service removal needs an operator: {name}")
        if service.get("volumes", []) != new["services"][name].get("volumes", []):
            raise ValueError(f"storage change needs an operator: {name}")


def prepare(sha, old, routine):
    source = fetch(f"https://raw.githubusercontent.com/{REPO}/{sha}/docker-compose.nas.yml")
    path = ROOT / "candidate.yml"
    write(path, render(source, SETTINGS.read_text(encoding="utf-8"), sha))
    result = run(["docker", "compose", "--project-directory", str(ROOT), "-f", str(path),
                  "-f", str(ROOT / "compose.vm.yml"), "config", "--format", "json"], capture_output=True)
    config = json.loads(result.stdout)
    private_networks(config)
    stable_storage(old, config)
    if routine:
        for name, service in config["services"].items():
            unchanged = copy.deepcopy(service)
            if name in old["services"]:
                unchanged["image"] = old["services"][name]["image"]
            if unchanged != old["services"].get(name):
                raise MaintenanceRequired(f"runtime configuration changed: {name}")
    selected = ["web"] if routine else ["web", "worker", "hub", "realtime"]
    if not routine and old["services"]["web"]["environment"].get("MINT_CHART_SOURCE_URL") == "http://chart-source:3090":
        selected.append("chart-source")
    # Pull only application images; floating infrastructure tags are never refreshed by a web rollout.
    pinned = {}
    for name in selected:
        image = config["services"][name]["image"]
        if image in pinned:
            config["services"][name]["image"] = pinned[image]
            continue
        run(["docker", "pull", "--quiet", image], stdout=subprocess.DEVNULL)
        info = json.loads(run(["docker", "image", "inspect", image], capture_output=True).stdout)[0]
        if (info["Config"].get("Labels") or {}).get("org.opencontainers.image.revision") != sha:
            raise ValueError(f"{name} image revision does not match the gated commit")
        digests = info.get("RepoDigests", [])
        if not digests:
            raise ValueError(f"{name} image has no immutable digest")
        pinned[image] = config["services"][name]["image"] = digests[0]
    if routine:
        next_config = copy.deepcopy(old)
        next_config["services"]["web"] = config["services"]["web"]
        return next_config
    # Infrastructure upgrades are explicit, window-gated operator work, not floating-tag churn.
    for name in config["services"]:
        if name not in selected and name in old["services"]:
            config["services"][name]["image"] = old["services"][name]["image"]
    if config["services"]["init"] != old["services"]["init"]:
        raise ValueError("bootstrap configuration changed; operator inspection required")
    if config["networks"] != old["networks"]:
        raise ValueError("network changes require operator inspection")
    return config


def slot_config(config, slot):
    service = copy.deepcopy(config["services"]["web"])
    service.pop("depends_on", None)
    service.pop("container_name", None)
    service["networks"] = {name: {} for name in service["networks"]}
    service["restart"] = "unless-stopped"
    service["stop_grace_period"] = "60s"
    return {
        "name": f"mint-{slot}",
        "services": {f"web-{slot}": service},
        "networks": {name: {"external": True, "name": config["networks"][name]["name"]}
                     for name in service["networks"]},
    }


def proxy_config(upstream, fallback=None):
    static = ""
    if fallback:
        static = f"""
  handle /_next/static/* {{
    reverse_proxy {upstream}:3000 {{
      @missing status 404
      handle_response @missing {{
        reverse_proxy {fallback}:3000
      }}
    }}
  }}
"""
    return """{
  admin localhost:2019
}
:80 {
  encode zstd gzip
  handle /ws* {
    reverse_proxy realtime:3001 {
      stream_close_delay 24h
      header_up X-Forwarded-For {remote_host}
    }
  }
  handle /ingest/* {
    request_body {
      max_size 250MB
    }
    reverse_proxy hub:8090 {
      header_up X-Forwarded-For {remote_host}
      transport http {
        read_timeout 1h
        write_timeout 1h
      }
    }
  }
""" + static + f"""
  handle {{
    reverse_proxy {upstream}:3000 {{
      header_up Host {{$MINT_DOMAIN}}
      header_up X-Forwarded-Host {{$MINT_DOMAIN}}
      header_up X-Forwarded-For {{remote_host}}
      header_up X-Real-IP {{remote_host}}
    }}
  }}
}}
"""


def managed_proxy(config):
    config = copy.deepcopy(config)
    caddy = config["services"]["caddy"]
    caddy["entrypoint"] = ["caddy"]
    caddy["command"] = ["run", "--config", "/etc/mint-rollout/Caddyfile", "--adapter", "caddyfile"]
    caddy["volumes"].append({"type": "bind", "source": str(ROOT / "proxy"),
                             "target": "/etc/mint-rollout", "read_only": True})
    return config


def versioned_proxy(upstream, sha, fallback=None):
    return proxy_config(upstream, fallback).replace(
        "  encode zstd gzip", f'  header X-Mint-Release "{sha}"\n  encode zstd gzip')


def proxy_command(config_path, *args):
    return compose(config_path, "exec", "-T", "caddy", "caddy", *args, capture=True)


def probe(config_path, sha, slot=None):
    # A local proxy request exercises its routing and actual new app, not just container liveness.
    service = f"web-{slot}" if slot else "web"
    path = ROOT / f"{slot}.json" if slot else config_path
    script = ("""(async()=>{
      const deadline=Date.now()+30000;
      let failure='unexpected status or release header';
      while(Date.now()<deadline) {
        try {
          const r=await fetch('http://caddy:80/api/healthz',{signal:AbortSignal.timeout(2000)});
          await r.arrayBuffer();
          if(r.ok && r.headers.get('x-mint-release')==='""" + sha + """') return;
        } catch(error) { failure=error.name; }
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      console.error('proxy readiness failed: '+failure);
      process.exit(1);
    })().catch(error=>{console.error(error.name);process.exit(1)});""")
    compose(path, "exec", "-T", service, "node", "-e", script, capture=True)


def backup(config_path):
    folder = ROOT / "backups"
    folder.mkdir(mode=0o700, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = folder / f"mint-{stamp}.dump"
    with target.open("wb") as handle:
        os.chmod(target, 0o600)
        compose_args = ["docker", "compose", "--project-directory", str(ROOT), "-f", str(config_path),
                        "exec", "-T", "postgres", "pg_dump", "-U", "mint", "-d", "mint", "-Fc"]
        run(compose_args, stdout=handle)
    if not target.stat().st_size:
        raise RuntimeError("empty database backup")
    for old in sorted(folder.glob("mint-*.dump"))[:-5]:
        old.unlink()


def retire_retained(state):
    if not state.get("proxy_ready") or not maintenance_time():
        return
    live = ROOT / "live.json"
    proxy = ROOT / "proxy" / "Caddyfile"
    previous = proxy.read_text(encoding="utf-8")
    write(proxy, versioned_proxy(f"web-{state['slot']}", state["deployed"]))
    try:
        proxy_command(live, "validate", "--config", "/etc/mint-rollout/Caddyfile", "--adapter", "caddyfile")
        proxy_command(live, "reload", "--config", "/etc/mint-rollout/Caddyfile", "--adapter", "caddyfile")
        probe(live, state["deployed"], state["slot"])
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError):
        write(proxy, previous)
        proxy_command(live, "reload", "--config", "/etc/mint-rollout/Caddyfile", "--adapter", "caddyfile")
        raise
    for slot in SLOTS:
        path = ROOT / f"{slot}.json"
        if slot != state["slot"] and path.exists():
            if not maintenance_time():
                raise RuntimeError("window closed before retained-release retirement")
            compose(path, "stop", "--timeout", "60")
            compose(path, "rm", "-f")
            path.unlink()
    # The original web service is a retained fallback only during initial adoption.
    if maintenance_time():
        compose(live, "stop", "--timeout", "60", "web")


def activate(config, state, sha, maintenance, emergency=False):
    """Journal before mutation; never retry an interrupted migration automatically."""
    unmanaged = config
    old_slot = state.get("slot")
    slot = next((name for name in SLOTS if name != old_slot), "blue")
    slot_path = ROOT / f"{slot}.json"
    live = ROOT / "live.json"
    if not live.exists():
        save_compose(live, current_config())
    state["in_progress"] = {"sha": sha, "maintenance": maintenance}
    save(ROOT / "deploy-state.json", state)
    if maintenance:
        if not emergency and not maintenance_time():
            raise RuntimeError("maintenance admission window closed during preparation")
        backup(live)
        if slot_path.exists():
            # Retained releases are stopped ONLY in the maintenance window, never during normal playback.
            compose(slot_path, "stop", "--timeout", "60")
        save_compose(ROOT / "next.json", config)
        baseline = load(ROOT / "base-state.json") or current_config()
        infrastructure = [name for name, service in config["services"].items()
                          if name not in ("web", "init", "worker", "hub", "realtime", "caddy")
                          and not service.get("profiles") and service != baseline["services"].get(name)]
        if config["services"]["web"]["environment"].get("MINT_CHART_SOURCE_URL") == "http://chart-source:3090":
            infrastructure.append("chart-source")
        for name in (*infrastructure, "worker", "hub", "realtime"):
            if not emergency and not maintenance_time():
                raise RuntimeError("maintenance admission window closed; operator must inspect partial rollout")
            compose(ROOT / "next.json", "up", "-d", "--no-deps", "--wait", "--wait-timeout", WAIT, name)
    elif slot_path.exists():
        raise RuntimeError("retained slot is occupied; wait for maintenance")
    save_compose(slot_path, slot_config(config, slot))
    compose(slot_path, "up", "-d", "--no-deps", "--wait", "--wait-timeout", WAIT)
    upstream = f"web-{slot}"
    fallback = f"web-{old_slot}" if old_slot else "web"
    text = versioned_proxy(upstream, sha, fallback)
    proxy = ROOT / "proxy" / "Caddyfile"
    previous_proxy = proxy.read_text(encoding="utf-8") if proxy.exists() else None
    write(proxy, text)
    try:
        if maintenance:
            if not emergency and not maintenance_time():
                raise RuntimeError("proxy adoption requires the maintenance window")
            config = managed_proxy(config)
            save_compose(ROOT / "next.json", config)
            compose(ROOT / "next.json", "up", "-d", "--no-deps", "caddy")
            # An already-managed Caddy is not recreated, so the new routing must be loaded explicitly.
            proxy_command(ROOT / "next.json", "validate", "--config", "/etc/mint-rollout/Caddyfile",
                          "--adapter", "caddyfile")
            proxy_command(ROOT / "next.json", "reload", "--config", "/etc/mint-rollout/Caddyfile",
                          "--adapter", "caddyfile")
        else:
            config = managed_proxy(config)
            proxy_command(live, "validate", "--config", "/etc/mint-rollout/Caddyfile", "--adapter", "caddyfile")
            proxy_command(live, "reload", "--config", "/etc/mint-rollout/Caddyfile", "--adapter", "caddyfile")
        probe(ROOT / "next.json" if maintenance else live, sha, slot)
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError):
        if previous_proxy:
            write(proxy, previous_proxy)
        if maintenance:
            # Recovery belongs to the already-admitted maintenance, even if its window has elapsed.
            compose(live, "up", "-d", "--no-deps", "caddy")
            if previous_proxy and state.get("proxy_ready"):
                proxy_command(live, "reload", "--config", "/etc/mint-rollout/Caddyfile", "--adapter", "caddyfile")
        elif previous_proxy:
            proxy_command(live, "reload", "--config", "/etc/mint-rollout/Caddyfile", "--adapter", "caddyfile")
        raise
    save_compose(live, config)
    save(ROOT / "base-state.json", unmanaged)
    state.update(previous=state.get("deployed"), deployed=sha, slot=slot, proxy_ready=True,
                 deployed_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                 pending=None, last_error=None, in_progress=None)
    save(ROOT / "deploy-state.json", state)


def execute(args):
    emergency = getattr(args, "emergency", None)
    state = load(ROOT / "deploy-state.json")
    if args.status:
        log(json.dumps(state, indent=2))
        return 0
    if state.get("in_progress") or state.get("last_error"):
        raise RuntimeError("rollout needs operator inspection; see deploy-state.json and journal (no automatic retry)")
    if not emergency and not args.maintenance and maintenance_time():
        log("routine polling deferred while the maintenance lane owns the window")
        return 0
    if args.maintenance and maintenance_time() and not args.dry_run:
        retire_retained(state)
    cache = load(ROOT / "release-jobs.json")
    sha = eligible(cache)
    if not args.dry_run:
        save(ROOT / "release-jobs.json", dict(list(cache.items())[-40:]))
        state["release_gate"] = {
            "status": "ready" if sha else "blocked: no recent same-commit CI + image success",
            "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "candidate": sha,
        }
        save(ROOT / "deploy-state.json", state)
    if not sha:
        log("blocked: no recent main commit has both successful CI and published images; keeping current release")
        if emergency:
            raise RuntimeError("emergency maintenance still requires successful same-commit CI and published images")
        if not state.get("proxy_ready") and SHA.fullmatch(state.get("deployed", "")):
            # Adopting an already-running, previously gated release is not permission to deploy failed CI.
            sha = state["deployed"]
        else:
            return 0
    if sha == state.get("deployed") and state.get("proxy_ready"):
        log(f"up to date: {sha}")
        return 0
    reason = reason_for_maintenance(state.get("deployed"), sha)
    pending = state.get("pending") or {}
    if pending.get("sha") == sha and pending.get("runtime_configuration"):
        reason = "runtime configuration changed"
    if not state.get("proxy_ready"):
        reason = "one-time graceful-proxy adoption"
    next_slot = next(name for name in SLOTS if name != state.get("slot"))
    if (ROOT / f"{next_slot}.json").exists():
        reason = reason or "retained release still occupies standby slot"
    maintenance = bool(reason) or bool(emergency)
    if maintenance and not emergency and (not args.maintenance or not maintenance_time()):
        log(f"pending {sha}: {reason}; next admission 04:00-04:30 America/Chicago")
        if not args.dry_run:
            state["pending"] = {
                "sha": sha, "reason": reason,
                "runtime_configuration": pending.get("sha") == sha and bool(pending.get("runtime_configuration")),
            }
            save(ROOT / "deploy-state.json", state)
        return 0
    log(f"{'maintenance' if maintenance else 'blue/green'} candidate: {sha}")
    if args.dry_run:
        return 0
    if emergency:
        state["last_emergency"] = {
            "sha": sha, "reason": emergency, "uid": os.getuid(),
            "requested_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        save(ROOT / "deploy-state.json", state)
        log(f"EMERGENCY: downtime authorized outside the normal window: {emergency}")
    old = load(ROOT / "base-state.json") or current_config()
    try:
        config = prepare(sha, old, not maintenance)
    except MaintenanceRequired as error:
        state["pending"] = {"sha": sha, "reason": str(error), "runtime_configuration": True}
        save(ROOT / "deploy-state.json", state)
        log(f"pending {sha}: {error}; queued for maintenance")
        return 0
    try:
        activate(config, state, sha, maintenance, emergency=bool(emergency))
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as error:
        # Do not log Compose stderr: it can contain private rendered configuration.
        state["last_error"] = f"{sha}: {type(error).__name__}; inspect private operator logs"
        save(ROOT / "deploy-state.json", state)
        raise
    log(f"deployed and proxy-verified: {sha}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--maintenance", action="store_true")
    parser.add_argument("--emergency", metavar="REASON",
                        help="authorize disruptive deployment now; bypass only the clock gate, with a recorded reason")
    parser.add_argument("--check-window", action="store_true")
    args = parser.parse_args()
    if args.emergency is not None:
        if not args.emergency.strip() or len(args.emergency) > 500 or not args.emergency.isprintable():
            parser.error("--emergency requires a nonblank, single-line reason of at most 500 characters")
        if args.status or args.check_window:
            parser.error("--emergency cannot be combined with --status or --check-window")
    if args.check_window:
        return 0 if maintenance_time() else 1
    # Shared lock also protects manual invocations and the two independent systemd timers.
    import fcntl
    ROOT.mkdir(mode=0o750, parents=True, exist_ok=True)
    with (ROOT / "deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another deployment holds the lock")
            return 0
        try:
            return execute(args)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError, RuntimeError) as error:
            log(f"FAILED: {type(error).__name__}: {error}")
            return 1


if __name__ == "__main__":
    sys.exit(main())
