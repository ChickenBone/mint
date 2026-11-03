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

test("NAS template is self-contained and only uses Docker-managed storage", () => {
  const config = resolve(source);
  assert.equal(Object.keys(config.services).length, 11);
  assert.equal(config.configs, undefined);
  for (const service of Object.values(config.services)) {
    assert.equal(service.env_file, undefined);
    assert.equal(service.build, undefined);
    for (const mount of service.volumes || []) {
      assert.equal(mount.type, "volume");
      assert.ok(config.volumes[mount.source]);
    }
  }
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
  for (const name of ["web", "realtime", "hub", "worker", "postgres", "redis", "cobalt"]) {
    assert.equal(services[name].ports, undefined);
  }
  assert.equal(services.lidarr.ports[0].host_ip, "127.0.0.1");
  assert.ok(!Object.hasOwn(services.web.networks, "media"));
  assert.ok(!Object.hasOwn(services.hub.networks, "media"));
  assert.equal(services.worker.depends_on.init.condition, "service_completed_successfully");
  assert.equal(services.postgres.depends_on.init.condition, "service_completed_successfully");
});

test("Cloudflare Tunnel can use HTTP internally while public URLs remain HTTPS", () => {
  const { services } = resolve(source.replace('&caddy-scheme "https"', '&caddy-scheme "http"'));
  assert.equal(services.caddy.environment.CADDY_SCHEME, "http");
  for (const name of ["web", "realtime", "hub", "worker"]) {
    assert.equal(services[name].environment.CADDY_SCHEME, undefined);
    assert.equal(services[name].environment.MINT_DOMAIN, "mint.example.com");
  }
  assert.ok(services.caddy.command[0].includes("CADDY_SCHEME"));
});

test("ACME retries can bypass an unreachable staging endpoint without host networking", () => {
  const directory = "https://acme-v02.api.letsencrypt.org/directory";
  const { services } = resolve(
    source.replace('&acme-retry ""', `&acme-retry "${directory}"`),
  );
  assert.equal(services.caddy.environment.ACME_RETRY_DIRECTORY, directory);
  assert.equal(services.caddy.network_mode, undefined);
  assert.ok(Object.hasOwn(services.caddy.networks, "edge"));
  assert.ok(services.caddy.command[0].includes("test_dir"));
});
