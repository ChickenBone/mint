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
import { argon2Passwords } from "@mint/domain-accounts";
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
      "platform/migrations/0001_events.sql", "platform/migrations/0002_public_read_cache.sql",
      "domain-catalog/migrations/0001_startup_seed_receipts.sql",
      "domain-catalog/migrations/0002_listenbrainz_seed_ingestion.sql",
      "domain-playback/migrations/0000_listening_history.sql",
    ];
    const expected = await Promise.all(paths.map(async (p) => hash(await readFile(path.join(packagesRoot, p)))));
    assert.deepEqual((await observer.query(
      "SELECT hash FROM mint_migrations.__drizzle_migrations ORDER BY id",
    )).rows.map((row) => row.hash), expected);
    assert.equal(Number((await observer.query("SELECT count(*) FROM accounts.users")).rows[0].count), 0);

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
    await assert.rejects(createMintSdk({
      url: `${address}/trpc`, gatewayToken: token, trustedClientIp: "192.0.2.1",
    }).accounts.signIn({ email: admin.email, password: "fixture" }), MintSdkError);
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

    const seed = { email: "Seed@fixture.test", name: "Configured Admin", password: " exact bootstrap password " };
    runtime = await startApiRuntime({ ...options, adminBootstrap: seed, publicAuthProxy: "gateway" });
    const seeded = (await observer.query("SELECT * FROM accounts.users WHERE lower(email) = $1", [seed.email.toLowerCase()])).rows[0];
    assert.equal(seeded.email, seed.email);
    assert.equal(seeded.name, seed.name);
    assert.equal(seeded.role, "admin");
    assert.equal(seeded.status, "active");
    assert.ok(seeded.approved_at instanceof Date);
    assert.equal(await argon2Passwords.verify(seeded.password_hash, seed.password), true);
    const authSdk = (trustedClientIp?: string) => createMintSdk({
      url: `${runtime!.address}/trpc`, gatewayToken: token, trustedClientIp, userAgent: "Fixture Browser",
    });
    await assert.rejects(authSdk().accounts.signIn(seed), MintSdkError);
    const unsafeIpHeaders: Record<string, string>[] = [
      { "x-forwarded-for": "192.0.2.1" },
      { "x-mint-client-ip": "192.0.2.1, 192.0.2.2" },
      { "x-mint-client-ip": "unknown", "x-real-ip": "192.0.2.1" },
    ];
    for (const headers of unsafeIpHeaders) {
      const response: Response = await fetch(`${runtime.address}/trpc/accounts.signIn`, {
        method: "POST", headers: { ...headers, "x-mint-gateway-token": token, "content-type": "application/json" },
        body: JSON.stringify(seed),
      });
      assert.equal(response.status, 503);
      assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
      assert.doesNotMatch(await response.text(), /password_hash|postgres|fixture-password/);
    }
    assert.equal(Number((await observer.query("SELECT count(*) FROM platform.rate_limits")).rows[0].count), 0);
    const signedIn = await authSdk("::ffff:192.0.2.10").accounts.signIn(seed);
    assert.ok("token" in signedIn);
    assert.deepEqual(signedIn.principal, {
      id: seeded.id, email: seed.email, name: seed.name, role: "admin", status: "active",
    });
    const persistedSession = (await observer.query("SELECT * FROM accounts.sessions WHERE id = $1", [hash(signedIn.token)])).rows[0];
    assert.equal(persistedSession.user_id, seeded.id);
    assert.equal(persistedSession.ip, "192.0.2.10");
    assert.equal(persistedSession.user_agent, "Fixture Browser");
    assert.equal(persistedSession.expires_at.toISOString(), signedIn.expiresAt);
    const authenticated = createMintSdk({ url: `${runtime.address}/trpc`, gatewayToken: token, sessionToken: signedIn.token });
    assert.deepEqual(await authenticated.accounts.session(), signedIn.principal);
    await authenticated.accounts.signOut();
    assert.equal(await authenticated.accounts.session(), null);
    assert.equal((await observer.query("SELECT * FROM accounts.sessions WHERE id = $1", [hash(signedIn.token)])).rows.length, 0);

    const applicant = { name: "Applicant", email: "new@fixture.test", password: "fixture-password", confirm: "fixture-password" };
    const publicSdk = authSdk("2001:db8::1");
    assert.deepEqual(await publicSdk.accounts.requestAccess(applicant), { ok: true });
    assert.deepEqual(await publicSdk.accounts.requestAccess({ ...applicant, email: applicant.email.toUpperCase() }), { ok: true });
    const requested = (await observer.query("SELECT * FROM accounts.users WHERE email = $1", [applicant.email])).rows[0];
    assert.equal(requested.status, "pending");
    assert.equal(requested.role, "user");
    assert.equal(await argon2Passwords.verify(requested.password_hash, applicant.password), true);
    const pendingSignIn = await publicSdk.accounts.signIn(applicant);
    assert.equal("status" in pendingSignIn ? pendingSignIn.status : null, 403);
    await createMintSdk({ url: `${runtime.address}/trpc`, gatewayToken: token, sessionToken: adminToken })
      .accounts.decideAccessRequest({ userId: requested.id, approve: true });
    assert.ok("token" in await publicSdk.accounts.signIn(applicant));
    for (let i = 0; i < 3; i++) assert.deepEqual(await publicSdk.accounts.requestAccess(applicant), { ok: true });
    assert.ok("error" in await publicSdk.accounts.requestAccess(applicant));
    assert.equal((await observer.query("SELECT attempts FROM platform.rate_limits WHERE key = $1", ["request:ip:2001:db8::1"])).rows[0].attempts, "6");

    await observer.query("DELETE FROM platform.rate_limits");
    for (let i = 0; i < 8; i++) {
      const failed = await authSdk("192.0.2.20").accounts.signIn({ ...seed, password: "wrong" });
      assert.equal("status" in failed ? failed.status : null, 401);
    }
    const limited = await authSdk("192.0.2.21").accounts.signIn(seed);
    assert.equal("status" in limited ? limited.status : null, 429);
    for (let i = 0; i < 20; i++) {
      const failed = await authSdk("192.0.2.30").accounts.signIn({ email: `absent-${i}@fixture.test`, password: "wrong" });
      assert.equal("status" in failed ? failed.status : null, 401);
    }
    const ipLimited = await authSdk("192.0.2.30").accounts.signIn({ email: "another@fixture.test", password: "wrong" });
    assert.equal("status" in ipLimited ? ipLimited.status : null, 429);
    await observer.query("ALTER TABLE platform.rate_limits RENAME TO hidden_rate_limits");
    try {
      const response = await fetch(`${runtime.address}/trpc/accounts.signIn`, {
        method: "POST", headers: {
          "x-mint-gateway-token": token, "x-mint-client-ip": "192.0.2.99", "content-type": "application/json",
        }, body: JSON.stringify(seed),
      });
      assert.equal(response.status, 500);
      assert.doesNotMatch(await response.text(), /hidden_rate_limits|SELECT|password/);
      assert.equal(logged.pop(), "Error");
    } finally {
      await observer.query("ALTER TABLE platform.hidden_rate_limits RENAME TO rate_limits");
    }
    await runtime.stop();
    runtime = undefined;

    await observer.query("UPDATE accounts.users SET role = 'user', status = 'disabled', approved_by = $1 WHERE id = $2", [admin.id, seeded.id]);
    const preserved = (await observer.query("SELECT * FROM accounts.users WHERE id = $1", [seeded.id])).rows;
    runtime = await startApiRuntime({
      ...options, adminBootstrap: { email: seed.email.toUpperCase(), name: "Do not replace", password: "replacement password" },
    });
    assert.deepEqual((await observer.query("SELECT * FROM accounts.users WHERE id = $1", [seeded.id])).rows, preserved);
    await runtime.stop();
    runtime = undefined;

    const concurrent: Awaited<ReturnType<typeof startApiRuntime>>[] = [];
    try {
      await Promise.all(["Race@fixture.test", "race@fixture.test"].map(async (email) => {
        concurrent.push(await startApiRuntime({ ...options, adminBootstrap: { ...seed, email } }));
      }));
      const raced = (await observer.query("SELECT * FROM accounts.users WHERE lower(email) = 'race@fixture.test'")).rows;
      assert.equal(raced.length, 1);
      assert.equal(raced[0].role, "admin");
      assert.equal(raced[0].status, "active");
      assert.equal(await argon2Passwords.verify(raced[0].password_hash, seed.password), true);
    } finally {
      await Promise.all(concurrent.map((instance) => instance.stop()));
    }

    for (const invalid of [
      { ...seed, password: "" }, { ...seed, email: "invalid" }, { ...seed, name: " " },
    ]) {
      await assert.rejects(startApiRuntime({ ...options, adminBootstrap: invalid }), /Invalid API admin bootstrap configuration/);
      assert.equal(await activeConnections(), 0);
    }
    const failedBootstrap = { ...seed, email: "failure@fixture.test" };
    const hashFailure = t.mock.method(argon2Passwords, "hash", async () => {
      throw new Error(`Sensitive hash failure: ${seed.password}`);
    });
    try {
      await assert.rejects(startApiRuntime({
        ...options, adminBootstrap: failedBootstrap, listen: { host: "127.0.0.1", port },
      }), { message: "API startup failed during admin bootstrap." });
      assert.equal(logged.pop(), "ApiStartupError");
      for (let i = 0; i < 100 && await activeConnections() !== 0; i++) await delay(20);
      assert.equal(await activeConnections(), 0);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/trpc/accounts.session`));
    } finally {
      hashFailure.mock.restore();
    }
    await observer.query(`
      CREATE FUNCTION accounts.reject_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Sensitive bootstrap persistence failure'; END $$;
      CREATE TRIGGER reject_bootstrap BEFORE INSERT ON accounts.users
      FOR EACH ROW WHEN (NEW.email = 'failure@fixture.test') EXECUTE FUNCTION accounts.reject_bootstrap();
    `);
    try {
      await assert.rejects(startApiRuntime({
        ...options, adminBootstrap: failedBootstrap, listen: { host: "127.0.0.1", port },
      }), { message: "API startup failed during admin bootstrap." });
      assert.equal(logged.pop(), "ApiStartupError");
      assert.equal(await activeConnections(), 0);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/trpc/accounts.session`));
      assert.equal(Number((await observer.query("SELECT count(*) FROM accounts.users WHERE email = $1", [failedBootstrap.email])).rows[0].count), 0);
    } finally {
      await observer.query("DROP TRIGGER reject_bootstrap ON accounts.users; DROP FUNCTION accounts.reject_bootstrap()");
    }

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
