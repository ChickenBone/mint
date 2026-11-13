import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { runMigrations, runStartupMigrations, type StartupMigrationOptions } from "../src/index";

const exec = promisify(execFile);
const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));
const journalPath = "platform/migrations/meta/_journal.json";
const sqlPaths = [
  "platform/migrations/0000_rate_limits.sql",
  "domain-accounts/migrations/0000_accounts.sql",
  "domain-catalog/migrations/0000_recordings.sql",
  "domain-library/migrations/0000_library_identity.sql",
  "domain-library/migrations/0001_library_listing.sql",
  "platform/migrations/0001_events.sql",
  "platform/migrations/0002_public_read_cache.sql",
  "domain-catalog/migrations/0001_startup_seed_receipts.sql",
  "domain-catalog/migrations/0002_listenbrainz_seed_ingestion.sql",
  "domain-playback/migrations/0000_listening_history.sql",
];
const key = [0x4d494e54, 0x4d494752];
const options: StartupMigrationOptions = { packagesRoot, lockTimeoutMs: 5_000 };

async function copyArtifacts() {
  const root = await mkdtemp(path.join(tmpdir(), "mint-startup-artifacts-"));
  for (const relative of [journalPath, ...sqlPaths]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await cp(path.join(packagesRoot, relative), path.join(root, relative));
  }
  return root;
}

async function expectedHistory(root = packagesRoot) {
  const journal = JSON.parse(await readFile(path.join(root, journalPath), "utf8")) as {
    entries: { idx: number; version: string; tag: string; when: number; breakpoints: boolean }[];
  };
  assert.deepEqual(journal.entries, [
    { idx: 0, version: "7", when: 1794441600000, tag: "0000_platform_rate_limits", breakpoints: true },
    { idx: 1, version: "7", when: 1794441600001, tag: "0001_accounts", breakpoints: true },
    { idx: 2, version: "7", when: 1794441600002, tag: "0002_catalog_recordings", breakpoints: true },
    { idx: 3, version: "7", when: 1794441600003, tag: "0003_library_identity", breakpoints: true },
    { idx: 4, version: "7", when: 1794441600004, tag: "0004_library_listing", breakpoints: true },
    { idx: 5, version: "7", when: 1794441600005, tag: "0005_platform_events", breakpoints: true },
    { idx: 6, version: "7", when: 1794441600006, tag: "0006_platform_public_read_cache", breakpoints: true },
    { idx: 7, version: "7", when: 1794441600007, tag: "0007_catalog_startup_seed_receipts", breakpoints: true },
    { idx: 8, version: "7", when: 1794441600008, tag: "0008_catalog_listenbrainz_seed_ingestion", breakpoints: true },
    { idx: 9, version: "7", when: 1794441600009, tag: "0009_playback_listening_history", breakpoints: true },
  ]);
  return Promise.all(sqlPaths.map(async (relative, index) => ({
    hash: createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex"),
    created_at: String(journal.entries[index]!.when),
  })));
}

async function history(pool: pg.Pool) {
  return (await pool.query("SELECT hash, created_at FROM mint_migrations.__drizzle_migrations ORDER BY id")).rows;
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("Expected PostgreSQL lock state was not observed within five seconds");
}

test("startup composition rejects invalid explicit options before connecting", async () => {
  // This pool cannot connect; an attempted connection would produce a different error.
  const pool = new pg.Pool({ host: "/nonexistent-mint-startup-test", connectionTimeoutMillis: 100 });
  try {
    for (const lockTimeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
      await assert.rejects(runStartupMigrations(pool, { ...options, lockTimeoutMs }), /positive PostgreSQL int4/);
    }
    for (const root of ["", "packages", "/tmp/\0invalid"]) {
      await assert.rejects(runStartupMigrations(pool, { ...options, packagesRoot: root }), /explicit absolute/);
    }
    assert.equal(pool.totalCount, 0);
  } finally {
    await pool.end();
  }
});

