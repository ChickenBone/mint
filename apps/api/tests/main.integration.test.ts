import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { argon2Passwords } from "@mint/domain-accounts";
import { createMintSdk } from "@mint/sdk";
import pg from "pg";
import { readRuntimeConfiguration } from "../src/runtime-config";

const exec = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packagesRoot = path.join(repoRoot, "packages");
const tsx = path.join(apiRoot, "node_modules/tsx/dist/loader.mjs");
const main = path.join(apiRoot, "src/main.ts");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("bootstrap configuration is optional, all-or-none and validates without exposing values", () => {
  const env = {
    MINT_API_DB_HOST: "localhost", MINT_API_DB_PORT: "5432", MINT_API_DB_NAME: "fixture",
    MINT_API_DB_USER: "fixture", MINT_API_DB_PASSWORD: "", MINT_API_DB_TLS: "disabled",
    MINT_API_DB_POOL_MAX: "2", MINT_API_DB_CONNECT_TIMEOUT_MS: "2000",
    MINT_API_MIGRATIONS_PACKAGES_ROOT: packagesRoot, MINT_API_MIGRATIONS_LOCK_TIMEOUT_MS: "5000",
    MINT_API_LISTEN_HOST: "127.0.0.1", MINT_API_LISTEN_PORT: "0",
    MINT_API_GATEWAY_TOKEN: randomBytes(32).toString("base64url"), MINT_API_NOTIFICATION_SINK: "stdout",
  };
  assert.equal(readRuntimeConfiguration(env).adminBootstrap, undefined);
  assert.equal(readRuntimeConfiguration(env).publicAuthProxy, undefined);
  assert.equal(readRuntimeConfiguration({ ...env, MINT_API_PUBLIC_AUTH_PROXY: "gateway" }).publicAuthProxy, "gateway");
  for (const value of ["", "true", "*", "x-forwarded-for"]) {
    assert.throws(() => readRuntimeConfiguration({ ...env, MINT_API_PUBLIC_AUTH_PROXY: value }), /MINT_API_PUBLIC_AUTH_PROXY/);
  }
  const credentials = {
    MINT_API_BOOTSTRAP_ADMIN_EMAIL: "Seed@fixture.test",
    MINT_API_BOOTSTRAP_ADMIN_NAME: "Fixture Admin",
    MINT_API_BOOTSTRAP_ADMIN_PASSWORD: " exact password ",
  };
  assert.deepEqual(readRuntimeConfiguration({ ...env, ...credentials }).adminBootstrap, {
    email: credentials.MINT_API_BOOTSTRAP_ADMIN_EMAIL,
    name: credentials.MINT_API_BOOTSTRAP_ADMIN_NAME,
    password: credentials.MINT_API_BOOTSTRAP_ADMIN_PASSWORD,
  });
  const keys = Object.keys(credentials);
  for (let mask = 1; mask < 7; mask++) {
    const partial = Object.fromEntries(keys.filter((_, i) => mask & (1 << i)).map((key) => [key, "fixture-secret"]));
    assert.throws(() => readRuntimeConfiguration({ ...env, ...partial }), (error) =>
      error instanceof Error && !error.message.includes("fixture-secret"));
  }
  for (const invalid of [
    { MINT_API_BOOTSTRAP_ADMIN_EMAIL: "" }, { MINT_API_BOOTSTRAP_ADMIN_EMAIL: "not-an-email" },
    { MINT_API_BOOTSTRAP_ADMIN_NAME: "" }, { MINT_API_BOOTSTRAP_ADMIN_NAME: " " },
    { MINT_API_BOOTSTRAP_ADMIN_NAME: "x".repeat(81) }, { MINT_API_BOOTSTRAP_ADMIN_PASSWORD: "" },
    { MINT_API_BOOTSTRAP_ADMIN_PASSWORD: "x".repeat(201) }, { MINT_API_BOOTSTRAP_ADMIN_PASSWORD: "secret\0value" },
  ]) {
    assert.throws(() => readRuntimeConfiguration({ ...env, ...credentials, ...invalid }));
  }
});

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for fixture state");
}

