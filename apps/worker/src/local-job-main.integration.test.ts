import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);
const workerRoot = fileURLToPath(new URL("../", import.meta.url));
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const tsx = path.join(workerRoot, "node_modules/tsx/dist/loader.mjs");
// Set to dist/local-job-main.js after build:local to exercise the compiled entrypoint.
const main = process.env.MINT_TEST_LOCAL_WORKER_MAIN
  ? path.resolve(workerRoot, process.env.MINT_TEST_LOCAL_WORKER_MAIN)
  : fileURLToPath(new URL("./local-job-main.ts", import.meta.url));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("Expected standalone worker process state was not observed.");
}
function launch(env: Record<string, string | undefined>, cwd = workerRoot) {
  const child = spawn(process.execPath, ["--import", tsx, main], {
    cwd, env: { NODE_ENV: process.env.NODE_ENV, ...Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith("MINT_LOCAL_WORKER_")).concat(Object.entries(env))) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { child, stdout: "", stderr: "" };
  child.stdout!.on("data", (chunk: Buffer) => { output.stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { output.stderr += chunk.toString(); });
  return output;
}
async function exited(child: ChildProcess) {
  await until(() => child.exitCode !== null || child.signalCode !== null);
  return child.exitCode;
}

test("standalone disabled and invalid configuration exit without resources or secret output", async () => {
  const disabled = launch({ MINT_LOCAL_WORKER_ENABLED_SOURCES: "[]" });
  assert.equal(await exited(disabled.child), 0);
  assert.match(disabled.stdout, /local-worker-disabled/);
  const invalid = launch({ MINT_LOCAL_WORKER_ENABLED_SOURCES: '["private-secret-source"]' });
  assert.equal(await exited(invalid.child), 1);
  assert.match(invalid.stderr, /local-worker-startup-failed/);
  assert.doesNotMatch(invalid.stderr + invalid.stdout, /private-secret-source/);
});

test("standalone worker migrates before scheduling and handles repeated/startup signals on PostgreSQL16", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) { t.skip("Set MINT_TEST_POSTGRES_BIN to PostgreSQL16 binaries"); return; }
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-local-main-pg-"));
  const socket = path.join(cluster, "sock");
  const data = path.join(cluster, "data");
  const pgEnv = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture", PGSERVICE: "", PGSERVICEFILE: "" };
  const observer = new pg.Pool({ host: socket, user: "fixture", database: "postgres", connectionTimeoutMillis: 2000 });
  const processes: ChildProcess[] = [];
  let started = false;
  let lock: pg.PoolClient | undefined;
  let blocker: pg.PoolClient | undefined;
  const env = {
    MINT_LOCAL_WORKER_ENABLED_SOURCES: '["listenbrainz"]',
    MINT_LOCAL_WORKER_DB_HOST: socket, MINT_LOCAL_WORKER_DB_PORT: "5432",
    MINT_LOCAL_WORKER_DB_NAME: "postgres", MINT_LOCAL_WORKER_DB_USER: "fixture",
    MINT_LOCAL_WORKER_DB_PASSWORD: "private-db-password", MINT_LOCAL_WORKER_DB_TLS: "disabled",
    MINT_LOCAL_WORKER_DB_POOL_MAX: "2", MINT_LOCAL_WORKER_DB_CONNECT_TIMEOUT_MS: "2000",
    MINT_LOCAL_WORKER_MIGRATIONS_PACKAGES_ROOT: packagesRoot, MINT_LOCAL_WORKER_MIGRATIONS_LOCK_TIMEOUT_MS: "5000",
    MINT_LOCAL_WORKER_POLLING_INTERVAL_SECONDS: "0.5", MINT_LOCAL_WORKER_SUPERVISE_INTERVAL_SECONDS: "1",
    MINT_LOCAL_WORKER_MAINTENANCE_INTERVAL_SECONDS: "60", MINT_LOCAL_WORKER_SHUTDOWN_TIMEOUT_MS: "1000",
  };
  const connections = async () => Number((await observer.query(
    "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'mint-local-worker'",
  )).rows[0].count);
  function start(overrides: Record<string, string | undefined> = {}) {
    const output = launch({ ...env, ...overrides }, cluster);
    processes.push(output.child);
    return output;
  }
  async function waiting() {
    await until(async () => (await observer.query(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='mint-local-worker' AND wait_event='advisory') AS waiting",
    )).rows[0].waiting);
  }
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env: pgEnv });
    await exec(path.join(bin, "pg_ctl"), ["-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start"], { env: pgEnv });
    started = true;
    lock = await observer.connect();
    await lock.query("SELECT pg_advisory_lock($1::integer,$2::integer)", [0x4d494e54, 0x4d494752]);
    const interrupted = start();
    await waiting();
    interrupted.child.kill("SIGTERM");
    interrupted.child.kill("SIGINT");
    await lock.query("SELECT pg_advisory_unlock($1::integer,$2::integer)", [0x4d494e54, 0x4d494752]);
    lock.release();
    lock = undefined;
    assert.equal(await exited(interrupted.child), 0);
    assert.doesNotMatch(interrupted.stdout, /local-worker-running/);
    assert.equal(await connections(), 0);
    assert.equal(Number((await observer.query("SELECT count(*) FROM catalog.startup_seed_receipts")).rows[0].count), 0);

    // A preexisting durable receipt prevents any live provider request in this process test.
    await observer.query("INSERT INTO catalog.startup_seed_receipts(key) VALUES ('catalog:startup:lb-chart:global')");
    for (let i = 0; i < 2; i++) {
      const running = start();
      await until(() => running.stdout.includes("local-worker-running"));
      assert.equal(Number((await observer.query("SELECT count(*) FROM mint_migrations.__drizzle_migrations")).rows[0].count), 9);
      assert.equal(Number((await observer.query("SELECT count(*) FROM mint_jobs.job")).rows[0].count), 0);
      running.child.kill("SIGTERM");
      running.child.kill("SIGTERM");
      assert.equal(await exited(running.child), 0);
      assert.match(running.stdout, /local-worker-stopped/);
      assert.doesNotMatch(running.stderr + running.stdout, /private-db-password/);
      assert.equal(await connections(), 0);
    }
    // An uncommitted same-key receipt blocks seed scheduling; the blocker stays held throughout.
    await observer.query("DELETE FROM catalog.startup_seed_receipts");
    blocker = await observer.connect();
    await blocker.query("BEGIN");
    await blocker.query("INSERT INTO catalog.startup_seed_receipts(key) VALUES ('catalog:startup:lb-chart:global')");
    const blockedState = async () => {
      assert.equal(Number((await observer.query("SELECT count(*) FROM catalog.startup_seed_receipts")).rows[0].count), 0);
      assert.equal(Number((await observer.query("SELECT count(*) FROM mint_jobs.job")).rows[0].count), 0);
    };
    const lockWaiting = () => until(async () => (await observer.query(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='mint-local-worker' AND wait_event_type='Lock') AS waiting",
    )).rows[0].waiting);

    const signalled = start();
    await lockWaiting();
    const signalledAt = Date.now();
    signalled.child.kill("SIGTERM");
    assert.equal(await exited(signalled.child), 0);
    assert.ok(Date.now() - signalledAt < 3000, "blocked seed scheduling must stop within 3000ms of SIGTERM");
    assert.match(signalled.stdout, /local-worker-stopped/);
    assert.doesNotMatch(signalled.stdout, /local-worker-running/);
    await until(async () => await connections() === 0);
    assert.ok(Date.now() - signalledAt < 3000, "owned sessions must drain within 3000ms of SIGTERM");
    t.diagnostic(`blocked SIGTERM exit+drain ${Date.now() - signalledAt}ms`);
    await blockedState();

    // Without a signal the server-side lock timeout fails startup explicitly instead of hanging.
    const timedOut = start();
    await lockWaiting();
    const waitedAt = Date.now();
    assert.equal(await exited(timedOut.child), 1);
    assert.ok(Date.now() - waitedAt < 5000, "blocked seed scheduling must fail within its lock bound");
    t.diagnostic(`blocked lock-timeout failure ${Date.now() - waitedAt}ms`);
    assert.match(timedOut.stderr, /local-worker-startup-failed/);
    assert.match(timedOut.stderr, /seed-scheduling/);
    assert.doesNotMatch(timedOut.stderr + timedOut.stdout, /private-db-password/);
    assert.equal(await connections(), 0);
    await blockedState();
    await blocker.query("ROLLBACK");
    blocker.release();
    blocker = undefined;

    const failed = start({ MINT_LOCAL_WORKER_MIGRATIONS_PACKAGES_ROOT: path.join(cluster, "missing") });
    assert.equal(await exited(failed.child), 1);
    assert.match(failed.stderr, /local-worker-startup-failed/);
    assert.equal(await connections(), 0);
  } finally {
    if (lock) {
      await lock.query("SELECT pg_advisory_unlock($1::integer,$2::integer)", [0x4d494e54, 0x4d494752]);
      lock.release();
    }
    if (blocker) {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited(child);
      }
    }
    await observer.end();
    if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env: pgEnv });
    await rm(cluster, { recursive: true, force: true });
  }
});
