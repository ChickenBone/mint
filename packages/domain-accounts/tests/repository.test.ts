import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runMigrations, type MigrationOptions } from "@mint/platform";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  bootstrapAdmin,
  createAccountsRepository,
  createMemberStatusUpdater,
  issueBrowserSession,
  lookupBrowserSession,
  MemberStatusForbiddenError,
  MemberStatusSelfChangeError,
  revokeBrowserSession,
  SESSION_TTL_MS,
  sessions,
  users,
  type StoredSessionEvidence,
} from "../src/index";

const exec = promisify(execFile);
const instant = new Date("2030-01-02T03:04:05.000Z");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
function constraintFailure(constraint: string, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof DrizzleQueryError);
    assert.ok(error.cause instanceof pg.DatabaseError);
    assert.equal(error.cause.constraint, constraint);
    assert.equal(error.cause.code, code);
    return true;
  };
}

function closedPoolFailure(error: unknown) {
  assert.ok(error instanceof DrizzleQueryError);
  assert.ok(error.cause instanceof Error);
  assert.match(error.cause.message, /Cannot use a pool after calling end/);
  return true;
}

const options: MigrationOptions = {
  journal: {
    version: "7",
    dialect: "postgresql",
    entries: [{ idx: 0, version: "7", when: 100, tag: "0000_accounts", breakpoints: true }],
  },
  migrationsRoot: fileURLToPath(new URL("../", import.meta.url)),
  files: [{ tag: "0000_accounts", path: "migrations/0000_accounts.sql" }],
  history: { schema: "accounts_fixture_history", table: "fixture_migrations" },
};

