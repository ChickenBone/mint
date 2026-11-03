import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../docker-compose.nas.yml", import.meta.url), "utf8");
const docker = process.env.COMPOSE_DOCKER_BINARY || "docker";
const resolve = (yaml) =>
  JSON.parse(
    execFileSync(docker, ["compose", "--project-name", "mint-test", "-f", "-", "config", "--format", "json"], {
      input: yaml,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );

test("NAS template is self-contained and uses project-relative bind folders", () => {
  const config = resolve(source);
  assert.equal(Object.keys(config.services).length, 12);
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
  assert.ok(!services.caddy.command[0].includes(":80 {"));
});

test("data and media remain behind the public gateway", () => {
  const { services } = resolve(source);
  for (const name of ["cloudflared", "caddy", "web", "realtime", "hub", "worker", "postgres", "redis", "cobalt"]) {
    assert.equal(services[name].ports, undefined);
  }
  assert.equal(services.lidarr.ports[0].host_ip, "127.0.0.1");
  assert.ok(!Object.hasOwn(services.web.networks, "media"));
  assert.ok(!Object.hasOwn(services.hub.networks, "media"));
  assert.equal(services.worker.depends_on.init.condition, "service_completed_successfully");
  assert.equal(services.postgres.depends_on.init.condition, "service_completed_successfully");
});

test("Cloudflare Tunnel uses HTTP internally while public URLs remain HTTPS", () => {
  const { services } = resolve(source);
  for (const name of ["web", "realtime", "hub", "worker"]) {
    assert.equal(services[name].environment.CADDY_SCHEME, undefined);
    assert.equal(services[name].environment.MINT_DOMAIN, "mint.example.com");
  }
  assert.ok(services.caddy.command[0].includes("http://{$$MINT_DOMAIN}"));
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
