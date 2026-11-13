import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { runMigrations, type MigrationJournal, type MigrationOptions } from "../src/migrations";

const exec = promisify(execFile);
const originalTmpdir = process.env.TMPDIR;
const testTmpdir = await mkdtemp(path.join(tmpdir(), "mint-migration-tests-"));
// Node's test runner isolates files in child processes; keep leak checks file-local.
process.env.TMPDIR = testTmpdir;
after(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  // Preserve leaked assemblies or failed PostgreSQL clusters for diagnosis.
  await rmdir(testTmpdir);
});

const firstSql = "-- caf\u00e9\r\nCREATE TABLE fixture_recording (id integer PRIMARY KEY);\r\n--> statement-breakpoint\nINSERT INTO fixture_recording VALUES (1);\n";
const secondSql = "CREATE TABLE fixture_file (recording_id integer REFERENCES fixture_recording(id));\n--> statement-breakpoint\nINSERT INTO fixture_file VALUES (1);\n";
const journal: MigrationJournal = {
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, version: "7", when: 100, tag: "0000_catalog", breakpoints: true },
    { idx: 1, version: "7", when: 200, tag: "0001_library", breakpoints: false },
  ],
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mint-migration-test-"));
  await mkdir(path.join(root, "catalog"));
  await mkdir(path.join(root, "library"));
  await writeFile(path.join(root, "catalog", "recordings.sql"), firstSql);
  await writeFile(path.join(root, "library", "files.sql"), secondSql);
  const options: MigrationOptions = {
    journal,
    migrationsRoot: root,
    // Composition order intentionally differs from central journal order.
    files: [
      { tag: "0001_library", path: "library/files.sql" },
      { tag: "0000_catalog", path: "catalog/recordings.sql" },
    ],
    history: { schema: "fixture_history", table: "migrations" },
  };
  return { root, options };
}

async function assemblies(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("mint-migrations-")).sort();
}