test("standalone process migrates before listening, authenticates and releases resources", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) { t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries"); return; }
  assert.ok(path.isAbsolute(bin));
  const cluster = path.join(repoRoot, `.api-pg-${randomBytes(6).toString("hex")}`);
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "sock");
  const database = { host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 2, connectionTimeoutMillis: 2000, ssl: false as const };
  const observer = new pg.Pool(database);
  const gateway = randomBytes(32).toString("base64url");
  const password = "fixture-secret-password";
  const bootstrapPassword = "fixture-bootstrap-secret";
  const replacementPassword = "fixture-replacement-secret";
  const processes = new Set<ChildProcess>();
  const output: { stdout: string; stderr: string; child: ChildProcess }[] = [];
  let started = false;
  let lock: pg.PoolClient | undefined;
  const pgEnv = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture", PGSERVICE: "", PGSERVICEFILE: "" };
  const countConnections = async () => Number((await observer.query(
    "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'mint-api-runtime'",
  )).rows[0].count);
  const launch = (overrides: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, MINT_API_DB_HOST: socket, MINT_API_DB_PORT: "5432", MINT_API_DB_NAME: "postgres",
      MINT_API_DB_USER: "fixture", MINT_API_DB_PASSWORD: password, MINT_API_DB_TLS: "disabled",
      MINT_API_DB_POOL_MAX: "2", MINT_API_DB_CONNECT_TIMEOUT_MS: "2000",
      MINT_API_MIGRATIONS_PACKAGES_ROOT: packagesRoot, MINT_API_MIGRATIONS_LOCK_TIMEOUT_MS: "5000",
      MINT_API_LISTEN_HOST: "127.0.0.1", MINT_API_LISTEN_PORT: String(port),
      MINT_API_GATEWAY_TOKEN: gateway, MINT_API_NOTIFICATION_SINK: "stdout",
      MINT_API_BOOTSTRAP_ADMIN_EMAIL: "admin@fixture.test", MINT_API_BOOTSTRAP_ADMIN_NAME: "Admin",
      MINT_API_BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword, ...overrides,
    };
    const child = spawn(process.execPath, ["--import", tsx, main], { cwd: cluster, env, stdio: ["ignore", "pipe", "pipe"] });
    const result = { stdout: "", stderr: "", child };
    output.push(result);
    processes.add(child);
    child.stdout!.on("data", (chunk: Buffer) => { result.stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { result.stderr += chunk.toString(); });
    child.once("exit", () => processes.delete(child));
    return result;
  };
  const exited = async (child: ChildProcess) => {
    await until(() => child.exitCode !== null || child.signalCode !== null);
    return child.exitCode;
  };
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => reservation.once("error", reject).listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved !== "string");
  const port = reserved.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const address = `http://127.0.0.1:${port}`;
  try {
    await mkdir(socket, { recursive: true });
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env: pgEnv });
    await exec(path.join(bin, "pg_ctl"), ["-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start"], { env: pgEnv });
    started = true;
    assert.match((await observer.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await observer.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    lock = await observer.connect();
    await lock.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [0x4d494e54, 0x4d494752]);
    const first = launch();
    await until(async () => (await observer.query(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'mint-api-runtime' AND wait_event = 'advisory') AS waiting",
    )).rows[0].waiting);
    assert.doesNotMatch(first.stdout, /api-listening/);
    await assert.rejects(fetch(`${address}/trpc/accounts.session`));
    await lock.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [0x4d494e54, 0x4d494752]);
    lock.release();
    lock = undefined;
    await until(() => first.stdout.includes('"event":"api-listening"'));
    const files = ["platform/migrations/0000_rate_limits.sql", "domain-accounts/migrations/0000_accounts.sql",
      "domain-catalog/migrations/0000_recordings.sql", "domain-library/migrations/0000_library_identity.sql",
      "domain-library/migrations/0001_library_listing.sql", "platform/migrations/0001_events.sql",
      "platform/migrations/0002_public_read_cache.sql", "domain-catalog/migrations/0001_startup_seed_receipts.sql",
      "domain-catalog/migrations/0002_listenbrainz_seed_ingestion.sql",
      "domain-playback/migrations/0000_listening_history.sql"];
    assert.deepEqual((await observer.query("SELECT hash FROM mint_migrations.__drizzle_migrations ORDER BY id")).rows.map((row) => row.hash),
      await Promise.all(files.map(async (file) => hash(await readFile(path.join(packagesRoot, file))))));
    assert.equal((await fetch(`${address}/trpc/accounts.session`)).status, 401);
    assert.equal((await fetch(`${address}/trpc/accounts.session`, { headers: { "x-mint-gateway-token": randomBytes(32).toString("base64url") } })).status, 401);
    const before = (await observer.query("SELECT * FROM accounts.users")).rows;
    assert.equal(before.length, 1);
    const bootstrapped = before[0];
    assert.ok(bootstrapped.approved_at instanceof Date);
    assert.equal(bootstrapped.approved_by, null);
    assert.equal(await argon2Passwords.verify(bootstrapped.password_hash, bootstrapPassword), true);
    const admin = { id: bootstrapped.id, email: bootstrapped.email, name: bootstrapped.name, role: bootstrapped.role, status: bootstrapped.status };
    assert.equal(admin.role, "admin");
    assert.equal(admin.status, "active");
    const pending = (await observer.query<{ id: string }>(
      `INSERT INTO accounts.users (email, name, password_hash, role, status) VALUES
       ('pending@fixture.test', 'Pending', 'fixture', 'user', 'pending') RETURNING id`)).rows[0];
    assert.ok(admin && pending);
    const session = randomBytes(32).toString("base64url");
    await observer.query("INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [hash(session), admin.id]);
    const sdk = createMintSdk({ url: `${address}/trpc`, gatewayToken: gateway, sessionToken: session });
    assert.deepEqual(await sdk.accounts.session(), admin);
    assert.equal(await createMintSdk({ url: `${address}/trpc`, gatewayToken: gateway }).accounts.session(), null);
    await sdk.accounts.decideAccessRequest({ userId: pending.id, approve: true });
    await until(() => first.stdout.includes('"event":"access-requests-pending","pending":0'));
    first.child.kill("SIGTERM");
    first.child.kill("SIGTERM");
    assert.equal(await exited(first.child), 0);
    await assert.rejects(fetch(`${address}/trpc/accounts.session`));
    assert.equal(await countConnections(), 0);

    for (const invalid of [
      { MINT_API_GATEWAY_TOKEN: undefined }, { MINT_API_NOTIFICATION_SINK: undefined },
      { MINT_API_DB_PASSWORD: undefined }, { MINT_API_DB_TLS: "insecure" },
      { MINT_API_DB_POOL_MAX: "0" }, { MINT_API_MIGRATIONS_PACKAGES_ROOT: "relative" },
      { MINT_API_BOOTSTRAP_ADMIN_EMAIL: undefined }, { MINT_API_BOOTSTRAP_ADMIN_NAME: undefined },
      { MINT_API_BOOTSTRAP_ADMIN_PASSWORD: undefined }, { MINT_API_BOOTSTRAP_ADMIN_PASSWORD: "" },
      { MINT_API_BOOTSTRAP_ADMIN_EMAIL: "invalid" },
    ]) {
      const failed = launch(invalid);
      assert.equal(await exited(failed.child), 1);
      assert.doesNotMatch(failed.stdout, /api-listening/);
      await assert.rejects(fetch(`${address}/trpc/accounts.session`));
      assert.equal(await countConnections(), 0);
    }
    const migrationFailure = launch({ MINT_API_MIGRATIONS_PACKAGES_ROOT: path.join(cluster, "missing") });
    assert.equal(await exited(migrationFailure.child), 1);
    assert.doesNotMatch(migrationFailure.stdout, /api-listening/);
    assert.equal(await countConnections(), 0);
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => occupied.once("error", reject).listen(port, "127.0.0.1", resolve));
    try {
      const bindFailure = launch();
      assert.equal(await exited(bindFailure.child), 1);
      assert.doesNotMatch(bindFailure.stdout, /api-listening/);
      assert.equal(await countConnections(), 0);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
    const second = launch({
      MINT_API_DB_PASSWORD: "", MINT_API_BOOTSTRAP_ADMIN_EMAIL: "ADMIN@fixture.test",
      MINT_API_BOOTSTRAP_ADMIN_NAME: "Must not replace", MINT_API_BOOTSTRAP_ADMIN_PASSWORD: replacementPassword,
    });
    await until(() => second.stdout.includes('"event":"api-listening"'));
    assert.deepEqual((await observer.query("SELECT * FROM accounts.users WHERE id = $1", [admin.id])).rows, before);
    assert.equal(await argon2Passwords.verify(bootstrapped.password_hash, replacementPassword), false);
    assert.deepEqual(await sdk.accounts.session(), admin);
    second.child.kill("SIGINT");
    second.child.kill("SIGINT");
    assert.equal(await exited(second.child), 0);
    await assert.rejects(fetch(`${address}/trpc/accounts.session`));
    assert.equal(await countConnections(), 0);
    const unconfigured = launch({
      MINT_API_BOOTSTRAP_ADMIN_EMAIL: undefined, MINT_API_BOOTSTRAP_ADMIN_NAME: undefined,
      MINT_API_BOOTSTRAP_ADMIN_PASSWORD: undefined,
    });
    await until(() => unconfigured.stdout.includes('"event":"api-listening"'));
    assert.equal(Number((await observer.query("SELECT count(*) FROM accounts.users")).rows[0].count), 2);
    unconfigured.child.kill("SIGTERM");
    assert.equal(await exited(unconfigured.child), 0);
    assert.equal(await countConnections(), 0);
    for (const result of output) {
      for (const secret of [gateway, password, bootstrapPassword, replacementPassword, bootstrapped.password_hash, session, cluster, packagesRoot]) {
        assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
      }
    }
  } finally {
    if (lock) {
      await lock.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [0x4d494e54, 0x4d494752]);
      lock.release();
    }
    for (const child of processes) child.kill("SIGTERM");
    for (const child of processes) {
      try { await exited(child); } catch { child.kill("SIGKILL"); await exited(child); }
    }
    await observer.end();
    if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env: pgEnv });
    await rm(cluster, { recursive: true, force: true });
  }
});