test("Accounts adapters and fresh SQL on disposable PostgreSQL", { timeout: 120_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to local PostgreSQL binaries for disposable DB evidence");
    return;
  }
  assert.ok(path.isAbsolute(bin), "PostgreSQL binary directory must be absolute");
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-accounts-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LC_ALL: "C",
    PGHOST: socket,
    PGPORT: "5432",
    PGDATABASE: "accounts_fixture_db",
    PGUSER: "accounts_fixture",
  };
  const connection = {
    host: socket, port: 5432, user: "accounts_fixture", password: "", max: 1,
    connectionTimeoutMillis: 5_000, query_timeout: 5_000, statement_timeout: 5_000,
  };
  const bootstrap = new pg.Pool({ ...connection, database: "postgres" });
  const pool = new pg.Pool({ ...connection, database: "accounts_fixture_db" });
  let bootstrapClosed = false;
  let poolClosed = false;
  try {
    await mkdir(socket, { mode: 0o700 });
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "accounts_fixture", "--auth-local=trust", "--auth-host=reject",
      "--no-locale", "-E", "UTF8",
    ], { env, timeout: 30_000 });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-t", "15", "-w", "start",
    ], { env, timeout: 20_000 });
    assert.deepEqual((await bootstrap.query<{ ready: number }>("SELECT 1 AS ready")).rows, [{ ready: 1 }]);
    await bootstrap.query("CREATE DATABASE accounts_fixture_db");
    await bootstrap.end();
    bootstrapClosed = true;
    assert.deepEqual((await pool.query<{ database: string; user: string; tcp: string }>(
      "SELECT current_database() AS database, current_user AS user, current_setting('listen_addresses') AS tcp",
    )).rows, [{ database: "accounts_fixture_db", user: "accounts_fixture", tcp: "" }]);
    const queries: string[] = [];
    const db = drizzle(pool, {
      schema: { users, sessions },
      logger: { logQuery(query) { queries.push(query); } },
    });
    const repository = createAccountsRepository(db);

    await t.test("central fixture journal applies Accounts SQL twice without repeating DDL", async () => {
      await runMigrations(db, options);
      await runMigrations(db, options);
      const source = await readFile(new URL("../migrations/0000_accounts.sql", import.meta.url), "utf8");
      assert.deepEqual((await pool.query<{ hash: string; created_at: string }>(
        "SELECT hash, created_at FROM accounts_fixture_history.fixture_migrations",
      )).rows, [{ hash: hash(source), created_at: "100" }]);
      assert.deepEqual((await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'accounts' ORDER BY table_name",
      )).rows.map((row) => row.table_name), ["sessions", "users"]);
    });

    await t.test("actual columns, enums, constraints, defaults and indexes match the accepted schema", async () => {
      const columns = await pool.query<{
        table_name: string; column_name: string; udt_name: string; is_nullable: string; column_default: string | null;
      }>(`SELECT table_name, column_name, udt_name, is_nullable, column_default
          FROM information_schema.columns WHERE table_schema = 'accounts' ORDER BY table_name, ordinal_position`);
      assert.deepEqual(columns.rows.map((row) => [
        row.table_name, row.column_name, row.udt_name, row.is_nullable, row.column_default,
      ]), [
        ["sessions", "id", "text", "NO", null],
        ["sessions", "user_id", "uuid", "NO", null],
        ["sessions", "expires_at", "timestamptz", "NO", null],
        ["sessions", "user_agent", "text", "YES", null],
        ["sessions", "ip", "text", "YES", null],
        ["sessions", "created_at", "timestamptz", "NO", "now()"],
        ["users", "id", "uuid", "NO", "gen_random_uuid()"],
        ["users", "email", "text", "NO", null],
        ["users", "name", "text", "NO", null],
        ["users", "password_hash", "text", "NO", null],
        ["users", "role", "role", "NO", "'user'::accounts.role"],
        ["users", "status", "user_status", "NO", "'pending'::accounts.user_status"],
        ["users", "request_note", "text", "YES", null],
        ["users", "approved_at", "timestamptz", "YES", null],
        ["users", "approved_by", "uuid", "YES", null],
        ["users", "created_at", "timestamptz", "NO", "now()"],
        ["users", "updated_at", "timestamptz", "NO", "now()"],
      ]);
      assert.deepEqual((await pool.query<{ typname: string; enumlabel: string }>(
        `SELECT typname, enumlabel FROM pg_type JOIN pg_namespace n ON n.oid = typnamespace
         JOIN pg_enum e ON e.enumtypid = pg_type.oid
         WHERE n.nspname = 'accounts' ORDER BY typname, enumsortorder`,
      )).rows, [
        { typname: "role", enumlabel: "user" }, { typname: "role", enumlabel: "admin" },
        ...["pending", "active", "denied", "disabled"].map((enumlabel) => ({ typname: "user_status", enumlabel })),
      ]);
      assert.deepEqual((await pool.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'accounts' ORDER BY conname`,
      )).rows, [
        { conname: "sessions_pkey", definition: "PRIMARY KEY (id)" },
        { conname: "sessions_user_id_users_id_fk", definition: "FOREIGN KEY (user_id) REFERENCES accounts.users(id) ON DELETE CASCADE" },
        { conname: "users_pkey", definition: "PRIMARY KEY (id)" },
      ]);
      assert.deepEqual((await pool.query<{ indexname: string; indexdef: string }>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'accounts' ORDER BY indexname",
      )).rows, [
        { indexname: "sessions_pkey", indexdef: "CREATE UNIQUE INDEX sessions_pkey ON accounts.sessions USING btree (id)" },
        { indexname: "sessions_user_idx", indexdef: "CREATE INDEX sessions_user_idx ON accounts.sessions USING btree (user_id)" },
        { indexname: "users_email_idx", indexdef: "CREATE UNIQUE INDEX users_email_idx ON accounts.users USING btree (lower(email))" },
        { indexname: "users_pkey", indexdef: "CREATE UNIQUE INDEX users_pkey ON accounts.users USING btree (id)" },
      ]);
      const [created] = await db.insert(users).values({
        email: "Defaults@Example.test", name: "Defaults", passwordHash: "fixture-password-hash",
        approvedBy: randomUUID(),
      }).returning();
      assert.ok(created);
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.equal(created.role, "user");
      assert.equal(created.status, "pending");
      assert.equal(created.requestNote, null);
      assert.equal(created.approvedAt, null);
      assert.ok(created.createdAt instanceof Date);
      assert.equal(created.createdAt.getTime(), created.updatedAt.getTime());
      await db.insert(sessions).values({ id: "default-session", userId: created.id, expiresAt: instant });
      const [stored] = await db.select().from(sessions).where(eq(sessions.id, "default-session"));
      assert.ok(stored);
      assert.equal(stored.ip, null);
      assert.equal(stored.userAgent, null);
      assert.ok(stored.createdAt instanceof Date);
      await assert.rejects(db.insert(users).values({
        email: "defaults@example.TEST", name: "Duplicate", passwordHash: "fixture-password-hash",
      }), constraintFailure("users_email_idx", "23505"));
      await assert.rejects(pool.query(
        "INSERT INTO accounts.users (email, name, password_hash, role) VALUES ('bad@example.test', 'Bad', 'hash', 'operator')",
      ), /invalid input value for enum/);
      await assert.rejects(pool.query(
        "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ('missing-user', $1, now())", [randomUUID()],
      ), /sessions_user_id_users_id_fk/);
    });

    const [account] = await db.insert(users).values({
      email: "Member@Example.test", name: "Member", passwordHash: "fixture-only-secret-hash", status: "active",
      requestNote: "private fixture note", approvedBy: randomUUID(), approvedAt: instant,
    }).returning();
    assert.ok(account);
    const principal = {
      id: account.id, email: account.email, name: account.name, role: account.role, status: account.status,
    };
    const token = "fixture-browser-token";
    const issued = await issueBrowserSession(
      { userId: account.id, ip: "192.0.2.1", userAgent: "a".repeat(301) },
      repository, { now: () => instant, generateToken: () => token },
    );

    await t.test("service issuance, bounded secret-free lookup and revocation roundtrip", async () => {
      assert.equal(issued.expiresAt.getTime() - instant.getTime(), SESSION_TTL_MS);
      const [stored] = await db.select().from(sessions).where(eq(sessions.id, hash(token)));
      assert.deepEqual(stored, {
        id: hash(token), userId: account.id, createdAt: instant, expiresAt: issued.expiresAt,
        ip: "192.0.2.1", userAgent: "a".repeat(300),
      });
      queries.length = 0;
      assert.deepEqual(await repository.findByTokenHash(hash(token)), { expiresAt: issued.expiresAt, principal });
      assert.equal(queries.length, 1);
      assert.match(queries[0]!, /inner join/);
      assert.match(queries[0]!, /limit \$2/);
      assert.doesNotMatch(queries[0]!, /password_hash|request_note|approved_|user_agent|"ip"|created_at|select \*/);
      assert.deepEqual(await lookupBrowserSession(token, repository, () => instant), principal);
      assert.equal(await repository.findByTokenHash("not-stored"), null);
      assert.equal(await lookupBrowserSession("unknown-token", repository, () => instant), null);
      queries.length = 0;
      for (const absent of [null, undefined, "", "mn1.native-token"]) {
        assert.equal(await lookupBrowserSession(absent, repository, () => instant), null);
      }
      assert.deepEqual(queries, []);
      for (const offset of [-1, 0, 1]) {
        assert.deepEqual(await lookupBrowserSession(
          token, repository, () => new Date(issued.expiresAt.getTime() + offset),
        ), offset < 0 ? principal : null);
      }
      await revokeBrowserSession(token, repository);
      await revokeBrowserSession(token, repository);
      await revokeBrowserSession("unknown-token", repository);
      assert.equal(await lookupBrowserSession(token, repository, () => instant), null);
    });

    await t.test("lookup re-reads current role, status and identity without authorizing inside storage", async () => {
      await issueBrowserSession({ userId: account.id }, repository, {
        now: () => instant, generateToken: () => token,
      });
      const [nullable] = await db.select().from(sessions).where(eq(sessions.id, hash(token)));
      assert.ok(nullable);
      assert.equal(nullable.ip, null);
      assert.equal(nullable.userAgent, null);
      for (const status of ["pending", "disabled", "denied", "active"] as const) {
        await db.update(users).set({ status, role: "admin", name: "Changed" }).where(eq(users.id, account.id));
        const evidence = await repository.findByTokenHash(hash(token));
        assert.ok(evidence);
        assert.equal(evidence.principal.status, status);
        assert.deepEqual(await lookupBrowserSession(token, repository, () => instant),
          status === "active" ? { ...principal, status, role: "admin", name: "Changed" } : null);
      }
      // Expired evidence remains storage evidence; only the service decides admission.
      assert.ok(await repository.findByTokenHash(hash(token)));
      assert.equal(await lookupBrowserSession(token, repository, () => issued.expiresAt), null);
    });

    await t.test("authentication reads only the principal and password hash, without trimming email", async () => {
      queries.length = 0;
      assert.deepEqual(await repository.findByLowercaseEmail("mEmBeR@eXaMpLe.TeSt"), {
        ...principal, role: "admin", name: "Changed", passwordHash: account.passwordHash,
      });
      assert.equal(queries.length, 1);
      assert.match(queries[0]!, /lower\("accounts"\."users"\."email"\)/);
      assert.match(queries[0]!, /limit \$2/);
      assert.doesNotMatch(queries[0]!, /request_note|approved_|created_at|updated_at|select \*/);
      assert.equal(await repository.findByLowercaseEmail("member@example.test "), null);
      assert.equal(await repository.findByLowercaseEmail(" member@example.test"), null);
      assert.equal(await repository.findByLowercaseEmail("unknown@example.test"), null);
      assert.equal(await repository.findByLowercaseEmail("' OR true --"), null);
    });

    await t.test("insert failures propagate and deleting a user cascades its sessions", async () => {
      const evidence: StoredSessionEvidence = {
        id: hash("second-token"), userId: account.id, createdAt: instant, expiresAt: issued.expiresAt,
        ip: null, userAgent: "",
      };
      await repository.insertSession(evidence);
      await assert.rejects(repository.insertSession(evidence), constraintFailure("sessions_pkey", "23505"));
      await assert.rejects(repository.insertSession({
        ...evidence, id: hash("orphan-token"), userId: randomUUID(),
      }), constraintFailure("sessions_user_id_users_id_fk", "23503"));
      assert.deepEqual((await db.select().from(sessions).where(eq(sessions.id, evidence.id)))[0], evidence);
      await db.delete(users).where(eq(users.id, account.id));
      assert.equal(await repository.findByTokenHash(hash(token)), null);
      assert.equal(await repository.findByTokenHash(evidence.id), null);
      assert.deepEqual(await db.select().from(sessions).where(eq(sessions.userId, account.id)), []);
      assert.equal(await repository.findByLowercaseEmail(account.email), null);
      await repository.deleteByTokenHash(evidence.id);
    });

    await t.test("bootstrap leaves every existing role/status and all stored fields unchanged", async () => {
      for (const role of ["user", "admin"] as const) {
        for (const status of ["pending", "active", "denied", "disabled"] as const) {
          const [existing] = await db.insert(users).values({
            email: `${role}-${status}@Example.test`, name: "Original identity",
            passwordHash: "original-password-hash", role, status,
            requestNote: "private original note", approvedBy: randomUUID(),
            approvedAt: status === "pending" ? null : instant,
            createdAt: instant, updatedAt: instant,
          }).returning();
          assert.ok(existing);
          assert.deepEqual(await bootstrapAdmin({
            email: existing.email.toUpperCase(), name: "Replacement", password: "replacement",
          }, repository, {
            async hash() { assert.fail("existing accounts must not be hashed"); },
            now() { assert.fail("existing accounts must not use the clock"); },
          }), { status: "existing" });
          assert.equal(await repository.insertAdminIfAbsent({
            email: existing.email.toUpperCase(), name: "Replacement", passwordHash: "replacement-hash",
            role: "admin", status: "active", approvedAt: new Date("2040-01-01T00:00:00.000Z"),
          }), false);
          assert.deepEqual((await db.select().from(users).where(eq(users.id, existing.id)))[0], existing);
        }
      }
      queries.length = 0;
      assert.deepEqual(await bootstrapAdmin({
        email: "unseeded@example.test", name: "Unused", password: "",
      }, repository, {
        async hash() { assert.fail("missing passwords must not be hashed"); },
        now() { assert.fail("missing passwords must not use the clock"); },
      }), { status: "missing-password" });
      assert.deepEqual(queries, []);
    });

    await t.test("concurrent first boots use the email index without overwriting the winner", async () => {
      const racePool = new pg.Pool({ ...connection, max: 2, database: "accounts_fixture_db" });
      try {
        const raceDb = drizzle(racePool, { schema: { users, sessions } });
        const raceRepository = createAccountsRepository(raceDb);
        let arrivals = 0;
        let release = () => {};
        const bothHashed = new Promise<void>((resolve) => { release = resolve; });
        const dependencies = {
          async hash(password: string) {
            arrivals += 1;
            if (arrivals === 2) release();
            await bothHashed;
            return `fixture-hash:${password}`;
          },
          now: () => instant,
        };
        const seeds = [
          { email: "Race@Example.test", name: "First seed", password: "first" },
          { email: "rACE@example.TEST", name: "Second seed", password: "second" },
        ];
        const results = await Promise.all(seeds.map((seed) =>
          bootstrapAdmin(seed, raceRepository, dependencies)));
        assert.equal(arrivals, 2);
        assert.deepEqual(results.map((result) => result.status).sort(), ["created", "existing"]);
        const winner = seeds[results.findIndex((result) => result.status === "created")];
        assert.ok(winner);
        const stored = await raceDb.select().from(users).where(eq(users.email, winner.email));
        assert.equal(stored.length, 1);
        const created = stored[0];
        assert.ok(created);
        assert.match(created.id, /^[0-9a-f-]{36}$/);
        assert.equal(created.email, winner.email);
        assert.equal(created.name, winner.name);
        assert.equal(created.passwordHash, `fixture-hash:${winner.password}`);
        assert.equal(created.role, "admin");
        assert.equal(created.status, "active");
        assert.deepEqual(created.approvedAt, instant);
        assert.equal(created.approvedBy, null);
        assert.equal(created.requestNote, null);
        assert.ok(created.createdAt instanceof Date);
        assert.equal(created.createdAt.getTime(), created.updatedAt.getTime());
        assert.deepEqual((await racePool.query<{ count: string }>(
          "SELECT count(*) FROM accounts.users WHERE lower(email) = 'race@example.test'",
        )).rows, [{ count: "1" }]);
        assert.deepEqual(await bootstrapAdmin({
          email: "RACE@EXAMPLE.TEST", name: "Changed", password: "changed",
        }, raceRepository, {
          async hash() { assert.fail("the winner must not be rehashed"); },
          now() { assert.fail("the winner must not be reapproved"); },
        }), { status: "existing" });
        assert.deepEqual(await raceDb.select().from(users).where(eq(users.id, created.id)), stored);
      } finally {
        await racePool.end();
      }
    });

    await t.test("pending insertion stores precise fields, enforces policy and leaves identity/timestamps to DB defaults", async () => {
      const email = "Access@Example.test";
      const pending = {
        name: "Access requester",
        email,
        passwordHash: "fixture-access-hash",
        requestNote: "Literal note'); DROP TABLE accounts.users; --",
        role: "admin", status: "active", approvedAt: instant, approvedBy: randomUUID(),
        id: randomUUID(), createdAt: instant, updatedAt: instant,
      };
      queries.length = 0;
      assert.equal(await repository.insertPendingIfAbsent(pending), true);
      assert.equal(queries.length, 1);
      assert.match(queries[0]!, /ON CONFLICT \(lower\(email\)\) DO NOTHING/);
      assert.match(queries[0]!, /RETURNING id/);
      assert.doesNotMatch(queries[0]!, /approved_|created_at|updated_at|Literal note|fixture-access-hash/);
      const [created] = await db.select().from(users).where(eq(users.email, email));
      assert.ok(created);
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.notEqual(created.id, pending.id);
      assert.deepEqual({
        name: created.name, email: created.email, passwordHash: created.passwordHash,
        requestNote: created.requestNote, role: created.role, status: created.status,
        approvedAt: created.approvedAt, approvedBy: created.approvedBy,
      }, {
        name: pending.name, email, passwordHash: pending.passwordHash, requestNote: pending.requestNote,
        role: "user", status: "pending", approvedAt: null, approvedBy: null,
      });
      assert.ok(created.createdAt instanceof Date);
      assert.notEqual(created.createdAt.getTime(), instant.getTime());
      assert.equal(created.createdAt.getTime(), created.updatedAt.getTime());
      assert.equal(await repository.insertPendingIfAbsent({
        email: "NullNote@Example.test", name: "Null note", passwordHash: "null-note-hash", requestNote: null,
      }), true);
      const [nullNote] = await db.select().from(users).where(eq(users.email, "NullNote@Example.test"));
      assert.ok(nullNote);
      assert.equal(nullNote.requestNote, null);
      assert.deepEqual(await db.select().from(sessions).where(eq(sessions.userId, created.id)), []);
    });

    await t.test("pending insertion never resets, promotes or overwrites any existing role/status", async () => {
      for (const role of ["user", "admin"] as const) {
        for (const status of ["pending", "active", "denied", "disabled"] as const) {
          const email = `${role}-${status}@Example.test`;
          const [original] = await db.select().from(users).where(eq(users.email, email));
          assert.ok(original);
          assert.equal(await repository.insertPendingIfAbsent({
            email: email.toUpperCase(), name: "Replacement", passwordHash: "replacement-hash", requestNote: null,
          }), false);
          assert.deepEqual((await db.select().from(users).where(eq(users.id, original.id)))[0], original);
        }
      }
    });

    await t.test("countPending counts only pending accounts across both roles and reads current state", async () => {
      const pendingBefore = await db.$count(users, eq(users.status, "pending"));
      assert.ok(pendingBefore > 0);
      assert.equal(await repository.countPending(), pendingBefore);
      for (const role of ["user", "admin"] as const) {
        for (const status of ["pending", "active", "denied", "disabled"] as const) {
          await db.insert(users).values({
            email: `count-${role}-${status}@example.test`, name: "Count fixture",
            passwordHash: "count-fixture-hash", role, status,
          });
        }
      }
      assert.equal(await repository.countPending(), pendingBefore + 2);
      await db.update(users).set({ status: "active" }).where(eq(users.email, "count-user-pending@example.test"));
      assert.equal(await repository.countPending(), pendingBefore + 1);
    });

    await t.test("pending decisions conditionally approve or deny without rewriting other states", async () => {
      const approvalActor = randomUUID();
      const priorApprover = randomUUID();
      const [toApprove] = await db.insert(users).values({
        email: "decision-approve@example.test", name: "Approve fixture", passwordHash: "fixture-hash",
        updatedAt: new Date("2000-01-01T00:00:00.000Z"),
      }).returning();
      const [toDeny] = await db.insert(users).values({
        email: "decision-deny@example.test", name: "Deny fixture", passwordHash: "fixture-hash",
        approvedAt: instant, approvedBy: priorApprover,
        updatedAt: new Date("2000-01-01T00:00:00.000Z"),
      }).returning();
      assert.ok(toApprove);
      assert.ok(toDeny);

      const approvedAt = new Date("2033-04-05T06:07:08.000Z");
      await repository.decidePendingAccess({
        userId: toApprove.id,
        decision: { status: "active", approvedAt, approvedBy: approvalActor },
      });
      const [approved] = await db.select().from(users).where(eq(users.id, toApprove.id));
      assert.ok(approved);
      assert.equal(approved.status, "active");
      assert.deepEqual(approved.approvedAt, approvedAt);
      assert.equal(approved.approvedBy, approvalActor);
      assert.notEqual(approved.updatedAt.getTime(), toApprove.updatedAt.getTime());

      await repository.decidePendingAccess({ userId: toDeny.id, decision: { status: "denied" } });
      const [denied] = await db.select().from(users).where(eq(users.id, toDeny.id));
      assert.ok(denied);
      assert.equal(denied.status, "denied");
      assert.deepEqual(denied.approvedAt, instant);
      assert.equal(denied.approvedBy, priorApprover);
      assert.notEqual(denied.updatedAt.getTime(), toDeny.updatedAt.getTime());

      const unchanged = [];
      for (const status of ["active", "denied", "disabled"] as const) {
        const [account] = await db.insert(users).values({
          email: `decision-noop-${status}@example.test`, name: "No-op fixture",
          passwordHash: "fixture-hash", status, approvedAt: instant, approvedBy: priorApprover,
        }).returning();
        assert.ok(account);
        unchanged.push(account);
      }
      const pendingBeforeNoop = await repository.countPending();
      const missingUserId = randomUUID();
      for (const userId of [missingUserId, ...unchanged.map(({ id }) => id)]) {
        await repository.decidePendingAccess({
          userId,
          decision: { status: "active", approvedAt, approvedBy: approvalActor },
        });
      }
      assert.equal(await repository.countPending(), pendingBeforeNoop);
      for (const original of unchanged) {
        assert.deepEqual((await db.select().from(users).where(eq(users.id, original.id)))[0], original);
      }
    });

    await t.test("independent concurrent decisions allow only the first pending transition", async () => {
      const [candidate] = await db.insert(users).values({
        email: "decision-race@example.test", name: "Decision race", passwordHash: "fixture-hash",
      }).returning();
      assert.ok(candidate);
      const pendingBefore = await repository.countPending();
      const pools = [
        new pg.Pool({ ...connection, database: "accounts_fixture_db" }),
        new pg.Pool({ ...connection, database: "accounts_fixture_db" }),
      ];
      try {
        const backendIds = await Promise.all(pools.map(async (candidatePool) =>
          (await candidatePool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
        assert.notEqual(backendIds[0], backendIds[1]);
        const [approver, denier] = pools.map((candidatePool) =>
          createAccountsRepository(drizzle(candidatePool, { schema: { users, sessions } })));
        assert.ok(approver);
        assert.ok(denier);
        const approval = {
          status: "active" as const,
          approvedAt: new Date("2034-05-06T07:08:09.000Z"),
          approvedBy: randomUUID(),
        };
        await Promise.all([
          approver.decidePendingAccess({ userId: candidate.id, decision: approval }),
          denier.decidePendingAccess({ userId: candidate.id, decision: { status: "denied" } }),
        ]);
        const [result] = await db.select().from(users).where(eq(users.id, candidate.id));
        assert.ok(result);
        if (result.status === "active") {
          assert.deepEqual(result.approvedAt, approval.approvedAt);
          assert.equal(result.approvedBy, approval.approvedBy);
        } else {
          assert.equal(result.status, "denied");
          assert.equal(result.approvedAt, null);
          assert.equal(result.approvedBy, null);
        }
        assert.equal(await repository.countPending(), pendingBefore - 1);
      } finally {
        await Promise.all(pools.map((candidatePool) => candidatePool.end()));
      }
    });

    await t.test("independent concurrent connections insert one pending email and preserve the winning fields", async () => {
      const pools = [
        new pg.Pool({ ...connection, database: "accounts_fixture_db" }),
        new pg.Pool({ ...connection, database: "accounts_fixture_db" }),
      ];
      try {
        const backendIds = await Promise.all(pools.map(async (candidate) =>
          (await candidate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
        assert.notEqual(backendIds[0], backendIds[1]);
        const repositories = pools.map((candidate) =>
          createAccountsRepository(drizzle(candidate, { schema: { users, sessions } })));
        const candidates = [
          { email: "AccessRace@Example.test", name: "First requester", passwordHash: "first-hash", requestNote: "First note" },
          { email: "aCCESSrACE@example.TEST", name: "Second requester", passwordHash: "second-hash", requestNote: null },
        ];
        const results = await Promise.all(repositories.map((candidate, index) =>
          candidate.insertPendingIfAbsent(candidates[index]!)));
        assert.deepEqual([...results].sort(), [false, true]);
        const winner = candidates[results.findIndex(Boolean)]!;
        const stored = await db.select().from(users).where(eq(users.email, winner.email));
        assert.equal(stored.length, 1);
        const created = stored[0]!;
        assert.deepEqual({
          email: created.email, name: created.name, passwordHash: created.passwordHash, requestNote: created.requestNote,
        }, winner);
        assert.equal(created.role, "user");
        assert.equal(created.status, "pending");
        assert.equal(created.approvedAt, null);
        assert.equal(created.approvedBy, null);
        assert.match(created.id, /^[0-9a-f-]{36}$/);
        assert.ok(created.createdAt instanceof Date);
        assert.equal(created.createdAt.getTime(), created.updatedAt.getTime());
        assert.deepEqual((await pool.query<{ count: string }>(
          "SELECT count(*) FROM accounts.users WHERE lower(email) = 'accessrace@example.test'",
        )).rows, [{ count: "1" }]);
        for (const candidate of repositories) {
          assert.equal(await candidate.insertPendingIfAbsent({
            email: winner.email.toUpperCase(), name: "Overwrite", passwordHash: "overwrite", requestNote: "overwrite",
          }), false);
        }
        assert.deepEqual(await db.select().from(users).where(eq(users.id, created.id)), stored);
      } finally {
        await Promise.all(pools.map((candidate) => candidate.end()));
      }
    });

    await t.test("pending insertion propagates non-email constraints rather than broadly suppressing failures", async () => {
      await assert.rejects(repository.insertPendingIfAbsent({
        email: "invalid-access@example.test", name: null as unknown as string,
        passwordHash: "fixture-hash", requestNote: null,
      }), (error) => {
        assert.ok(error instanceof DrizzleQueryError);
        assert.ok(error.cause instanceof pg.DatabaseError);
        assert.equal(error.cause.code, "23502");
        assert.equal(error.cause.column, "name");
        return true;
      });
      assert.equal(await repository.findByLowercaseEmail("invalid-access@example.test"), null);
    });

    await t.test("member status policy preserves pending and approval data and atomically revokes disabled sessions", async () => {
      const [adminAccount] = await db.insert(users).values({
        email: "member-status-admin@example.test", name: "Member status admin",
        passwordHash: "fixture-hash", role: "admin", status: "active",
      }).returning();
      assert.ok(adminAccount);
      const actor = {
        id: adminAccount.id,
        email: adminAccount.email,
        name: adminAccount.name,
        role: adminAccount.role,
        status: adminAccount.status,
      };
      const update = createMemberStatusUpdater(repository);
      queries.length = 0;
      for (const invalidActor of [
        null,
        { ...actor, role: "user" },
        { ...actor, status: "disabled" },
      ]) {
        await assert.rejects(
          update({ userId: randomUUID(), status: "disabled" }, invalidActor as typeof actor | null),
          MemberStatusForbiddenError,
        );
      }
      await assert.rejects(
        update({ userId: actor.id, status: "disabled" }, actor),
        MemberStatusSelfChangeError,
      );
      assert.deepEqual(queries, []);
      await assert.rejects(
        update({ userId: "not-a-uuid", status: "disabled" }, actor),
        /Invalid member status change/,
      );
      await assert.rejects(
        update({ userId: randomUUID(), status: "pending" } as never, actor),
        /Invalid member status change/,
      );
      assert.deepEqual(queries, []);

      const [pending] = await db.insert(users).values({
        email: "member-status-pending@example.test", name: "Pending",
        passwordHash: "fixture-hash", status: "pending", approvedAt: instant, approvedBy: randomUUID(),
      }).returning();
      assert.ok(pending);
      const pendingSessionId = hash("member-status-pending-session");
      await db.insert(sessions).values({
        id: pendingSessionId, userId: pending.id, expiresAt: instant,
      });
      await update({ userId: pending.id, status: "disabled" }, actor);
      assert.deepEqual((await db.select().from(users).where(eq(users.id, pending.id)))[0], pending);
      assert.equal((await db.select().from(sessions).where(eq(sessions.id, pendingSessionId))).length, 1);

      const [denied] = await db.insert(users).values({
        email: "member-status-denied@example.test", name: "Denied",
        passwordHash: "fixture-hash", status: "denied", approvedAt: instant, approvedBy: randomUUID(),
      }).returning();
      assert.ok(denied);
      const deniedSessionId = hash("member-status-denied-session");
      await db.insert(sessions).values({
        id: deniedSessionId, userId: denied.id, expiresAt: instant,
      });
      await update({ userId: denied.id, status: "active" }, actor);
      const [enabledDenied] = await db.select().from(users).where(eq(users.id, denied.id));
      assert.ok(enabledDenied);
      assert.equal(enabledDenied.status, "active");
      assert.deepEqual(enabledDenied.approvedAt, denied.approvedAt);
      assert.equal(enabledDenied.approvedBy, denied.approvedBy);
      assert.equal((await db.select().from(sessions).where(eq(sessions.id, deniedSessionId))).length, 1);

      const [active] = await db.insert(users).values({
        email: "member-status-active@example.test", name: "Active",
        passwordHash: "fixture-hash", status: "active", approvedAt: instant, approvedBy: randomUUID(),
      }).returning();
      assert.ok(active);
      const activeSessionIds = ["member-status-active-one", "member-status-active-two"].map(hash);
      await db.insert(sessions).values(activeSessionIds.map((id) => ({
        id, userId: active.id, expiresAt: instant,
      })));
      await update({ userId: active.id, status: "disabled" }, actor);
      const [disabled] = await db.select().from(users).where(eq(users.id, active.id));
      assert.ok(disabled);
      assert.equal(disabled.status, "disabled");
      assert.deepEqual(disabled.approvedAt, active.approvedAt);
      assert.equal(disabled.approvedBy, active.approvedBy);
      assert.deepEqual(await db.select().from(sessions).where(eq(sessions.userId, active.id)), []);
      await update({ userId: active.id, status: "active" }, actor);
      const [reenabled] = await db.select().from(users).where(eq(users.id, active.id));
      assert.ok(reenabled);
      assert.equal(reenabled.status, "active");
      assert.deepEqual(reenabled.approvedAt, active.approvedAt);
      assert.equal(reenabled.approvedBy, active.approvedBy);
      assert.deepEqual(await db.select().from(sessions).where(eq(sessions.userId, active.id)), []);

      const [rollbackTarget] = await db.insert(users).values({
        email: "member-status-rollback@example.test", name: "Rollback",
        passwordHash: "fixture-hash", status: "active",
      }).returning();
      assert.ok(rollbackTarget);
      const rollbackSessionId = hash("member-status-rollback-session");
      await db.insert(sessions).values({
        id: rollbackSessionId, userId: rollbackTarget.id, expiresAt: instant,
      });
      await pool.query(`
        CREATE FUNCTION accounts.reject_member_session_delete() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'fixture session deletion failure';
        END;
        $$ LANGUAGE plpgsql
      `);
      await pool.query(`
        CREATE TRIGGER reject_member_session_delete
        BEFORE DELETE ON accounts.sessions
        FOR EACH ROW EXECUTE FUNCTION accounts.reject_member_session_delete()
      `);
      try {
        await assert.rejects(
          update({ userId: rollbackTarget.id, status: "disabled" }, actor),
          (error: unknown) => {
            assert.ok(error instanceof DrizzleQueryError);
            assert.ok(error.cause instanceof pg.DatabaseError);
            assert.match(error.cause.message, /fixture session deletion failure/);
            return true;
          },
        );
      } finally {
        await pool.query("DROP TRIGGER reject_member_session_delete ON accounts.sessions");
        await pool.query("DROP FUNCTION accounts.reject_member_session_delete()");
      }
      const [rolledBack] = await db.select().from(users).where(eq(users.id, rollbackTarget.id));
      assert.ok(rolledBack);
      assert.equal(rolledBack.status, "active");
      assert.equal((await db.select().from(sessions).where(eq(sessions.id, rollbackSessionId))).length, 1);
    });

    await t.test("all adapter methods reject database errors instead of returning absence or success", async () => {
      await pool.end();
      poolClosed = true;
      await assert.rejects(repository.findByTokenHash(hash(token)), closedPoolFailure);
      await assert.rejects(repository.findByLowercaseEmail(account.email), closedPoolFailure);
      await assert.rejects(repository.deleteByTokenHash(hash(token)), closedPoolFailure);
      await assert.rejects(repository.insertSession({
        id: hash(token), userId: account.id, createdAt: instant, expiresAt: issued.expiresAt,
        ip: undefined, userAgent: undefined,
      }), closedPoolFailure);
    });
    await t.test("bootstrap insertion propagates database errors", async () => {
      await assert.rejects(repository.insertAdminIfAbsent({
        email: "unavailable@example.test", name: "Unavailable", passwordHash: "fixture-hash",
        role: "admin", status: "active", approvedAt: instant,
      }), closedPoolFailure);
    });
    await t.test("pending insertion and count propagate closed-pool errors", async () => {
      await assert.rejects(repository.insertPendingIfAbsent({
        email: "unavailable-access@example.test", name: "Unavailable",
        passwordHash: "fixture-hash", requestNote: null,
      }), closedPoolFailure);
      await assert.rejects(repository.countPending(), closedPoolFailure);
    });
  } finally {
    try {
      if (!bootstrapClosed) await bootstrap.end();
      if (!poolClosed) await pool.end();
    } finally {
      if (existsSync(path.join(data, "postmaster.pid"))) {
        await exec(path.join(bin, "pg_ctl"), [
          "-D", data, "-m", "fast", "-t", "15", "-w", "stop",
        ], { env, timeout: 20_000 });
      }
      // Keep owned files for diagnosis if shutdown fails; never remove a running cluster.
      await rm(cluster, { recursive: true, force: true });
    }
  }
  assert.equal(existsSync(cluster), false);
});
