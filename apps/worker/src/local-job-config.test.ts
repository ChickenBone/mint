import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readLocalWorkerConfiguration } from "./local-job-config";
import { startLocalWorker } from "./local-job-runtime";

const prefix = "MINT_LOCAL_WORKER_";
function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries({
    ENABLED_SOURCES: '["listenbrainz"]',
    DB_HOST: "/nonexistent-mint-local-worker", DB_PORT: "5432", DB_NAME: "fixture",
    DB_USER: "fixture", DB_PASSWORD: "", DB_TLS: "disabled", DB_POOL_MAX: "2",
    DB_CONNECT_TIMEOUT_MS: "2000", MIGRATIONS_PACKAGES_ROOT: fileURLToPath(new URL("../../../packages", import.meta.url)),
    MIGRATIONS_LOCK_TIMEOUT_MS: "5000", POLLING_INTERVAL_SECONDS: "0.5",
    SUPERVISE_INTERVAL_SECONDS: "1", MAINTENANCE_INTERVAL_SECONDS: "60", SHUTDOWN_TIMEOUT_MS: "1000",
    ...overrides,
  }).map(([key, value]) => [`${prefix}${key}`, value]));
}

test("local worker is explicitly disabled without requiring database configuration", async () => {
  const config = readLocalWorkerConfiguration({ MINT_LOCAL_WORKER_ENABLED_SOURCES: "[]" });
  assert.deepEqual(config, { enabledSources: [] });
  const runtime = await startLocalWorker(config, { onError() { assert.fail("Disabled worker cannot emit runtime errors"); } });
  assert.equal(runtime.status, "disabled");
  await Promise.all([runtime.stop(), runtime.stop()]);
});

test("enabled configuration validates every resource policy before startup", async () => {
  const config = readLocalWorkerConfiguration(env());
  assert.equal(config.enabledSources[0], "listenbrainz");
  for (const patch of [
    { ENABLED_SOURCES: undefined }, { ENABLED_SOURCES: '["apple"]' },
    { ENABLED_SOURCES: '["listenbrainz","listenbrainz"]' }, { ENABLED_SOURCES: "{}" },
    { DB_PORT: "0" }, { DB_POOL_MAX: "17" }, { DB_CONNECT_TIMEOUT_MS: "2001" },
    { DB_PASSWORD: undefined }, { DB_TLS: "insecure" }, { MIGRATIONS_PACKAGES_ROOT: "relative" },
    { MIGRATIONS_LOCK_TIMEOUT_MS: "0" }, { POLLING_INTERVAL_SECONDS: "0.49" },
    { SUPERVISE_INTERVAL_SECONDS: "0" }, { MAINTENANCE_INTERVAL_SECONDS: "1.5" },
    { SHUTDOWN_TIMEOUT_MS: "999" }, { DB_PORT: " 5432" }, { DB_USER: "a\0b" },
  ]) assert.throws(() => readLocalWorkerConfiguration(env(patch)));
  if (!("database" in config)) assert.fail("Expected enabled config");
  const errors: unknown[] = [];
  await assert.rejects(startLocalWorker({
    ...config, database: { ...config.database, connectionTimeoutMillis: 2001 },
  }, { onError(error) { errors.push(error); } }), /configuration/);
  assert.deepEqual(errors, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startLocalWorker(config, { onError() {}, signal: controller.signal }), { name: "AbortError" });
});
