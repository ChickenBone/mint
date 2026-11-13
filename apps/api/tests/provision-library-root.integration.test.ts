import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordings } from "@mint/domain-catalog";
import { createLibraryRepository, mediaFiles, roots } from "@mint/domain-library";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { provisionLibraryRoot, readLibraryRootConfiguration } from "../src/provision-library-root";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../src/provision-library-root.ts", import.meta.url));
const packages = fileURLToPath(new URL("../../../packages/", import.meta.url));
const configuration = {
  MINT_LIBRARY_ROOT_PATH: "/fixture/media",
  MINT_API_DB_HOST: "/fixture/socket",
  MINT_API_DB_PORT: "5432",
  MINT_API_DB_NAME: "postgres",
  MINT_API_DB_USER: "fixture",
  MINT_API_DB_PASSWORD: "",
  MINT_API_DB_TLS: "disabled",
  MINT_API_DB_CONNECT_TIMEOUT_MS: "2000",
};

test("operator configuration is explicit, bounded and independent of server startup", () => {
  const parsed = readLibraryRootConfiguration(configuration);
  assert.equal(parsed.rootPath, "/fixture/media");
  assert.equal(parsed.database.ssl, false);
  assert.equal(parsed.database.password, "");
  assert.equal(parsed.database.statement_timeout, 10_000);
  assert.equal(parsed.database.lock_timeout, 5_000);
  assert.deepEqual(readLibraryRootConfiguration({
    ...configuration, MINT_API_DB_TLS: "verify",
  }).database.ssl, { rejectUnauthorized: true });
  for (const field of Object.keys(configuration)) {
    const env: NodeJS.ProcessEnv = { ...configuration };
    delete env[field];
    assert.throws(() => readLibraryRootConfiguration(env), /Invalid configuration/);
  }
  for (const [field, values] of [
    ["MINT_API_DB_PORT", ["0", "65536", "1.5", " 5432", "05432"]],
    ["MINT_API_DB_CONNECT_TIMEOUT_MS", ["0", "-1", "2147483648", "NaN"]],
    ["MINT_API_DB_TLS", ["", "false", "insecure"]],
    ["MINT_API_DB_PASSWORD", ["secret\0value", "x".repeat(4097)]],
  ] as const) {
    for (const value of values) {
      assert.throws(() => readLibraryRootConfiguration({ ...configuration, [field]: value }), /Invalid configuration/);
    }
  }
  for (const value of ["/", "", "relative", "/fixture/../media", "/fixture/./media", "//media",
    "/fixture//media", "/fixture/media/", "/fixture\\media", "/fixture/\0media", "/fixture/\nmedia"]) {
    assert.throws(() => readLibraryRootConfiguration({ ...configuration, MINT_LIBRARY_ROOT_PATH: value }));
  }
});

test("filesystem validation rejects aliases, files and inaccessible directories before registration", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "mint-root-fs-"));
  const client = new pg.Client();
  try {
    const directory = path.join(temp, "media");
    const file = path.join(temp, "file");
    await mkdir(directory);
    await writeFile(file, "fixture");
    await symlink(directory, path.join(temp, "alias"));
    await symlink(temp, path.join(temp, "parent-alias"));
    for (const candidate of [path.join(temp, "alias"), path.join(temp, "parent-alias", "media")]) {
      await assert.rejects(provisionLibraryRoot(client, candidate), { message: "UNSAFE_ROOT" });
    }
    await assert.rejects(provisionLibraryRoot(client, file), { code: "ENOTDIR" });
    await assert.rejects(provisionLibraryRoot(client, path.join(temp, "missing")), { code: "ENOENT" });
    await chmod(directory, 0);
    if (process.getuid?.() !== 0) {
      await assert.rejects(provisionLibraryRoot(client, directory), { code: "EACCES" });
      await chmod(directory, 0o400);
      await assert.rejects(provisionLibraryRoot(client, directory), { code: "EACCES" });
    }
  } finally {
    await chmod(path.join(temp, "media"), 0o700);
    await rm(temp, { recursive: true, force: true });
  }
});

