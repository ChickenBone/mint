import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../../docker-compose.nas.yml", import.meta.url), "utf8");
const docker = process.env.COMPOSE_DOCKER_BINARY || "docker";
const resolve = (yaml, env = {}) =>
  JSON.parse(
    execFileSync(docker, ["compose", "--project-name", "mint-test", "-f", "-", "config", "--format", "json"], {
      input: yaml,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    }),
  );

test("NAS template is self-contained and uses project-relative bind folders", () => {
  const config = resolve(source);
  assert.equal(Object.keys(config.services).length, 13);
  assert.equal(config.configs, undefined);
  for (const service of Object.values(config.services)) {
    assert.equal(service.env_file, undefined);
    assert.equal(service.build, undefined);
    for (const mount of service.volumes || []) {
      assert.equal(mount.type, "bind");
      assert.ok(mount.source);
    }
  }
});

test("local pipeline is enabled and existing music is mounted read-only", () => {
  const { services } = resolve(source);
  assert.equal(services.worker.environment.REMOTE_DOWNLOADS, "never");
  const original = services.worker.volumes.find((v) => v.target === "/existing-music");
  assert.equal(original.read_only, true);
  assert.equal(services.web.volumes.some((v) => v.target === "/existing-music"), false);
  assert.equal(services.init.volumes.some((v) => v.target === "/existing-music"), false);
  assert.equal(services.plex.ports[0].published, "32401");
});

test("Plex claim DNS bypass is configurable without host networking", () => {
  const { services } = resolve(source);
  assert.deepEqual(services.plex.dns, ["1.1.1.1", "8.8.8.8"]);
  assert.equal(services.plex.network_mode, undefined);
  assert.deepEqual(Object.keys(services.plex.networks), ["media"]);
  const custom = resolve(source.replace('&plex-dns ["1.1.1.1", "8.8.8.8"]', '&plex-dns ["10.0.0.1"]'));
  assert.deepEqual(custom.services.plex.dns, ["10.0.0.1"]);
});

test("migration copies explicit old volumes read-only without network or overwrites", () => {
  const migration = readFileSync(new URL("../../docker-compose.nas-migrate.yml", import.meta.url), "utf8");
  const config = resolve(migration);
  const copy = config.services.copy;
  assert.equal(copy.network_mode, "none");
  assert.equal(copy.restart, "no");
  assert.equal(copy.volumes.filter((mount) => mount.type === "volume" && mount.read_only).length, 10);
  assert.equal(copy.volumes.filter((mount) => mount.type === "bind").length, 1);
  for (const volume of Object.values(config.volumes)) assert.equal(volume.external, true);
  assert.ok(copy.command[0].includes("Refusing to overwrite"));
  assert.ok(copy.command[0].includes("cp -a"));
  assert.ok(!copy.command[0].includes("rm "));
});

test("one hostname edit reaches every public URL without exposing media keys to the hub", () => {
  const { services } = resolve(source.replace('"mint.example.com"', '"music.example.net"'));
  for (const name of ["init", "caddy", "web", "realtime", "hub", "worker"]) {
    assert.equal(services[name].environment.MINT_DOMAIN, "music.example.net");
  }
  for (const key of ["GOOGLE_CLIENT_SECRET", "TORBOX_API_KEY", "PLEX_CLAIM"]) {
    assert.equal(services.hub.environment[key], undefined);
  }
  assert.ok(services.caddy.command[0].includes("MINT_DOMAIN"));
  assert.ok(services.caddy.command[0].includes(":80 {"));
  assert.ok(services.caddy.command[0].includes("header_up Host {$$MINT_DOMAIN}"));
  assert.ok(services.caddy.command[0].includes("header_up X-Forwarded-Host {$$MINT_DOMAIN}"));
});

test("data and media remain behind the public gateway", () => {
  const { services } = resolve(source);
  for (const name of ["cloudflared", "caddy", "web", "realtime", "hub", "worker", "postgres", "redis", "cobalt"]) {
    assert.equal(services[name].ports, undefined);
  }
  assert.equal(services.lidarr.ports[0].host_ip, "127.0.0.1");
  assert.equal(services.prowlarr.ports[0].host_ip, "127.0.0.1");
  assert.deepEqual(Object.keys(services.prowlarr.networks), ["media"]);
  assert.ok(!Object.hasOwn(services.web.networks, "media"));
  assert.ok(!Object.hasOwn(services.hub.networks, "media"));
  assert.equal(services.worker.depends_on.init.condition, "service_completed_successfully");
  assert.equal(services.web.environment.PLAYBACK_WORKER_URL, "http://worker:8080");
  assert.deepEqual(Object.keys(services.web.networks), ["data", "edge"]);
  assert.equal(services.postgres.depends_on.init.condition, "service_completed_successfully");
});

