import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runMigrations, type MigrationOptions } from "@mint/platform";
import { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { catalogSchema, recordings } from "../src/index";

const exec = promisify(execFile);
const sqlFile = fileURLToPath(new URL("../migrations/0000_recordings.sql", import.meta.url));
const migration = readFileSync(sqlFile);
const options: MigrationOptions = {
  journal: {
    version: "7", dialect: "postgresql",
    entries: [{ idx: 0, version: "7", when: 100, tag: "0000_recordings", breakpoints: true }],
  },
  migrationsRoot: path.dirname(sqlFile),
  files: [{ tag: "0000_recordings", path: "0000_recordings.sql" }],
  history: { schema: "catalog_fixture_history", table: "migrations" },
};

const insert = { title: "Same title" } satisfies typeof recordings.$inferInsert;
const stored: typeof recordings.$inferSelect = {
  id: "12345678-1234-4234-8234-123456789012",
  title: insert.title,
  version: null,
  durationMs: null,
  explicit: null,
  createdAt: new Date(),
};
// @ts-expect-error Title is required.
const noTitle: typeof recordings.$inferInsert = {};
// @ts-expect-error A duration is numeric.
const badDuration: typeof recordings.$inferInsert = { title: "Title", durationMs: "123" };
// @ts-expect-error Explicit is boolean.
const badExplicit: typeof recordings.$inferInsert = { title: "Title", explicit: "yes" };
// @ts-expect-error There is no artist field in the minimal model.
const artist: typeof recordings.$inferInsert = { title: "Title", artist: "Artist" };
void [noTitle, badDuration, badExplicit, artist];

test("Drizzle metadata defines only the six requested fields, checks and simple FTS index", () => {
  const config = getTableConfig(recordings);
  const dialect = new PgDialect();
  assert.equal(catalogSchema.schemaName, "catalog");
  assert.equal(config.schema, "catalog");
  assert.equal(config.name, "recordings");
  assert.deepEqual(config.columns.map((column) => [
    column.name, column.getSQLType(), column.notNull, column.primary, column.hasDefault,
  ]), [
    ["id", "uuid", true, true, true],
    ["title", "text", true, false, false],
    ["version", "text", false, false, false],
    ["duration_ms", "integer", false, false, false],
    ["explicit", "boolean", false, false, false],
    ["created_at", "timestamp with time zone", true, false, true],
  ]);
  assert.equal(dialect.sqlToQuery(recordings.id.default as SQL).sql, "gen_random_uuid()");
  assert.equal(dialect.sqlToQuery(recordings.createdAt.default as SQL).sql, "now()");
  assert.deepEqual(config.checks.map((constraint) => [
    constraint.name, dialect.sqlToQuery(constraint.value).sql,
  ]), [
    ["recordings_title_nonempty", 'length(btrim("catalog"."recordings"."title")) > 0'],
    ["recordings_duration_positive", '"catalog"."recordings"."duration_ms" IS NULL OR "catalog"."recordings"."duration_ms" > 0'],
  ]);
  assert.equal(config.indexes.length, 1);
  const fts = config.indexes[0]?.config;
  assert.ok(fts);
  assert.equal(fts.name, "recordings_title_fts_idx");
  assert.equal(fts.method, "gin");
  assert.equal(fts.unique, false);
  assert.equal(fts.columns.length, 1);
  const expression = fts.columns[0];
  assert.ok(expression instanceof SQL);
  assert.equal(dialect.sqlToQuery(expression).sql, `to_tsvector('simple'::regconfig, "catalog"."recordings"."title")`);
  assert.deepEqual(config.foreignKeys, []);
  assert.deepEqual(config.uniqueConstraints, []);
  assert.deepEqual(config.primaryKeys, []);
  assert.deepEqual(config.policies, []);
  assert.equal(config.enableRLS, false);
  assert.equal(stored.version, null);
});

test("migration applies twice and enforces the Drizzle model on disposable PostgreSQL", async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to local PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-catalog-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const env: NodeJS.ProcessEnv = {
    ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  delete env.DATABASE_URL;
  const pool = new pg.Pool({ host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 1 });
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start",
    ], { env });
    assert.equal((await pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
    const db = drizzle(pool);
    await runMigrations(db, options);
    const history = await pool.query("SELECT hash, created_at FROM catalog_fixture_history.migrations");
    assert.deepEqual(history.rows, [{
      hash: createHash("sha256").update(migration).digest("hex"), created_at: "100",
    }]);

    const columnQuery = `
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_value
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'catalog.recordings'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `;
    const columns = await pool.query(columnQuery);
    assert.deepEqual(columns.rows, [
      { name: "id", type: "uuid", not_null: true, default_value: "gen_random_uuid()" },
      { name: "title", type: "text", not_null: true, default_value: null },
      { name: "version", type: "text", not_null: false, default_value: null },
      { name: "duration_ms", type: "integer", not_null: false, default_value: null },
      { name: "explicit", type: "boolean", not_null: false, default_value: null },
      { name: "created_at", type: "timestamp with time zone", not_null: true, default_value: "now()" },
    ]);
    const constraintQuery = `
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'catalog.recordings'::regclass ORDER BY conname
    `;
    const constraints = await pool.query(constraintQuery);
    assert.deepEqual(constraints.rows, [
      { conname: "recordings_duration_positive", contype: "c", definition: "CHECK (((duration_ms IS NULL) OR (duration_ms > 0)))" },
      { conname: "recordings_pkey", contype: "p", definition: "PRIMARY KEY (id)" },
      { conname: "recordings_title_nonempty", contype: "c", definition: "CHECK ((length(btrim(title)) > 0))" },
    ]);
    const indexes = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'catalog' AND tablename = 'recordings' ORDER BY indexname");
    assert.deepEqual(indexes.rows, [
      { indexname: "recordings_pkey", indexdef: "CREATE UNIQUE INDEX recordings_pkey ON catalog.recordings USING btree (id)" },
      { indexname: "recordings_title_fts_idx", indexdef: "CREATE INDEX recordings_title_fts_idx ON catalog.recordings USING gin (to_tsvector('simple'::regconfig, title))" },
    ]);

    const before = Date.now();
    const rows = await pool.query("INSERT INTO catalog.recordings (title) VALUES ($1), ($1) RETURNING *", ["Same title"]);
    assert.equal(rows.rowCount, 2);
    assert.notEqual(rows.rows[0].id, rows.rows[1].id);
    for (const row of rows.rows) {
      assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(row.title, "Same title");
      assert.equal(row.version, null);
      assert.equal(row.duration_ms, null);
      assert.equal(row.explicit, null);
      assert.ok(row.created_at instanceof Date);
      assert.ok(row.created_at.getTime() >= before && row.created_at.getTime() <= Date.now());
    }
    const populated = await pool.query(
      "INSERT INTO catalog.recordings (title, version, duration_ms, explicit) VALUES ($1, $2, $3, $4), ($1, $2, $5, $4) RETURNING *",
      ["Title", "Live", 1, false, 2147483647],
    );
    assert.deepEqual(populated.rows.map((row) => [row.version, row.duration_ms, row.explicit]), [
      ["Live", 1, false], ["Live", 2147483647, false],
    ]);
    for (const title of ["", "   "]) {
      await assert.rejects(pool.query("INSERT INTO catalog.recordings (title) VALUES ($1)", [title]), { code: "23514" });
    }
    await assert.rejects(pool.query("INSERT INTO catalog.recordings (title) VALUES (NULL)"), { code: "23502" });
    for (const duration of [0, -1, -2147483648]) {
      await assert.rejects(pool.query("INSERT INTO catalog.recordings (title, duration_ms) VALUES ('Title', $1)", [duration]), { code: "23514" });
    }
    const persisted = await pool.query("SELECT * FROM catalog.recordings ORDER BY id");
    await runMigrations(db, options);
    assert.deepEqual((await pool.query("SELECT hash, created_at FROM catalog_fixture_history.migrations")).rows, history.rows);
    assert.deepEqual((await pool.query("SELECT * FROM catalog.recordings ORDER BY id")).rows, persisted.rows);
    assert.deepEqual((await pool.query(columnQuery)).rows, columns.rows);
    assert.deepEqual((await pool.query(constraintQuery)).rows, constraints.rows);
    assert.deepEqual((await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'catalog' AND tablename = 'recordings' ORDER BY indexname")).rows, indexes.rows);
    assert.equal((await pool.query("SELECT count(*) FROM catalog.recordings WHERE to_tsvector('simple'::regconfig, title) @@ to_tsquery('simple'::regconfig, 'same')")).rows[0].count, "2");
  } finally {
    try {
      await pool.end();
    } finally {
      if (existsSync(path.join(data, "postmaster.pid"))) {
        await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
      }
      if (!existsSync(path.join(data, "postmaster.pid"))) {
        await rm(cluster, { recursive: true, force: true });
        assert.equal(existsSync(cluster), false);
      }
    }
  }
});
