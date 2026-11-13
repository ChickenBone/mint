import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { PostgresRateLimiter, rateLimits, runMigrations, type MigrationOptions } from "../src/index";

const exec = promisify(execFile);
const migrationsRoot = fileURLToPath(new URL("../migrations", import.meta.url));
const options: MigrationOptions = {
  journal: {
    version: "7",
    dialect: "postgresql",
    entries: [{ idx: 0, version: "7", when: 100, tag: "0000_rate_limits", breakpoints: true }],
  },
  migrationsRoot,
  files: [{ tag: "0000_rate_limits", path: "0000_rate_limits.sql" }],
  history: { schema: "fixture_history", table: "migrations" },
};

test("validates numeric bounds before storage and propagates storage failures unchanged", async () => {
  const failure = new Error("fixture storage failure");
  let queries = 0;
  const limiter = new PostgresRateLimiter({
    query: async () => { queries++; throw failure; },
  });
  for (const invalid of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(limiter.allow("", invalid, 900), RangeError);
  }
  for (const invalid of [0, -1, 0.1, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(limiter.allow("", 8, invalid), RangeError);
    await assert.rejects(limiter.cleanupExpired(invalid), RangeError);
  }
  assert.equal(queries, 0);
  await assert.rejects(limiter.allow("", Number.MAX_SAFE_INTEGER, 2_147_483_647), (error) => error === failure);
  await assert.rejects(limiter.cleanupExpired(2_147_483_647), (error) => error === failure);
  assert.equal(queries, 2);
});

test("fixed-window admission on disposable PostgreSQL", async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin), "PostgreSQL binary directory must be absolute");
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-rate-limit-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture" };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  delete env.PGOPTIONS;
  delete env.DATABASE_URL;
  const config: pg.PoolConfig = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    connectionTimeoutMillis: 3_000, query_timeout: 15_000, max: 10,
    options: "-c statement_timeout=10000",
  };
  const firstPool = new pg.Pool({ ...config, application_name: "rate_limit_fixture_first" });
  const secondPool = new pg.Pool({ ...config, application_name: "rate_limit_fixture_second" });
  const pendingClients = new Set<pg.PoolClient>();
  const clientEndings: Promise<void>[] = [];
  for (const pool of [firstPool, secondPool]) {
    pool.on("connect", (client: pg.PoolClient) => {
      pendingClients.add(client);
      clientEndings.push(new Promise<void>((resolve) => {
        client.once("end", () => {
          pendingClients.delete(client);
          resolve();
        });
      }));
    });
  }
  const first = new PostgresRateLimiter(firstPool);
  const second = new PostgresRateLimiter(secondPool);
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env, timeout: 60_000 });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "-t", "15", "start",
    ], { env, timeout: 30_000 });
    assert.equal((await firstPool.query("SELECT 1 AS ready")).rows[0].ready, 1);
    assert.match((await firstPool.query("SHOW server_version")).rows[0].server_version, /^16\./);
    await runMigrations(drizzle(firstPool), options);

    await t.test("SQL migration is replay-safe through explicit fixture history and matches Drizzle metadata", async () => {
      await runMigrations(drizzle(firstPool), options);
      const source = await readFile(path.join(migrationsRoot, "0000_rate_limits.sql"));
      assert.deepEqual((await firstPool.query("SELECT hash, created_at FROM fixture_history.migrations")).rows, [
        { hash: createHash("sha256").update(source).digest("hex"), created_at: "100" },
      ]);
      const metadata = getTableConfig(rateLimits);
      assert.equal(metadata.schema, "platform");
      assert.equal(metadata.name, "rate_limits");
      const columns = await firstPool.query(`
        SELECT column_name AS name, data_type AS type, is_nullable = 'NO' AS "notNull"
        FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'rate_limits' ORDER BY ordinal_position
      `);
      assert.deepEqual(columns.rows, metadata.columns.map((column) => ({
        name: column.name, type: column.getSQLType(), notNull: column.notNull,
      })));
      const constraints = await firstPool.query(`
        SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid = 'platform.rate_limits'::regclass ORDER BY contype
      `);
      assert.deepEqual(constraints.rows, [
        { name: metadata.checks[0]!.name, type: "c", definition: "CHECK ((attempts > 0))" },
        { name: "rate_limits_pkey", type: "p", definition: "PRIMARY KEY (key)" },
      ]);
      assert.equal(rateLimits.key.primary, true);
      const dialect = new PgDialect();
      assert.equal(dialect.sqlToQuery(metadata.checks[0]!.value).sql, '"platform"."rate_limits"."attempts" > 0');
      const expiryIndex = metadata.indexes[0]!.config;
      assert.equal(expiryIndex.name, "rate_limits_expiry_idx");
      assert.equal(expiryIndex.method, "btree");
      assert.deepEqual(expiryIndex.columns.map((column) => "name" in column ? column.name : null), ["expires_at"]);
      assert.deepEqual((await firstPool.query(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'platform' AND tablename = 'rate_limits' ORDER BY indexname
      `)).rows, [
        { indexname: "rate_limits_expiry_idx", indexdef: "CREATE INDEX rate_limits_expiry_idx ON platform.rate_limits USING btree (expires_at)" },
        { indexname: "rate_limits_pkey", indexdef: "CREATE UNIQUE INDEX rate_limits_pkey ON platform.rate_limits USING btree (key)" },
      ]);
    });

    await t.test("20/IP and 8/email: first hit starts expiry, denied hits count and never extend it", async () => {
      for (const [key, limit] of [["login:ip:fixture", 20], ["login:email:fixture@example.test", 8]] as const) {
        const before = (await firstPool.query("SELECT clock_timestamp() AS now")).rows[0].now;
        assert.equal(await first.allow(key, limit, 900), true);
        const initial = (await firstPool.query("SELECT *, expires_at::text AS expiry FROM platform.rate_limits WHERE key = $1", [key])).rows[0];
        const after = (await firstPool.query("SELECT clock_timestamp() AS now")).rows[0].now;
        assert.equal(initial.attempts, "1");
        assert.ok(initial.expires_at.getTime() >= before.getTime() + 900_000);
        assert.ok(initial.expires_at.getTime() <= after.getTime() + 900_000);
        for (let attempt = 2; attempt <= limit + 3; attempt++) {
          // A different requested duration must not mutate an already-live window.
          assert.equal(await second.allow(key, limit, 1_800), attempt <= limit);
        }
        const final = (await firstPool.query(`
          SELECT attempts, expires_at::text AS expiry
          FROM platform.rate_limits WHERE key = $1
        `, [key])).rows[0];
        assert.equal(final.attempts, String(limit + 3));
        assert.equal(final.expiry, initial.expiry);
      }
      assert.equal((await firstPool.query("SELECT count(*) FROM platform.rate_limits")).rows[0].count, "2");
    });

    await t.test("all attempts retain exact database expiry including microseconds", async () => {
      await first.allow("exact-expiry", 1, 900);
      const initial = (await firstPool.query("SELECT expires_at::text AS expiry FROM platform.rate_limits WHERE key = 'exact-expiry'")).rows[0].expiry;
      assert.equal(await second.allow("exact-expiry", 1, 1), false);
      assert.equal((await firstPool.query("SELECT expires_at::text AS expiry FROM platform.rate_limits WHERE key = 'exact-expiry'")).rows[0].expiry, initial);
    });

    await t.test("two independent pools admit exactly 20 of 100 concurrent attempts", async () => {
      const admitted = await Promise.all(Array.from({ length: 100 }, (_, index) =>
        (index % 2 ? first : second).allow("concurrent", 20, 900)));
      assert.equal(admitted.filter(Boolean).length, 20);
      assert.equal((await firstPool.query("SELECT attempts FROM platform.rate_limits WHERE key = 'concurrent'")).rows[0].attempts, "100");
      const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
        (index % 2 ? second : first).allow("independent", 8, 900)));
      assert.equal(results.filter(Boolean).length, 8);
      assert.equal((await firstPool.query("SELECT attempts FROM platform.rate_limits WHERE key = 'concurrent'")).rows[0].attempts, "100");
    });

    await t.test("expired rows reset atomically with the new duration, without waiting for wall time", async () => {
      await firstPool.query("UPDATE platform.rate_limits SET expires_at = clock_timestamp() - interval '1 second' WHERE key = 'concurrent'");
      assert.equal(await second.allow("concurrent", 20, 60), true);
      const reset = (await firstPool.query(`
        SELECT attempts, expires_at > clock_timestamp() + interval '59 seconds' AS future,
          expires_at <= clock_timestamp() + interval '60 seconds' AS bounded
        FROM platform.rate_limits WHERE key = 'concurrent'
      `)).rows[0];
      assert.deepEqual(reset, { attempts: "1", future: true, bounded: true });
    });

    await t.test("conflict fencing reads the database clock after waiting for the row lock", async () => {
      await first.allow("locked", 1, 900);
      const locker = await firstPool.connect();
      let pending: Promise<boolean> | undefined;
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT key FROM platform.rate_limits WHERE key = 'locked' FOR UPDATE");
        pending = second.allow("locked", 1, 900);
        // Observe actual server lock contention, not a timing assumption.
        const deadline = performance.now() + 5_000;
        while (true) {
          const waiting = await firstPool.query(`
            SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'rate_limit_fixture_second'
              AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO platform.rate_limits%'
          `);
          if (waiting.rowCount) break;
          assert.ok(performance.now() < deadline, "Admission did not reach the locked conflict");
          await delay(5);
        }
        await locker.query("UPDATE platform.rate_limits SET expires_at = clock_timestamp() WHERE key = 'locked'");
        await locker.query("COMMIT");
        assert.equal(await pending, true);
        assert.equal((await firstPool.query("SELECT attempts FROM platform.rate_limits WHERE key = 'locked'")).rows[0].attempts, "1");
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
        if (pending) await pending;
      }
    });

    await t.test("empty and SQL-shaped keys are opaque, isolated parameters; maximum inputs fit storage", async () => {
      const quoted = "'; DROP TABLE platform.rate_limits; --";
      assert.equal(await first.allow("", 1, 900), true);
      assert.equal(await second.allow("", 1, 900), false);
      assert.equal(await first.allow(quoted, 1, 900), true);
      assert.equal(await first.allow("maximum", Number.MAX_SAFE_INTEGER, 2_147_483_647), true);
      await firstPool.query("UPDATE platform.rate_limits SET attempts = $1 WHERE key = 'maximum'", [String(Number.MAX_SAFE_INTEGER - 1)]);
      assert.equal(await first.allow("maximum", Number.MAX_SAFE_INTEGER, 1), true);
      assert.equal(await first.allow("maximum", Number.MAX_SAFE_INTEGER, 1), false);
      assert.equal((await firstPool.query("SELECT attempts FROM platform.rate_limits WHERE key = $1", [quoted])).rows[0].attempts, "1");
    });

    await t.test("bigint overflow and genuine database failures propagate, without changing counters", async () => {
      await first.allow("overflow", 1, 900);
      await firstPool.query("UPDATE platform.rate_limits SET attempts = 9223372036854775807 WHERE key = 'overflow'");
      await assert.rejects(first.allow("overflow", 1, 900), { code: "22003" });
      assert.equal((await firstPool.query("SELECT attempts FROM platform.rate_limits WHERE key = 'overflow'")).rows[0].attempts, "9223372036854775807");
      const client = await firstPool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const readOnly = new PostgresRateLimiter(client);
        await assert.rejects(readOnly.allow("read-only", 1, 900), { code: "25006" });
        await client.query("ROLLBACK");
        await client.query("BEGIN READ ONLY");
        await assert.rejects(readOnly.cleanupExpired(1), { code: "25006" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    await t.test("cleanup is batch-bounded and preserves live and concurrently refreshed rows", async () => {
      await firstPool.query("TRUNCATE platform.rate_limits");
      await firstPool.query(`
        INSERT INTO platform.rate_limits (key, attempts, expires_at)
        SELECT 'expired-' || n, 5, clock_timestamp() - interval '1 second' FROM generate_series(1, 5) AS n
      `);
      await first.allow("live", 1, 900);
      const locker = await firstPool.connect();
      try {
        await locker.query("BEGIN");
        await locker.query("UPDATE platform.rate_limits SET expires_at = clock_timestamp() + interval '900 seconds' WHERE key = 'expired-1'");
        assert.equal(await second.cleanupExpired(2), 2);
        await locker.query("COMMIT");
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }
      assert.equal((await firstPool.query("SELECT count(*) FROM platform.rate_limits")).rows[0].count, "4");
      assert.equal(await first.cleanupExpired(2), 2);
      assert.equal(await second.cleanupExpired(2), 0);
      assert.deepEqual((await firstPool.query("SELECT key, attempts FROM platform.rate_limits ORDER BY key")).rows, [
        { key: "expired-1", attempts: "5" }, { key: "live", attempts: "1" },
      ]);
      assert.equal(await second.allow("live", 1, 900), false);
    });
  } finally {
    const drain = await Promise.allSettled([(async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await Promise.all([firstPool.end(), secondPool.end()]);
            // Pool removal precedes socket closure in pg-pool; await the clients too.
            t.diagnostic(`Pool end resolved with ${pendingClients.size}/${clientEndings.length} clients still awaiting end`);
            await Promise.all(clientEndings);
            assert.equal(pendingClients.size, 0, "Every owned client must emit end before PostgreSQL stops");
            t.diagnostic(`All ${clientEndings.length} owned clients emitted end before PostgreSQL stop`);
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(
              `PostgreSQL pool/client drain timed out with ${pendingClients.size} clients awaiting end`,
            )), 15_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    })()]);
    // A failed drain must still stop the owned server, without masking either failure.
    const cleanup = await Promise.allSettled([(async () => {
      // Even a startup timeout may leave an owned server; never delete active data.
      if (existsSync(path.join(data, "postmaster.pid"))) {
        await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "15", "stop"], { env, timeout: 30_000 });
      }
      assert.equal(existsSync(path.join(data, "postmaster.pid")), false);
      await rm(cluster, { recursive: true, force: true });
    })()]);
    const failures = [...drain, ...cleanup].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Rate-limit PostgreSQL fixture teardown failed");
  }
  assert.equal(existsSync(cluster), false);
});
