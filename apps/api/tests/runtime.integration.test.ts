import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import pg from "pg";
import { startApiRuntime, type ApiRuntimeOptions } from "../src/index";

const exec = promisify(execFile);
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("SDK over HTTP uses migrated PostgreSQL accounts and cleans up runtime resources", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-api-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "sock");
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture" };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  const database = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 2, connectionTimeoutMillis: 2000, ssl: false as const,
  };
  const observer = new pg.Pool(database);
  const notifications: number[] = [];
  const logged: string[] = [];
  const token = randomBytes(32).toString("base64url");
  const options: ApiRuntimeOptions = {
    database,
    migrations: { packagesRoot, lockTimeoutMs: 5000 },
    listen: { host: "127.0.0.1", port: 0 },
    gatewayToken: token,
    notifyAccessRequests: async ({ pending }) => { notifications.push(pending); },
    errors: { error: ({ name }) => { logged.push(name); } },
  };
  let started = false;
  let runtime: Awaited<ReturnType<typeof startApiRuntime>> | undefined;
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start",
    ], { env });
    started = true;
    assert.match((await observer.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await observer.query("SHOW listen_addresses")).rows[0].listen_addresses, "");

    // Holding the shared migration lock proves the listener is not opened early.
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const reservedAddress = reservation.address();
    assert.ok(reservedAddress && typeof reservedAddress !== "string");
    const port = reservedAddress.port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const lock = await observer.connect();
    let starting: Promise<Awaited<ReturnType<typeof startApiRuntime>>> | undefined;
    let gateError: unknown;
    try {
      await lock.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [0x4d494e54, 0x4d494752]);
      starting = startApiRuntime({ ...options, listen: { host: "127.0.0.1", port } });
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        waiting = (await observer.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'mint-api-runtime' AND wait_event = 'advisory') AS waiting",
        )).rows[0].waiting;
        if (waiting) break;
        await delay(20);
      }
      assert.equal(waiting, true);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/trpc/accounts.session`));
    } catch (error) {
      gateError = error;
    } finally {
      await lock.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [0x4d494e54, 0x4d494752]);
      lock.release();
    }
    if (!starting) throw gateError ?? new Error("Runtime startup was not initiated");
    runtime = await starting;
    if (gateError) throw gateError;
    const address = runtime.address;
    const paths = [
      "platform/migrations/0000_rate_limits.sql", "domain-accounts/migrations/0000_accounts.sql",
      "domain-catalog/migrations/0000_recordings.sql", "domain-library/migrations/0000_library_identity.sql",
      "domain-library/migrations/0001_library_listing.sql",
    ];
    const expected = await Promise.all(paths.map(async (p) => hash(await readFile(path.join(packagesRoot, p)))));
    assert.deepEqual((await observer.query(
      "SELECT hash FROM mint_migrations.__drizzle_migrations ORDER BY id",
    )).rows.map((row) => row.hash), expected);

    const users = await observer.query<{ id: string; email: string; name: string; role: string; status: string }>(
      `INSERT INTO accounts.users (email, name, password_hash, role, status) VALUES
       ('admin@fixture.test', 'Admin', 'fixture', 'admin', 'active'),
       ('member@fixture.test', 'Member', 'fixture', 'user', 'active'),
       ('pending@fixture.test', 'Pending', 'fixture', 'user', 'pending') RETURNING id, email, name, role, status`,
    );
    const [admin, member, pending] = users.rows;
    assert.ok(admin && member && pending);
    const adminToken = randomBytes(32).toString("base64url");
    const memberToken = randomBytes(32).toString("base64url");
    await observer.query(
      "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days'), ($3, $4, now() + interval '30 days')",
      [hash(adminToken), admin.id, hash(memberToken), member.id],
    );
    const sdk = (sessionToken: string) => createMintSdk({ url: `${address}/trpc`, gatewayToken: token, sessionToken });
    assert.deepEqual(await sdk(memberToken).accounts.session(), member);
    await assert.rejects(sdk(memberToken).accounts.decideAccessRequest({ userId: pending.id, approve: true }), MintSdkError);
    assert.equal((await observer.query("SELECT status FROM accounts.users WHERE id = $1", [pending.id])).rows[0].status, "pending");
    await sdk(adminToken).accounts.decideAccessRequest({ userId: pending.id, approve: true });
    const approved = (await observer.query("SELECT status, approved_by, approved_at FROM accounts.users WHERE id = $1", [pending.id])).rows[0];
    assert.equal(approved.status, "active");
    assert.equal(approved.approved_by, admin.id);
    assert.ok(approved.approved_at instanceof Date);
    assert.deepEqual(notifications, [0]);
    const headers: Record<string, string>[] = [{}, { "x-mint-gateway-token": randomBytes(32).toString("base64url") }];
    for (const header of headers) {
      assert.equal((await fetch(`${address}/trpc/accounts.session`, { headers: header })).status, 401);
    }
    await observer.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'mint-api-runtime' AND state = 'idle'",
    );
    for (let i = 0; i < 100 && !logged.includes("PostgresPoolError"); i++) await delay(20);
    assert.deepEqual(logged, ["PostgresPoolError"]);
    assert.deepEqual(await sdk(memberToken).accounts.session(), member);
    await observer.query("DELETE FROM accounts.sessions WHERE id = $1", [hash(memberToken)]);
    assert.equal(await sdk(memberToken).accounts.session(), null);
    await Promise.all([runtime.stop(), runtime.stop()]);
    runtime = undefined;
    await assert.rejects(fetch(`${address}/trpc/accounts.session`));
    const activeConnections = async () => Number((await observer.query(
      "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'mint-api-runtime'",
    )).rows[0].count);
    assert.equal(await activeConnections(), 0);

    await assert.rejects(startApiRuntime({
      ...options, migrations: { ...options.migrations, packagesRoot: path.join(cluster, "missing") },
    }), /startup failed during migrations/);
    assert.equal(await activeConnections(), 0);
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    try {
      const occupiedAddress = occupied.address();
      assert.ok(occupiedAddress && typeof occupiedAddress !== "string");
      await assert.rejects(startApiRuntime({
        ...options, listen: { host: "127.0.0.1", port: occupiedAddress.port },
      }), /startup failed during listen/);
      assert.equal(await activeConnections(), 0);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
    assert.deepEqual(logged, ["PostgresPoolError", "ApiStartupError", "ApiStartupError"]);
  } finally {
    try {
      await runtime?.stop();
    } finally {
      await observer.end();
      if (started) {
        await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
        await rm(cluster, { recursive: true, force: true });
      }
    }
  }
});