test("assembles domain bytes in journal order, preserving Drizzle hash, timestamp and breakpoints", async () => {
  const { root, options } = await fixture();
  let assembly = "";
  try {
    await runMigrations(drizzle.mock(), options, async (_db, config) => {
      assembly = config.migrationsFolder;
      assert.equal(config.migrationsSchema, "fixture_history");
      assert.equal(config.migrationsTable, "migrations");
      assert.deepEqual(JSON.parse(await readFile(path.join(assembly, "meta", "_journal.json"), "utf8")), journal);
      assert.equal((await lstat(assembly)).mode & 0o777, 0o700);
      const migrations = readMigrationFiles(config);
      assert.deepEqual(migrations, [firstSql, secondSql].map((sql, index) => ({
        sql: sql.split("--> statement-breakpoint"),
        hash: createHash("sha256").update(sql).digest("hex"),
        folderMillis: journal.entries[index]!.when,
        bps: journal.entries[index]!.breakpoints,
      })));
      assert.deepEqual(await readFile(path.join(assembly, "0000_catalog.sql")), Buffer.from(firstSql));
      assert.deepEqual(await readFile(path.join(assembly, "0001_library.sql")), Buffer.from(secondSql));
    });
    assert.notEqual(assembly, "");
    assert.equal(existsSync(assembly), false);
    assert.equal(await readFile(path.join(root, "catalog", "recordings.sql"), "utf8"), firstSql);
    assert.equal(await readFile(path.join(root, "library", "files.sql"), "utf8"), secondSql);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("propagates migrator errors unchanged and cleans its assembly", async () => {
  const { root, options } = await fixture();
  const failure = new Error("fixture migration failure");
  let assembly = "";
  try {
    await assert.rejects(runMigrations(drizzle.mock(), options, async (_db, config) => {
      assembly = config.migrationsFolder;
      throw failure;
    }), (error) => error === failure);
    assert.notEqual(assembly, "");
    assert.equal(existsSync(assembly), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed, missing, duplicate, out-of-order and escaping inputs before DB access", async (t) => {
  const { root, options } = await fixture();
  const entry = journal.entries[0]!;
  const withEntries = (entries: unknown[]) => ({ ...journal, entries });
  const cases: { name: string; change: Partial<MigrationOptions> }[] = [
    { name: "malformed journal", change: { journal: null } },
    { name: "wrong dialect", change: { journal: { ...journal, dialect: "sqlite" } } },
    { name: "wrong journal version", change: { journal: { ...journal, version: "6" } } },
    { name: "missing entries", change: { journal: { version: "7", dialect: "postgresql" } } },
    { name: "too many entries", change: { journal: withEntries(Array.from({ length: 10_001 }, () => entry)) } },
    { name: "wrong entry version", change: { journal: withEntries([{ ...entry, version: "6" }]) } },
    { name: "duplicate tags", change: { journal: withEntries([entry, { ...entry, idx: 1, when: 200 }]) } },
    { name: "out-of-order indices", change: { journal: withEntries([{ ...entry, idx: 1 }]) } },
    { name: "out-of-order time", change: { journal: withEntries([entry, { ...journal.entries[1], when: 99 }]) } },
    { name: "duplicate time", change: { journal: withEntries([entry, { ...journal.entries[1], when: 100 }]) } },
    { name: "unsafe timestamp", change: { journal: withEntries([{ ...entry, when: Number.MAX_SAFE_INTEGER + 1 }]) } },
    { name: "negative timestamp", change: { journal: withEntries([{ ...entry, when: -1 }]) } },
    { name: "missing breakpoints", change: { journal: withEntries([{ ...entry, breakpoints: undefined }]) } },
    { name: "escaping tag", change: { journal: withEntries([{ ...entry, tag: "../escape" }]) } },
    { name: "missing mapping", change: { files: options.files.slice(1) } },
    { name: "duplicate mapping", change: { files: [options.files[0]!, options.files[0]!] } },
    { name: "unknown mapping", change: { files: [{ tag: "unknown", path: "catalog/recordings.sql" }, options.files[1]!] } },
    { name: "duplicate source", change: { files: options.files.map((file) => ({ ...file, path: "catalog/recordings.sql" })) } },
    { name: "missing SQL", change: { files: [{ tag: "0001_library", path: "library/missing.sql" }, options.files[1]!] } },
    { name: "directory SQL", change: { files: [{ tag: "0001_library", path: "directory.sql" }, options.files[1]!] } },
    ...["../escape.sql", "catalog/../escape.sql", "/tmp/escape.sql", "catalog\\escape.sql", "catalog//recordings.sql"].map((source) => ({
      name: `invalid path ${source}`,
      change: { files: [{ tag: "0001_library", path: source }, options.files[1]!] },
    })),
    { name: "empty history schema", change: { history: { schema: "", table: "migrations" } } },
    { name: "truncated history identifier", change: { history: { schema: "a".repeat(64), table: "migrations" } } },
  ];
  try {
    await mkdir(path.join(root, "directory.sql"));
    for (const { name, change } of cases) {
      await t.test(name, async () => {
        const before = await assemblies();
        let called = false;
        await assert.rejects(runMigrations(drizzle.mock(), { ...options, ...change }, async () => {
          called = true;
        }));
        assert.equal(called, false, "Invalid files must not reach the migrator");
        assert.deepEqual(await assemblies(), before);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symbolic links, invalid UTF-8, NUL, empty and oversized files, cleaning partial assemblies", async (t) => {
  const { root, options } = await fixture();
  try {
    const source = path.join(root, "library", "files.sql");
    const cases = [
      { name: "empty", bytes: Buffer.alloc(0) },
      { name: "whitespace", bytes: Buffer.from(" \n") },
      { name: "invalid UTF-8", bytes: Buffer.from([0xff]) },
      { name: "NUL", bytes: Buffer.from("SELECT 1;\0") },
      { name: "oversized", bytes: Buffer.alloc(16 * 1024 * 1024 + 1, 32) },
    ];
    for (const { name, bytes } of cases) {
      await t.test(name, async () => {
        await writeFile(source, bytes);
        const before = await assemblies();
        let called = false;
        await assert.rejects(runMigrations(drizzle.mock(), options, async () => { called = true; }));
        assert.equal(called, false, "Invalid SQL must not reach the migrator");
        assert.deepEqual(await assemblies(), before);
      });
    }
    await rm(source);
    await symlink(path.join(root, "catalog", "recordings.sql"), source);
    await assert.rejects(runMigrations(drizzle.mock(), options), /symbolic links/);
    await rm(source);
    await rm(path.join(root, "library"), { recursive: true });
    await symlink(path.join(root, "catalog"), path.join(root, "library"));
    await assert.rejects(runMigrations(drizzle.mock(), options), /symbolic links/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official migrator applies twice and rolls back failed pending migrations on disposable PostgreSQL", async (t) => {
  // Opt-in names a local binary directory, never a deployment connection string.
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing local initdb/pg_ctl binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin), "PostgreSQL binary directory must be absolute");
  const { root, options } = await fixture();
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-migration-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture" };
  // initdb/pg_ctl and pg receive explicit local settings; never inherit a service or deployment URL.
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  let started = false;
  const pool = new pg.Pool({ host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 1 });
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start",
    ], { env });
    started = true;
    assert.equal((await pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
    const db = drizzle(pool);
    await runMigrations(db, options);
    const applied = await pool.query("SELECT hash, created_at FROM fixture_history.migrations ORDER BY created_at");
    assert.deepEqual(applied.rows, [firstSql, secondSql].map((sql, index) => ({
      hash: createHash("sha256").update(sql).digest("hex"),
      created_at: String(journal.entries[index]!.when),
    })));
    await runMigrations(db, options);
    assert.equal((await pool.query("SELECT count(*) FROM fixture_history.migrations")).rows[0].count, "2");
    assert.equal((await pool.query("SELECT count(*) FROM fixture_file")).rows[0].count, "1");

    await writeFile(path.join(root, "catalog", "pending.sql"), "CREATE TABLE fixture_pending (id integer);\n");
    await writeFile(path.join(root, "library", "broken.sql"), "CREATE TABLE fixture_rollback (id integer);\n--> statement-breakpoint\nINVALID FIXTURE SQL;\n");
    const failing: MigrationOptions = {
      ...options,
      journal: {
        ...journal,
        entries: [
          ...journal.entries,
          { idx: 2, version: "7", when: 300, tag: "0002_pending", breakpoints: true },
          { idx: 3, version: "7", when: 400, tag: "0003_broken", breakpoints: true },
        ],
      },
      files: [
        ...options.files,
        { tag: "0002_pending", path: "catalog/pending.sql" },
        { tag: "0003_broken", path: "library/broken.sql" },
      ],
    };
    let failedAssembly = "";
    await assert.rejects(runMigrations(db, failing, async (database, config) => {
      failedAssembly = config.migrationsFolder;
      await migrate(database, config);
    }), /INVALID FIXTURE SQL/);
    assert.equal(existsSync(failedAssembly), false);
    assert.deepEqual((await pool.query("SELECT to_regclass('fixture_pending') AS pending, to_regclass('fixture_rollback') AS rollback")).rows, [{ pending: null, rollback: null }]);
    assert.equal((await pool.query("SELECT count(*) FROM fixture_history.migrations")).rows[0].count, "2");
  } finally {
    await pool.end();
    try {
      if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
    } finally {
      // Do not remove cluster files if shutdown failed.
      if (!existsSync(path.join(data, "postmaster.pid"))) await rm(cluster, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
});
