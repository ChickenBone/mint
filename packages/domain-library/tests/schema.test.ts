import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordings } from "@mint/domain-catalog";
import { runMigrations, type MigrationOptions } from "@mint/platform";
import { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { librarySchema, mediaFiles, roots } from "../src/index";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");
const rootsMigrationPath = path.join(packageRoot, "migrations/0000_library_identity.sql");
const catalogMigrationPath = path.join(repositoryRoot, "packages/domain-catalog/migrations/0000_recordings.sql");
const rootsMigration = readFileSync(rootsMigrationPath);
const catalogMigration = readFileSync(catalogMigrationPath);
const options: MigrationOptions = {
  journal: {
    version: "7",
    dialect: "postgresql",
    entries: [
      { idx: 0, version: "7", when: 100, tag: "0000_recordings", breakpoints: true },
      { idx: 1, version: "7", when: 200, tag: "0001_library_identity", breakpoints: true },
    ],
  },
  migrationsRoot: repositoryRoot,
  files: [
    { tag: "0000_recordings", path: "packages/domain-catalog/migrations/0000_recordings.sql" },
    { tag: "0001_library_identity", path: "packages/domain-library/migrations/0000_library_identity.sql" },
  ],
  history: { schema: "library_fixture_history", table: "migrations" },
};

const rootInsert = { path: "/music" } satisfies typeof roots.$inferInsert;
const mediaFileInsert = {
  rootId: "12345678-1234-4234-8234-123456789012",
  relativePath: "Album/Track.flac",
  recordingId: null,
} satisfies typeof mediaFiles.$inferInsert;
const storedRoot: typeof roots.$inferSelect = {
  id: "12345678-1234-4234-8234-123456789012",
  path: rootInsert.path,
  createdAt: new Date(),
};
const storedMediaFile: typeof mediaFiles.$inferSelect = {
  id: "12345678-1234-4234-8234-123456789013",
  rootId: mediaFileInsert.rootId,
  relativePath: mediaFileInsert.relativePath,
  recordingId: mediaFileInsert.recordingId,
  createdAt: new Date(),
  availability: "unverified",
  checkedAt: null,
  verifiedAt: null,
  unavailableReason: null,
  audioStreamIndex: null,
  audioCodec: null,
  decodedSampleFrames: null,
  durationMs: null,
  importedTitle: null,
  importedArtist: null,
  importedAlbum: null,
  importedVersion: null,
};
// @ts-expect-error A root path is required.
const noRootPath: typeof roots.$inferInsert = {};
// @ts-expect-error A root path is text.
const badRootPath: typeof roots.$inferInsert = { path: 42 };
// @ts-expect-error Media files require a root.
const noMediaRoot: typeof mediaFiles.$inferInsert = { relativePath: "Track.flac" };
// @ts-expect-error A recording ID is a UUID string or null.
const badRecordingId: typeof mediaFiles.$inferInsert = { rootId: mediaFileInsert.rootId, relativePath: "Track.flac", recordingId: 42 };
// @ts-expect-error Availability is an explicit verification state, not a boolean.
const availability: typeof mediaFiles.$inferInsert = { rootId: mediaFileInsert.rootId, relativePath: "Track.flac", availability: true };
void [noRootPath, badRootPath, noMediaRoot, badRecordingId, availability, storedRoot, storedMediaFile, recordings];

test("Drizzle metadata preserves Library identity and adds persisted verification/display fields", () => {
  const dialect = new PgDialect();
  const rootConfig = getTableConfig(roots);
  const mediaConfig = getTableConfig(mediaFiles);

  assert.equal(librarySchema.schemaName, "library");
  assert.equal(rootConfig.schema, "library");
  assert.equal(rootConfig.name, "roots");
  assert.deepEqual(rootConfig.columns.map((column) => [
    column.name, column.getSQLType(), column.notNull, column.primary, column.hasDefault,
  ]), [
    ["id", "uuid", true, true, true],
    ["path", "text", true, false, false],
    ["created_at", "timestamp with time zone", true, false, true],
  ]);
  assert.equal(dialect.sqlToQuery(roots.id.default as SQL).sql, "gen_random_uuid()");
  assert.equal(dialect.sqlToQuery(roots.createdAt.default as SQL).sql, "now()");
  assert.deepEqual(rootConfig.checks.map((constraint) => [
    constraint.name, dialect.sqlToQuery(constraint.value).sql,
  ]), [
    ["roots_path_nonempty", 'length(btrim("library"."roots"."path")) > 0'],
  ]);
  assert.deepEqual(rootConfig.indexes, []);
  assert.deepEqual(rootConfig.foreignKeys, []);

  assert.equal(mediaConfig.schema, "library");
  assert.equal(mediaConfig.name, "media_files");
  assert.deepEqual(mediaConfig.columns.map((column) => [
    column.name, column.getSQLType(), column.notNull, column.primary, column.hasDefault,
  ]), [
    ["id", "uuid", true, true, true],
    ["root_id", "uuid", true, false, false],
    ["relative_path", "text", true, false, false],
    ["recording_id", "uuid", false, false, false],
    ["created_at", "timestamp with time zone", true, false, true],
    ["availability", "text", true, false, true],
    ["checked_at", "timestamp with time zone", false, false, false],
    ["verified_at", "timestamp with time zone", false, false, false],
    ["unavailable_reason", "text", false, false, false],
    ["audio_stream_index", "integer", false, false, false],
    ["audio_codec", "text", false, false, false],
    ["decoded_sample_frames", "integer", false, false, false],
    ["duration_ms", "integer", false, false, false],
    ["imported_title", "text", false, false, false],
    ["imported_artist", "text", false, false, false],
    ["imported_album", "text", false, false, false],
    ["imported_version", "text", false, false, false],
  ]);
  assert.equal(dialect.sqlToQuery(mediaFiles.id.default as SQL).sql, "gen_random_uuid()");
  assert.equal(dialect.sqlToQuery(mediaFiles.createdAt.default as SQL).sql, "now()");
  assert.deepEqual(mediaConfig.checks.slice(0, 1).map((constraint) => [
    constraint.name, dialect.sqlToQuery(constraint.value).sql,
  ]), [
    ["media_files_relative_path_nonempty", 'length(btrim("library"."media_files"."relative_path")) > 0'],
  ]);
  assert.deepEqual(mediaConfig.checks.slice(1).map((constraint) => constraint.name), [
    "media_files_availability_valid", "media_files_verification_evidence",
    "media_files_unavailable_reason", "media_files_duration_positive",
  ]);
  assert.equal(mediaFiles.availability.default, "unverified");
  assert.deepEqual(mediaConfig.foreignKeys.map((key) => [key.getName(), key.onDelete, key.onUpdate]), [
    ["media_files_root_fk", "restrict", "no action"],
    ["media_files_recording_fk", "restrict", "no action"],
  ]);
  assert.deepEqual(mediaConfig.indexes.map(({ config }) => [
    config.name, config.unique, config.columns.map((column) =>
      column instanceof SQL ? dialect.sqlToQuery(column).sql : (column as { name: string }).name),
  ]), [
    ["media_files_root_id_relative_path_idx", true, ["root_id", "relative_path"]],
    ["media_files_recording_id_idx", false, ["recording_id"]],
    ["media_files_verified_id_idx", false, ["id"]],
  ]);
  assert.deepEqual(mediaConfig.uniqueConstraints, []);
  assert.deepEqual(mediaConfig.policies, []);
  assert.equal(mediaConfig.enableRLS, false);
  assert.equal(storedMediaFile.recordingId, null);
});

test("catalog and Library migrations apply in order, replay, and enforce identity constraints on PostgreSQL", async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to local PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin), "PostgreSQL binaries must be specified by absolute directory");

  const testDataRoot = path.join(repositoryRoot, ".test-data");
  const cluster = path.join(testDataRoot, `library-pg-${process.pid}-${randomUUID().slice(0, 8)}`);
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "s");
  const originalRootPath = path.join(cluster, "read-only-originals");
  const originalFilePath = path.join(originalRootPath, "keep-me.flac");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: socket,
    PGPORT: "5432",
    PGDATABASE: "postgres",
    PGUSER: "fixture",
  };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  delete env.DATABASE_URL;
  let started = false;
  let failed = false;
  const pool = new pg.Pool({
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 1,
  });

  try {
    await mkdir(testDataRoot, { recursive: true });
    await mkdir(cluster);
    await mkdir(socket);
    await mkdir(originalRootPath);
    await writeFile(originalFilePath, "original-media-bytes");
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "start",
    ], { env });
    started = true;
    assert.equal((await pool.query("SELECT 1 AS ready")).rows[0].ready, 1);

    const db = drizzle(pool);
    await runMigrations(db, options);
    const history = await pool.query(
      "SELECT hash, created_at FROM library_fixture_history.migrations ORDER BY created_at",
    );
    assert.deepEqual(history.rows, [
      { hash: createHash("sha256").update(catalogMigration).digest("hex"), created_at: "100" },
      { hash: createHash("sha256").update(rootsMigration).digest("hex"), created_at: "200" },
    ]);

    const columnQuery = `
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_value
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `;
    const rootColumns = await pool.query(columnQuery, ["library.roots"]);
    assert.deepEqual(rootColumns.rows, [
      { name: "id", type: "uuid", not_null: true, default_value: "gen_random_uuid()" },
      { name: "path", type: "text", not_null: true, default_value: null },
      { name: "created_at", type: "timestamp with time zone", not_null: true, default_value: "now()" },
    ]);
    const mediaColumns = await pool.query(columnQuery, ["library.media_files"]);
    assert.deepEqual(mediaColumns.rows, [
      { name: "id", type: "uuid", not_null: true, default_value: "gen_random_uuid()" },
      { name: "root_id", type: "uuid", not_null: true, default_value: null },
      { name: "relative_path", type: "text", not_null: true, default_value: null },
      { name: "recording_id", type: "uuid", not_null: false, default_value: null },
      { name: "created_at", type: "timestamp with time zone", not_null: true, default_value: "now()" },
    ]);

    const constraints = await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN ('library.roots'::regclass, 'library.media_files'::regclass)
      ORDER BY conname
    `);
    assert.deepEqual(constraints.rows, [
      { conname: "media_files_pkey", contype: "p", definition: "PRIMARY KEY (id)" },
      { conname: "media_files_recording_fk", contype: "f", definition: "FOREIGN KEY (recording_id) REFERENCES catalog.recordings(id) ON DELETE RESTRICT" },
      { conname: "media_files_relative_path_nonempty", contype: "c", definition: "CHECK ((length(btrim(relative_path)) > 0))" },
      { conname: "media_files_root_fk", contype: "f", definition: "FOREIGN KEY (root_id) REFERENCES library.roots(id) ON DELETE RESTRICT" },
      { conname: "roots_path_nonempty", contype: "c", definition: "CHECK ((length(btrim(path)) > 0))" },
      { conname: "roots_pkey", contype: "p", definition: "PRIMARY KEY (id)" },
    ]);
    const indexes = await pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'library' ORDER BY indexname
    `);
    assert.deepEqual(indexes.rows, [
      { indexname: "media_files_pkey", indexdef: "CREATE UNIQUE INDEX media_files_pkey ON library.media_files USING btree (id)" },
      { indexname: "media_files_recording_id_idx", indexdef: "CREATE INDEX media_files_recording_id_idx ON library.media_files USING btree (recording_id)" },
      { indexname: "media_files_root_id_relative_path_idx", indexdef: "CREATE UNIQUE INDEX media_files_root_id_relative_path_idx ON library.media_files USING btree (root_id, relative_path)" },
      { indexname: "roots_pkey", indexdef: "CREATE UNIQUE INDEX roots_pkey ON library.roots USING btree (id)" },
    ]);
    const deleteActions = await pool.query(`
      SELECT conname, confdeltype, confupdtype
      FROM pg_constraint
      WHERE conrelid = 'library.media_files'::regclass AND contype = 'f'
      ORDER BY conname
    `);
    assert.deepEqual(deleteActions.rows, [
      { conname: "media_files_recording_fk", confdeltype: "r", confupdtype: "a" },
      { conname: "media_files_root_fk", confdeltype: "r", confupdtype: "a" },
    ]);

    const root = (await pool.query(
      "INSERT INTO library.roots (path) VALUES ($1) RETURNING id, created_at",
      [originalRootPath],
    )).rows[0] as { id: string; created_at: Date };
    const samePathRoot = (await pool.query(
      "INSERT INTO library.roots (path) VALUES ($1) RETURNING id",
      [originalRootPath],
    )).rows[0].id as string;
    assert.notEqual(root.id, samePathRoot);
    assert.match(root.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(root.created_at instanceof Date);
    for (const invalidPath of ["", "   "]) {
      await assert.rejects(pool.query("INSERT INTO library.roots (path) VALUES ($1)", [invalidPath]), { code: "23514" });
    }

    const recordingA = (await pool.query(
      "INSERT INTO catalog.recordings (title) VALUES ('Recording A') RETURNING id",
    )).rows[0].id as string;
    const recordingB = (await pool.query(
      "INSERT INTO catalog.recordings (title) VALUES ('Recording B') RETURNING id",
    )).rows[0].id as string;
    await assert.rejects(pool.query(
      "INSERT INTO library.media_files (root_id, relative_path) VALUES ($1, 'orphan.flac')",
      ["12345678-1234-4234-8234-123456789012"],
    ), { code: "23503" });
    await assert.rejects(pool.query(
      "INSERT INTO library.media_files (root_id, relative_path, recording_id) VALUES ($1, 'missing-recording.flac', $2)",
      [root.id, "12345678-1234-4234-8234-123456789014"],
    ), { code: "23503" });
    await assert.rejects(pool.query(
      "INSERT INTO library.media_files (root_id, relative_path) VALUES ($1, '   ')",
      [root.id],
    ), { code: "23514" });

    const file1 = (await pool.query(
      "INSERT INTO library.media_files (root_id, relative_path, recording_id) VALUES ($1, $2, $3) RETURNING id",
      [root.id, "Album/track.flac", recordingA],
    )).rows[0].id as string;
    const file2 = (await pool.query(
      "INSERT INTO library.media_files (root_id, relative_path, recording_id) VALUES ($1, $2, $3) RETURNING id",
      [root.id, "Album/track-live.flac", recordingA],
    )).rows[0].id as string;
    const file3 = (await pool.query(
      "INSERT INTO library.media_files (root_id, relative_path, recording_id) VALUES ($1, $2, $3) RETURNING id",
      [samePathRoot, "Album/track.flac", recordingA],
    )).rows[0].id as string;
    const unmatched = (await pool.query(
      "INSERT INTO library.media_files (root_id, relative_path) VALUES ($1, 'Unknown/untagged.flac') RETURNING id",
      [root.id],
    )).rows[0].id as string;
    assert.equal(new Set([file1, file2, file3, unmatched]).size, 4);
    await assert.rejects(pool.query(
      "INSERT INTO library.media_files (root_id, relative_path) VALUES ($1, 'Album/track.flac')",
      [root.id],
    ), { code: "23505" });
    const otherRootDuplicate = await pool.query(
      "SELECT count(*) FROM library.media_files WHERE root_id = $1 AND relative_path = 'Album/track.flac'",
      [samePathRoot],
    );
    assert.equal(otherRootDuplicate.rows[0].count, "1");

    const filesBeforeRejectedRootDelete = await pool.query(
      "SELECT id, root_id, relative_path, recording_id FROM library.media_files ORDER BY id",
    );
    await assert.rejects(pool.query("DELETE FROM library.roots WHERE id = $1", [root.id]), { code: "23503" });
    assert.equal((await pool.query("SELECT count(*) FROM library.roots WHERE id = $1", [root.id])).rows[0].count, "1");
    assert.deepEqual((await pool.query(
      "SELECT id, root_id, relative_path, recording_id FROM library.media_files ORDER BY id",
    )).rows, filesBeforeRejectedRootDelete.rows);

    const filesBeforeRejectedRecordingDelete = await pool.query(
      "SELECT id, root_id, relative_path, recording_id FROM library.media_files ORDER BY id",
    );
    await assert.rejects(pool.query("DELETE FROM catalog.recordings WHERE id = $1", [recordingA]), { code: "23503" });
    assert.equal((await pool.query("SELECT count(*) FROM catalog.recordings WHERE id = $1", [recordingA])).rows[0].count, "1");
    assert.deepEqual((await pool.query(
      "SELECT id, root_id, relative_path, recording_id FROM library.media_files ORDER BY id",
    )).rows, filesBeforeRejectedRecordingDelete.rows);

    await pool.query("UPDATE library.media_files SET recording_id = $1 WHERE id = $2", [recordingB, file2]);
    await pool.query("UPDATE library.media_files SET recording_id = NULL WHERE id = $1", [file1]);
    await pool.query("UPDATE library.media_files SET recording_id = $1 WHERE id = $2", [recordingB, file3]);
    assert.equal((await pool.query(
      "SELECT count(*) FROM library.media_files WHERE recording_id = $1",
      [recordingA],
    )).rows[0].count, "0");
    await pool.query("DELETE FROM catalog.recordings WHERE id = $1", [recordingA]);
    assert.equal((await pool.query("SELECT count(*) FROM library.media_files")).rows[0].count, "4");
    assert.deepEqual((await pool.query(
      "SELECT id, recording_id FROM library.media_files WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[file1, file2, file3, unmatched]],
    )).rows, [
      { id: file1, recording_id: null },
      { id: file2, recording_id: recordingB },
      { id: file3, recording_id: recordingB },
      { id: unmatched, recording_id: null },
    ].sort((a, b) => a.id.localeCompare(b.id)));

    await assert.rejects(pool.query("DELETE FROM library.roots WHERE id = $1", [root.id]), { code: "23503" });
    assert.equal((await pool.query("SELECT count(*) FROM library.media_files WHERE root_id = $1", [root.id])).rows[0].count, "3");
    await pool.query("DELETE FROM library.media_files WHERE root_id = $1", [root.id]);
    await pool.query("DELETE FROM library.roots WHERE id = $1", [root.id]);
    await assert.rejects(pool.query("DELETE FROM library.roots WHERE id = $1", [samePathRoot]), { code: "23503" });
    await pool.query("DELETE FROM library.media_files WHERE root_id = $1", [samePathRoot]);
    await pool.query("DELETE FROM library.roots WHERE id = $1", [samePathRoot]);
    assert.equal((await pool.query("SELECT count(*) FROM library.media_files")).rows[0].count, "0");
    assert.equal((await pool.query("SELECT count(*) FROM library.roots")).rows[0].count, "0");
    assert.deepEqual(await readFile(originalFilePath), Buffer.from("original-media-bytes"));
    assert.equal(existsSync(originalRootPath), true);

    const persistedRoots = await pool.query("SELECT * FROM library.roots ORDER BY id");
    const persistedFiles = await pool.query("SELECT * FROM library.media_files ORDER BY id");
    await runMigrations(db, options);
    assert.deepEqual((await pool.query(
      "SELECT hash, created_at FROM library_fixture_history.migrations ORDER BY created_at",
    )).rows, history.rows);
    assert.deepEqual((await pool.query("SELECT * FROM library.roots ORDER BY id")).rows, persistedRoots.rows);
    assert.deepEqual((await pool.query("SELECT * FROM library.media_files ORDER BY id")).rows, persistedFiles.rows);
    assert.deepEqual((await pool.query(columnQuery, ["library.roots"])).rows, rootColumns.rows);
    assert.deepEqual((await pool.query(columnQuery, ["library.media_files"])).rows, mediaColumns.rows);
    assert.deepEqual((await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN ('library.roots'::regclass, 'library.media_files'::regclass)
      ORDER BY conname
    `)).rows, constraints.rows);
    assert.deepEqual((await pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'library' ORDER BY indexname
    `)).rows, indexes.rows);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await pool.end();
    if (started) {
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
    }
    if (!failed && !existsSync(path.join(data, "postmaster.pid"))) {
      await rm(cluster, { recursive: true, force: true });
    }
  }
});