test("disposable PostgreSQL: CLI registration is confined, idempotent and credential-safe", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries; no external database is used");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await realpath(await mkdtemp(path.join(tmpdir(), "mint-root-pg-")));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "s");
  const rootPath = path.join(cluster, "media");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C",
    PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const database = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "", ssl: false as const,
    connectionTimeoutMillis: 2000, statement_timeout: 10_000, lock_timeout: 5_000,
  };
  const observer = new pg.Client(database);
  const cliEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, ...configuration,
    MINT_API_DB_HOST: socket, MINT_LIBRARY_ROOT_PATH: rootPath,
  };
  let started = false;
  async function invoke(overrides: NodeJS.ProcessEnv = {}, args: string[] = []) {
    return exec(cli, args, {
      cwd: workspace, env: { ...cliEnv, ...overrides }, timeout: 15_000,
    });
  }
  async function failure(
    overrides: NodeJS.ProcessEnv,
    expected: { phase: string; code: string; field?: string },
    args: string[] = [],
  ) {
    await assert.rejects(invoke(overrides, args), (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "stderr" in error && "code" in error);
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(typeof error.stderr, "string");
      assert.deepEqual(JSON.parse(String(error.stderr)), { event: "library-root-provision-failed", ...expected });
      return true;
    });
  }
  try {
    await mkdir(socket, { mode: 0o700 });
    await mkdir(rootPath);
    await writeFile(path.join(rootPath, "original.flac"), "not decoded: provisioning must not scan", { mode: 0o444 });
    const before = await lstat(path.join(rootPath, "original.flac"), { bigint: true });
    const digest = () => readFile(path.join(rootPath, "original.flac")).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
    const originalHash = await digest();
    await chmod(rootPath, 0o555);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env, timeout: 30_000 });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-t", "15", "-w", "start",
    ], { env, timeout: 20_000 });
    started = true;
    await observer.connect();
    assert.equal((await observer.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    await assert.rejects(provisionLibraryRoot(observer, rootPath), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof pg.DatabaseError);
      assert.equal(error.cause.code, "3F000");
      return true;
    });
    await failure({}, { phase: "provision", code: "3F000" });
    for (const migration of [
      "domain-catalog/migrations/0000_recordings.sql",
      "domain-library/migrations/0000_library_identity.sql",
      "domain-library/migrations/0001_library_listing.sql",
    ]) await observer.query(await readFile(path.join(packages, migration), "utf8"));

    await failure({ MINT_API_DB_PASSWORD: undefined }, {
      phase: "configuration", code: "INVALID_CONFIGURATION", field: "MINT_API_DB_PASSWORD",
    });
    await failure({}, { phase: "configuration", code: "INVALID_CONFIGURATION", field: "arguments" }, ["--reset"]);
    await failure({ MINT_LIBRARY_ROOT_PATH: path.join(cluster, "missing") }, { phase: "provision", code: "ENOENT" });
    await symlink(rootPath, path.join(cluster, "alias"));
    await failure({ MINT_LIBRARY_ROOT_PATH: path.join(cluster, "alias") }, { phase: "provision", code: "UNSAFE_ROOT" });
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM library.roots")).rows[0].n, 0);

    try {
      await observer.query("BEGIN");
      await observer.query("LOCK TABLE library.roots IN SHARE ROW EXCLUSIVE MODE");
      await failure({}, { phase: "provision", code: "55P03" });
    } finally {
      await observer.query("ROLLBACK");
    }
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM library.roots")).rows[0].n, 0);

    const changingRoot = path.join(cluster, "changing-root");
    await mkdir(changingRoot);
    const waiting = new pg.Client({ ...database, application_name: "mint-root-race-fixture" });
    await waiting.connect();
    let registration: Promise<unknown> | undefined;
    try {
      await observer.query("BEGIN");
      await observer.query("LOCK TABLE library.roots IN SHARE ROW EXCLUSIVE MODE");
      registration = assert.rejects(provisionLibraryRoot(waiting, changingRoot), { message: "ROOT_CHANGED" });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = (await observer.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'mint-root-race-fixture' AND wait_event_type = 'Lock') AS blocked",
        )).rows[0].blocked;
        if (blocked) break;
        await delay(20);
      }
      assert.equal(blocked, true);
      await rename(changingRoot, `${changingRoot}-old`);
      await mkdir(changingRoot);
    } finally {
      await observer.query("ROLLBACK");
      try { await registration; } finally { await waiting.end(); }
    }
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM library.roots")).rows[0].n, 0);

    // Independent processes exercise real lock contention and fresh client/descriptor lifecycles.
    const results = await Promise.all(Array.from({ length: 5 }, () => invoke()));
    const identities = results.map(({ stdout, stderr }) => {
      assert.equal(stderr, "");
      const value: unknown = JSON.parse(stdout);
      assert.ok(value && typeof value === "object" && "rootId" in value && "created" in value);
      assert.deepEqual(Object.keys(value).sort(), ["created", "event", "rootId"]);
      assert.ok("event" in value && value.event === "library-root-provisioned");
      assert.equal(typeof value.created, "boolean");
      assert.equal(typeof value.rootId, "string");
      assert.match(String(value.rootId), /^[0-9a-f-]{36}$/);
      return { rootId: value.rootId, created: value.created };
    });
    assert.equal(identities.filter((result) => result.created).length, 1);
    const rootId = identities[0]!.rootId;
    assert.ok(identities.every((result) => result.rootId === rootId));
    const stored = (await observer.query("SELECT id, path, created_at FROM library.roots")).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].path, rootPath);
    assert.equal(stored[0].id, rootId);
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM library.media_files")).rows[0].n, 0);
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM catalog.recordings")).rows[0].n, 0);
    assert.equal((await observer.query("SELECT to_regclass('library.scan_jobs') AS table_name")).rows[0].table_name, null);

    const db = drizzle(observer, { schema: { roots, mediaFiles, recordings } });
    const repository = createLibraryRepository(db);
    const media = await repository.createMediaFile({ rootId: String(rootId), relativePath: "existing.flac", importedTags: { title: "Keep me" } });
    const preserved = (await observer.query("SELECT * FROM library.media_files WHERE id = $1", [media.id])).rows;
    assert.deepEqual(JSON.parse((await invoke()).stdout), {
      event: "library-root-provisioned", rootId, created: false,
    });
    assert.deepEqual((await observer.query("SELECT id, path, created_at FROM library.roots")).rows, stored);
    assert.deepEqual((await observer.query("SELECT * FROM library.media_files WHERE id = $1", [media.id])).rows, preserved);
    assert.equal(await digest(), originalHash);
    const after = await lstat(path.join(rootPath, "original.flac"), { bigint: true });
    for (const key of ["ino", "size", "mode", "mtimeNs", "ctimeNs"] as const) assert.equal(after[key], before[key]);
    assert.equal(Number((await lstat(rootPath)).mode) & 0o777, 0o555);

    await observer.query("CREATE ROLE limited_operator LOGIN");
    await observer.query("GRANT USAGE ON SCHEMA library TO limited_operator");
    await observer.query("GRANT SELECT ON library.roots TO limited_operator");
    await failure({ MINT_API_DB_USER: "limited_operator", MINT_API_DB_PASSWORD: "DO_NOT_LEAK_fixture_secret" }, {
      phase: "provision", code: "42501",
    });
    await failure({ MINT_API_DB_NAME: "DO_NOT_LEAK_database", MINT_API_DB_PASSWORD: "DO_NOT_LEAK_password" }, {
      phase: "database-connect", code: "3D000",
    });
    await assert.rejects(observer.query("SELECT * FROM not_a_fixture_table"), { code: "42P01" });
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM library.roots")).rows[0].n, 1);

    await repository.createRoot({ path: rootPath });
    await failure({}, { phase: "provision", code: "AMBIGUOUS_ROOT" });
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM library.roots")).rows[0].n, 2);
    assert.deepEqual((await observer.query("SELECT * FROM library.media_files WHERE id = $1", [media.id])).rows, preserved);
    assert.equal((await observer.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'mint-library-root-provision'",
    )).rows[0].n, 0);
  } finally {
    await observer.end();
    if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-t", "15", "-w", "stop"], { env, timeout: 20_000 });
    await chmod(rootPath, 0o700);
    await rm(cluster, { recursive: true, force: true });
  }
});