test("Prowlarr auto-setup is private, persistent and configurable", () => {
  const { services } = resolve(source);
  assert.equal(services.worker.environment.PROWLARR_URL, "http://prowlarr:9696");
  assert.equal(services.worker.environment.AUTO_CONFIGURE_INDEXERS, "true");
  assert.equal(services.worker.environment.BLACKHOLE_NZB_DIR, "/blackhole/nzbs");
  assert.equal(services.worker.environment.BLACKHOLE_NZB_DOWNLOAD_DIR, "/blackhole/usenet-downloads");
  const configMount = services.prowlarr.volumes.find((v) => v.target === "/config");
  const workerMount = services.worker.volumes.find((v) => v.target === "/prowlarr-config");
  assert.equal(configMount.source, workerMount.source);
  assert.equal(workerMount.read_only, true);
  for (const name of ["web", "hub", "realtime", "cloudflared"]) {
    assert.equal(services[name].volumes?.some((v) => v.target === "/prowlarr-config") ?? false, false);
    for (const key of ["PROWLARR_API_KEY", "USENET_INDEXER_API_KEY"]) assert.equal(services[name].environment?.[key], undefined);
  }
  const disabled = resolve(source.replace('&auto-indexers "true"', '&auto-indexers "false"'));
  assert.equal(disabled.services.worker.environment.AUTO_CONFIGURE_INDEXERS, "false");
});

test("CLI stack does not leak media credentials from shared env-file into public services", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mint-compose-test-"));
  try {
    const file = path.join(root, "fixture.env");
    const composePath = docker.endsWith(".exe") && process.platform !== "win32"
      ? execFileSync("wslpath", ["-w", file], { encoding: "utf8" }).trim()
      : file;
    const keys = ["TORBOX_API_KEY", "PLEX_TOKEN", "PLEX_CLAIM", "LIDARR_API_KEY", "PROWLARR_API_KEY", "USENET_INDEXER_API_KEY", "ANALYSIS_WORKER_TOKEN"];
    const spotifyKeys = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"];
    writeFileSync(file, [...keys, ...spotifyKeys].map((key) => `${key}=fixture-only`).join("\n"));
    const yaml = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8").replace("path: .env", `path: ${JSON.stringify(composePath)}`);
    const { services } = resolve(yaml, Object.fromEntries(spotifyKeys.map((key) => [key, "fixture-only"])));
    for (const key of keys) {
      assert.equal(services.worker.environment[key], "fixture-only");
      for (const name of ["web", "hub", "realtime"]) assert.equal(services[name].environment[key], "");
    }
    for (const key of spotifyKeys) {
      assert.equal(services.worker.environment[key], "fixture-only");
      assert.equal(services.web.environment[key], "fixture-only");
      for (const name of ["hub", "realtime"]) assert.equal(services[name].environment[key], "");
    }
    assert.equal(services.worker.volumes.find((v) => v.target === "/prowlarr-config").read_only, true);
    assert.deepEqual(Object.keys(services.prowlarr.networks), ["media"]);
    assert.equal(services.prowlarr.ports[0].host_ip, "127.0.0.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NAS Spotify credentials reach only web and the pipeline worker", () => {
  const { services } = resolve(source.replace('&spotify-id ""', '&spotify-id "fixture-only"').replace('&spotify-secret ""', '&spotify-secret "fixture-only"'));
  for (const [name, service] of Object.entries(services)) {
    for (const key of ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]) {
      assert.equal(service.environment?.[key], ["web", "worker"].includes(name) ? "fixture-only" : undefined);
    }
  }
});

test("Cloudflare Tunnel uses HTTP internally while public URLs remain HTTPS", () => {
  const { services } = resolve(source);
  for (const name of ["web", "realtime", "hub", "worker"]) {
    assert.equal(services[name].environment.CADDY_SCHEME, undefined);
    assert.equal(services[name].environment.MINT_DOMAIN, "mint.example.com");
  }
  assert.ok(services.caddy.command[0].includes(":80 {"));
  assert.ok(!services.caddy.command[0].includes("http://{$$MINT_DOMAIN}"));
  assert.ok(!services.caddy.command[0].includes("cert_issuer"));
});

test("only the tunnel connector receives its token and cannot reach data or media", () => {
  const { services } = resolve(source.replace('&tunnel-token ""', '&tunnel-token "demo-not-a-real-token"'));
  assert.equal(services.cloudflared.environment.TUNNEL_TOKEN, "demo-not-a-real-token");
  for (const [name, service] of Object.entries(services)) {
    if (name !== "cloudflared") assert.equal(service.environment?.TUNNEL_TOKEN, undefined);
  }
  assert.deepEqual(Object.keys(services.cloudflared.networks), ["edge"]);
  assert.equal(services.cloudflared.network_mode, undefined);
  assert.deepEqual(services.cloudflared.command, ["tunnel", "--no-autoupdate", "--protocol", "http2", "run"]);
  assert.equal(services.cloudflared.read_only, true);
  assert.equal(services.cloudflared.depends_on.caddy.condition, "service_started");
});