test("serialized fresh-target startup on disposable PostgreSQL", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing local PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-startup-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture" };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  const config = { host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 1, connectionTimeoutMillis: 2_000 };
  const admin = new pg.Pool(config);
  let started = false;
  let databaseIndex = 0;
  async function database() {
    const name = `startup_fixture_${databaseIndex++}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const pool = new pg.Pool({ ...config, database: name, options: "-c lock_timeout=9s" });
    const observer = new pg.Pool({ ...config, database: name });
    return { pool, observer, config: { ...config, database: name } };
  }
  async function unlocked(observer: pg.Pool) {
    assert.equal((await observer.query(
      "SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    )).rows[0].count, 0);
  }
  async function reusable(pool: pg.Pool) {
    assert.equal(pool.totalCount, 1);
    assert.equal(pool.idleCount, 1);
    assert.equal((await pool.query("SHOW lock_timeout")).rows[0].lock_timeout, "9s");
    assert.equal((await pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
  }
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start",
    ], { env });
    started = true;
    assert.match((await admin.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await admin.query("SHOW listen_addresses")).rows[0].listen_addresses, "");

    await t.test("real central SQL applies twice on max-one pool with exact history and constraints", async () => {
      const { pool, observer } = await database();
      try {
        await runStartupMigrations(pool, { ...options, lockTimeoutMs: 2_147_483_647 });
        assert.deepEqual(await history(pool), await expectedHistory());
        assert.deepEqual((await pool.query(
          "SELECT to_regclass('catalog.listenbrainz_seed_ingestions')::text AS ingestions, to_regclass('catalog.listenbrainz_seed_observations')::text AS observations",
        )).rows, [{
          ingestions: "catalog.listenbrainz_seed_ingestions", observations: "catalog.listenbrainz_seed_observations",
        }]);
        assert.deepEqual((await pool.query(
          "SELECT to_regclass('platform.rate_limits')::text AS counter, to_regclass('accounts.users')::text AS users, to_regclass('accounts.sessions')::text AS sessions, to_regclass('catalog.recordings')::text AS recordings, to_regclass('library.roots')::text AS roots, to_regclass('library.media_files')::text AS media_files, to_regclass('library.media_files_verified_id_idx')::text AS verified_idx, to_regclass('playback.history_preferences')::text AS history_preferences, to_regclass('playback.listening_history')::text AS listening_history",
        )).rows, [{
          counter: "platform.rate_limits", users: "accounts.users", sessions: "accounts.sessions", recordings: "catalog.recordings",
          roots: "library.roots", media_files: "library.media_files", verified_idx: "library.media_files_verified_id_idx",
          history_preferences: "playback.history_preferences", listening_history: "playback.listening_history",
        }]);
        assert.equal((await pool.query(
          "SELECT pg_get_expr(indpred, indrelid) AS predicate FROM pg_index WHERE indexrelid = 'library.media_files_verified_id_idx'::regclass",
        )).rows[0].predicate, "(availability = 'verified'::text)");
        const recording = (await pool.query(
          "INSERT INTO catalog.recordings (title) VALUES ('Startup fixture') RETURNING *",
        )).rows[0];
        assert.match(recording.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(recording.version, null);
        assert.equal(recording.duration_ms, null);
        assert.equal(recording.explicit, null);
        assert.ok(recording.created_at instanceof Date);
        const root = (await pool.query(
          "INSERT INTO library.roots (path) VALUES ('/fixture/music') RETURNING *",
        )).rows[0];
        const media = (await pool.query(
          "INSERT INTO library.media_files (root_id, relative_path, recording_id) VALUES ($1, 'linked.flac', $2), ($1, 'unlinked.flac', NULL) RETURNING *",
          [root.id, recording.id],
        )).rows;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        assert.match(root.id, uuid);
        assert.match(media[0].id, uuid);
        assert.match(media[1].id, uuid);
        assert.notEqual(media[0].id, media[1].id);
        assert.equal(media[0].recording_id, recording.id);
        assert.equal(media[1].recording_id, null);
        assert.equal(media[0].availability, "unverified");
        assert.equal(media[0].checked_at, null);
        assert.equal(media[0].verified_at, null);
        assert.equal(media[0].audio_stream_index, null);
        assert.equal(media[0].audio_codec, null);
        assert.equal(media[0].decoded_sample_frames, null);
        assert.equal(media[0].imported_title, null);
        assert.equal(media[0].imported_artist, null);
        assert.equal(media[0].imported_album, null);
        assert.equal(media[0].imported_version, null);
        await runStartupMigrations(pool, options);
        assert.deepEqual(await history(pool), await expectedHistory());
        assert.deepEqual((await pool.query(
          "SELECT * FROM catalog.recordings",
        )).rows, [recording]);
        assert.deepEqual((await pool.query("SELECT * FROM library.roots")).rows, [root]);
        assert.deepEqual((await pool.query(
          "SELECT * FROM library.media_files ORDER BY relative_path",
        )).rows, media);
        await assert.rejects(pool.query("DELETE FROM library.roots WHERE id = $1", [root.id]), { code: "23503" });
        await assert.rejects(pool.query("DELETE FROM catalog.recordings WHERE id = $1", [recording.id]), { code: "23503" });
        assert.deepEqual((await pool.query("SELECT * FROM library.roots")).rows, [root]);
        assert.deepEqual((await pool.query("SELECT * FROM catalog.recordings")).rows, [recording]);
        assert.deepEqual((await pool.query(
          "SELECT * FROM library.media_files ORDER BY relative_path",
        )).rows, media);
        await assert.rejects(pool.query(
          "INSERT INTO catalog.recordings (title) VALUES ('   ')",
        ), { code: "23514", constraint: "recordings_title_nonempty" });
        await assert.rejects(pool.query(
          "INSERT INTO catalog.recordings (title, duration_ms) VALUES ('Invalid duration', 0)",
        ), { code: "23514", constraint: "recordings_duration_positive" });
        const inserted = await pool.query(
          "INSERT INTO accounts.users (email, name, password_hash) VALUES ('Member@fixture.test', 'Fixture', 'fixture-hash') RETURNING id, role, status",
        );
        assert.equal(inserted.rows[0].role, "user");
        assert.equal(inserted.rows[0].status, "pending");
        await assert.rejects(pool.query(
          "INSERT INTO accounts.users (email, name, password_hash) VALUES ('member@fixture.test', 'Duplicate', 'fixture-hash')",
        ), { code: "23505" });
        await assert.rejects(pool.query(
          "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ('orphan', '00000000-0000-0000-0000-000000000000', now())",
        ), { code: "23503" });
        await assert.rejects(pool.query(
          "INSERT INTO platform.rate_limits VALUES ('invalid', 0, now())",
        ), { code: "23514" });
        await pool.query("INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ('fixture-session', $1, now())", [inserted.rows[0].id]);
        await pool.query("DELETE FROM accounts.users WHERE id = $1", [inserted.rows[0].id]);
        assert.equal((await pool.query("SELECT count(*) FROM accounts.sessions")).rows[0].count, "0");
        await unlocked(observer);
        await reusable(pool);
      } finally {
        await Promise.all([pool.end(), observer.end()]);
      }
    });

    await t.test("startup upgrades a 0008 database without changing its durable seed receipt", async () => {
      const { pool, observer } = await database();
      try {
        const journal = JSON.parse(await readFile(path.join(packagesRoot, journalPath), "utf8")) as {
          version: string; dialect: string; entries: { tag: string }[];
        };
        const entries = journal.entries.slice(0, -1);
        await runMigrations(drizzle(pool), {
          journal: { ...journal, entries },
          migrationsRoot: packagesRoot,
          files: entries.map((entry, index) => ({ tag: entry.tag, path: sqlPaths[index]! })),
          history: { schema: "mint_migrations", table: "__drizzle_migrations" },
        });
        const key = "catalog:startup:lb-chart:global";
        const before = (await pool.query(
          "INSERT INTO catalog.startup_seed_receipts (key) VALUES ($1) RETURNING *", [key],
        )).rows;
        assert.equal((await pool.query("SELECT to_regclass('catalog.listenbrainz_seed_ingestions')::text AS table")).rows[0].table,
          "catalog.listenbrainz_seed_ingestions");
        assert.deepEqual(await history(pool), (await expectedHistory()).slice(0, -1));
        await runStartupMigrations(pool, options);
        assert.deepEqual(await history(pool), await expectedHistory());
        assert.deepEqual((await pool.query("SELECT * FROM catalog.startup_seed_receipts")).rows, before);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.listenbrainz_seed_ingestions")).rows[0].count, 0);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.listenbrainz_seed_observations")).rows[0].count, 0);
        assert.deepEqual((await pool.query(
          "SELECT to_regclass('playback.history_preferences')::text AS preferences, to_regclass('playback.listening_history')::text AS history",
        )).rows, [{
          preferences: "playback.history_preferences", history: "playback.listening_history",
        }]);
        await runStartupMigrations(pool, options);
        assert.deepEqual(await history(pool), await expectedHistory());
        assert.deepEqual((await pool.query("SELECT * FROM catalog.startup_seed_receipts")).rows, before);
        await unlocked(observer);
        await reusable(pool);
      } finally {
        await Promise.all([pool.end(), observer.end()]);
      }
    });

    await t.test("independent startup pools contend on a server advisory lock through the official migration", async () => {
      const { pool, observer, config: otherConfig } = await database();
      const other = new pg.Pool(otherConfig);
      const blocker = await observer.connect();
      let first: Promise<void> | undefined;
      let second: Promise<void> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE pg_catalog.pg_namespace IN SHARE MODE");
        first = runStartupMigrations(pool, options);
        await waitFor(async () => (await blocker.query(
          "SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()",
        )).rows[0].count === 1);
        second = runStartupMigrations(other, options);
        await waitFor(async () => (await blocker.query(
          "SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        )).rows[0].count === 1);
        await blocker.query("COMMIT");
        await Promise.all([first, second]);
        assert.deepEqual(await history(pool), await expectedHistory());
        await reusable(pool);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.allSettled([first, second]);
        await unlocked(observer);
        await Promise.all([pool.end(), other.end(), observer.end()]);
      }
    });

    await t.test("lock acquisition timeout stays bounded, propagates pg error and restores the client", async () => {
      const { pool, observer } = await database();
      const blocker = await observer.connect();
      try {
        await blocker.query("SELECT pg_advisory_lock($1::integer, $2::integer)", key);
        const start = performance.now();
        await assert.rejects(runStartupMigrations(pool, { ...options, lockTimeoutMs: 100 }), (error: unknown) => {
          assert.ok(error instanceof pg.DatabaseError);
          assert.equal(error.code, "55P03");
          assert.match(error.message, /lock timeout/);
          return true;
        });
        assert.ok(performance.now() - start >= 75);
        assert.ok(performance.now() - start < 2_000);
        await reusable(pool);
        assert.equal((await pool.query(
          "SELECT to_regnamespace('mint_migrations') AS history",
        )).rows[0].history, null);
      } finally {
        await blocker.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", key);
        blocker.release();
        await unlocked(observer);
        await runStartupMigrations(pool, options);
        await Promise.all([pool.end(), observer.end()]);
      }
    });

    await t.test("call-time journal failures release the lock and can be retried", async () => {
      const { pool, observer } = await database();
      const root = await copyArtifacts();
      const original = await readFile(path.join(root, journalPath), "utf8");
      try {
        await writeFile(path.join(root, journalPath), '{"version":"7","dialect":"postgresql","entries":[]}');
        await assert.rejects(runStartupMigrations(pool, { ...options, packagesRoot: root }), /match the central journal/);
        await unlocked(observer);
        await reusable(pool);
        await writeFile(path.join(root, journalPath), "not json");
        await assert.rejects(runStartupMigrations(pool, { ...options, packagesRoot: root }), SyntaxError);
        await unlocked(observer);
        await writeFile(path.join(root, journalPath), original);
        await runStartupMigrations(pool, { ...options, packagesRoot: root });
        assert.deepEqual(await history(pool), await expectedHistory());
      } finally {
        await Promise.all([pool.end(), observer.end()]);
        await rm(root, { recursive: true, force: true });
      }
    });

    await t.test("failed SQL rolls back without poisoning the pool or retaining locks; corrected artifacts retry", async () => {
      const { pool, observer } = await database();
      const root = await copyArtifacts();
      const accountSql = await readFile(path.join(root, sqlPaths[1]!), "utf8");
      try {
        await writeFile(path.join(root, sqlPaths[1]!), `${accountSql}\n--> statement-breakpoint\nINVALID STARTUP FIXTURE;\n`);
        await assert.rejects(runStartupMigrations(pool, { ...options, packagesRoot: root }), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!(error instanceof AggregateError));
          assert.match(error.message, /INVALID STARTUP FIXTURE/);
          assert.ok(error.cause instanceof pg.DatabaseError);
          assert.equal(error.cause.code, "42601");
          return true;
        });
        assert.deepEqual((await pool.query(
          "SELECT to_regnamespace('platform') AS platform, to_regnamespace('accounts') AS accounts, to_regnamespace('catalog') AS catalog, to_regnamespace('library') AS library, to_regnamespace('playback') AS playback, to_regclass('catalog.recordings') AS recordings, to_regclass('library.roots') AS roots, to_regclass('library.media_files') AS media_files",
        )).rows, [{ platform: null, accounts: null, catalog: null, library: null, playback: null, recordings: null, roots: null, media_files: null }]);
        assert.deepEqual(await history(pool), []);
        await unlocked(observer);
        await reusable(pool);
        await writeFile(path.join(root, sqlPaths[1]!), accountSql);
        await runStartupMigrations(pool, { ...options, packagesRoot: root });
        assert.deepEqual(await history(pool), await expectedHistory());
        assert.deepEqual((await pool.query(
          "SELECT to_regclass('platform.rate_limits')::text AS counter, to_regclass('accounts.users')::text AS users, to_regclass('accounts.sessions')::text AS sessions, to_regclass('catalog.recordings')::text AS recordings, to_regclass('library.roots')::text AS roots, to_regclass('library.media_files')::text AS media_files, to_regclass('playback.listening_history')::text AS listening_history",
        )).rows, [{
          counter: "platform.rate_limits", users: "accounts.users", sessions: "accounts.sessions", recordings: "catalog.recordings",
          roots: "library.roots", media_files: "library.media_files", listening_history: "playback.listening_history",
        }]);
        await reusable(pool);
      } finally {
        await Promise.all([pool.end(), observer.end()]);
        await rm(root, { recursive: true, force: true });
      }
    });

    await t.test("successful SQL cannot leave a changed session lock_timeout on the borrowed client", async () => {
      const { pool, observer } = await database();
      const root = await copyArtifacts();
      try {
        const sql = await readFile(path.join(root, sqlPaths[1]!), "utf8");
        await writeFile(path.join(root, sqlPaths[1]!), `${sql}\n--> statement-breakpoint\nSET lock_timeout = '123ms';\n`);
        await runStartupMigrations(pool, { ...options, packagesRoot: root });
        assert.deepEqual(await history(pool), await expectedHistory(root));
        await reusable(pool);
        await unlocked(observer);
      } finally {
        await Promise.all([pool.end(), observer.end()]);
        await rm(root, { recursive: true, force: true });
      }
    });

    await t.test("connection failure during migration aggregates cleanup failure and discards the client", async () => {
      const { pool, observer } = await database();
      const blocker = await observer.connect();
      let running: Promise<void> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE pg_catalog.pg_namespace IN SHARE MODE");
        running = runStartupMigrations(pool, options);
        const rejected = assert.rejects(running, (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.ok(error.errors.length >= 2);
          assert.match(error.message, /migration and cleanup failed/);
          return true;
        });
        // Attach immediately: a failed observation must not leave a rejected assertion unhandled.
        const observedRejection = rejected.then(() => undefined, (error: unknown) => error);
        await waitFor(async () => (await blocker.query(
          "SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'relation' AND NOT granted AND pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted)",
        )).rows[0].count === 1);
        await blocker.query(
          "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()",
        );
        const rejectionError = await observedRejection;
        if (rejectionError !== undefined) throw rejectionError;
        assert.equal(pool.totalCount, 0);
        await blocker.query("COMMIT");
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.allSettled([running]);
        await unlocked(observer);
        await runStartupMigrations(pool, options);
        await reusable(pool);
        await Promise.all([pool.end(), observer.end()]);
      }
    });

    await t.test("production source uses only explicit artifacts/pool and has no import-time startup", async () => {
      const source = await readFile(new URL("../src/startup-migrations.ts", import.meta.url), "utf8");
      assert.doesNotMatch(source, /process\.env|process\.cwd|DATABASE_URL|new Pool|new pg\.Pool/);
      assert.match(source, /drizzle\(client\)/);
      assert.doesNotMatch(source, /pool\.query/);
    });
  } finally {
    await admin.end();
    try {
      if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
    } finally {
      if (!existsSync(path.join(data, "postmaster.pid"))) await rm(cluster, { recursive: true, force: true });
    }
  }
});
