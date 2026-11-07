import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("OTA overlay mounts isolated storage only in web and confines permissions initialization", () => {
  const config = JSON.parse(execFileSync(process.env.COMPOSE_DOCKER_BINARY || "docker", [
    "compose", "-f", "docker-compose.yml", "-f", "docker-compose.updates.yml", "config", "--format", "json",
  ], {
    encoding: "utf8",
    env: { ...process.env, OTA_PUBLISH_TOKEN_SHA256: "a".repeat(64), OTA_SIGNING_CERTIFICATES: '{"main":"fixture-public-certificate"}' },
  }));
  const mount = config.services.web.volumes.find((volume) => volume.target === "/var/lib/mint/updates");
  assert.equal(mount.source, "ota_updates");
  assert.equal(config.services.web.environment.OTA_STORAGE_DIR, "/var/lib/mint/updates");
  assert.equal(config.services["ota-storage-init"].network_mode, "none");
  assert.equal(config.services["ota-storage-init"].user, "0:0");
  for (const name of ["worker", "hub", "realtime"]) {
    assert.equal(config.services[name].volumes.some((volume) => volume.source === "ota_updates"), false);
    assert.equal(config.services[name].environment.OTA_STORAGE_DIR, undefined);
  }
  assert.equal(config.services.web.environment.OTA_SIGNING_PRIVATE_KEY_PEM, undefined);
  assert.equal(config.services.web.environment.OTA_PUBLISH_TOKEN, undefined);
});
