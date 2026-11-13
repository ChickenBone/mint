import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordings } from "@mint/domain-catalog";
import { runMigrations, type MigrationOptions } from "@mint/platform";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  createLibraryRepository,
  createLibraryScanRepository,
  LibraryRepositoryInputError,
  mediaFiles,
  roots,
  scanLibraryRoot,
  type LibraryScanOptions,
  type LibraryScanResult,
} from "../src/index";

const exec = promisify(execFile);
const files = [
  { tag: "0000_recordings", path: "packages/domain-catalog/migrations/0000_recordings.sql" },
  { tag: "0001_library_identity", path: "packages/domain-library/migrations/0000_library_identity.sql" },
  { tag: "0002_library_listing", path: "packages/domain-library/migrations/0001_library_listing.sql" },
];
const migrations: MigrationOptions = {
  migrationsRoot: fileURLToPath(new URL("../../..", import.meta.url)),
  history: { schema: "library_scanner_history", table: "migrations" },
  files,
  journal: {
    version: "7", dialect: "postgresql",
    entries: files.map((file, idx) => ({
      idx, version: "7", when: (idx + 1) * 100, tag: file.tag, breakpoints: true,
    })),
  },
};
const options: LibraryScanOptions = {
  maxEntries: 100, maxFiles: 50, maxDepth: 8, timeoutMs: 30_000,
  audio: {
    ffprobePath: "/usr/bin/ffprobe", ffmpegPath: "/usr/bin/ffmpeg",
    maxProbeInputBytes: 1024 * 1024, maxDecodeInputBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024, probeTimeoutMs: 5000, decodeTimeoutMs: 5000,
  },
};

test("PostgreSQL repeated/concurrent import preserves identity, recording links and tags through mount/tool failures", { timeout: 120_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to local PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const fixture = await mkdtemp("/tmp/mint-scan-db-");
  const data = path.join(fixture, "d");
  const socket = path.join(fixture, "s");
  const music = path.join(fixture, "music");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C",
    PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const pool = new pg.Pool({
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 3,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000,
  });
  let started = false;
  try {
    await mkdir(socket, { mode: 0o700 });
    await mkdir(music);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env, timeout: 30_000 });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(fixture, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-t", "15", "-w", "start",
    ], { env, timeout: 20_000 });
    started = true;
    assert.deepEqual((await pool.query("SELECT 1 AS ready, current_setting('listen_addresses') AS tcp")).rows,
      [{ ready: 1, tcp: "" }]);
    const db = drizzle(pool, { schema: { roots, mediaFiles, recordings } });
    await runMigrations(db, migrations);
    const repository = createLibraryRepository(db);
    const scanner = createLibraryScanRepository(db);
    const root = await repository.createRoot({ path: music });
    assert.deepEqual(await scanner.getScanRoot(root.id), { id: root.id, path: music });
    assert.equal(await scanner.getScanRoot(randomUUID()), null);
    await assert.rejects(scanner.getScanRoot("../root"), LibraryRepositoryInputError);
    for (const relativePath of ["../escape.wav", "/escape.wav", "a\\b.wav", "a//b.wav", "a/./b.wav", "\0.wav", "C:/file.wav"]) {
      await assert.rejects(scanner.ensureScanMediaFile(root.id, relativePath), LibraryRepositoryInputError);
    }
    const admissions = await Promise.all(Array.from({ length: 10 }, () => scanner.ensureScanMediaFile(root.id, "original.wav")));
    assert.equal(new Set(admissions.map((file) => file.id)).size, 1);
    assert.equal(admissions.filter((file) => file.created).length, 1);
    const file = admissions[0];
    assert.ok(file);
    const row = async () => {
      const [stored] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, file.id));
      assert.ok(stored);
      return stored;
    };
    assert.equal((await row()).recordingId, null);
    assert.equal((await row()).availability, "unverified");
    assert.equal((await db.select().from(recordings)).length, 0);
    await exec("/usr/bin/ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.1",
      "-c:a", "pcm_s16le", "-metadata", "title=Imported title", "-metadata", "artist=Imported artist",
      "-metadata", "album=Imported album", path.join(music, "original.wav"),
    ], { timeout: 10_000 });
    const original = await readFile(path.join(music, "original.wav"));
    const first = await scanLibraryRoot(scanner, root.id, options);
    assert.equal(first.verified, 1);
    assert.equal(first.existing, 1);
    assert.equal(first.status, "completed");
    const positive = await row();
    assert.equal(positive.recordingId, null);
    assert.equal(positive.importedTitle, "Imported title");
    assert.equal(positive.importedArtist, "Imported artist");
    assert.equal(positive.importedAlbum, "Imported album");
    assert.equal(positive.decodedSampleFrames, 4410);
    assert.equal((await repository.listFiles()).items[0]?.id, file.id);
    const [recording] = await db.insert(recordings).values({ title: "Confirmed recording" }).returning();
    assert.ok(recording);
    await db.update(mediaFiles).set({ recordingId: recording.id, importedVersion: "Retained version" })
      .where(eq(mediaFiles.id, file.id));
    const linked = await row();
    const admission = await scanner.ensureScanMediaFile(root.id, "original.wav");
    assert.deepEqual(admission, { id: file.id, created: false });
    assert.deepEqual(await row(), linked);
    const repeat = await scanLibraryRoot(scanner, root.id, options);
    assert.equal(repeat.existing, 1);
    assert.equal(repeat.imported, 0);
    assert.equal((await row()).recordingId, recording.id);
    assert.equal((await row()).importedVersion, "Retained version");
    const stable = await row();
    const inconclusive = await scanLibraryRoot(scanner, root.id, {
      ...options, audio: { ...options.audio, ffmpegPath: path.join(fixture, "missing-ffmpeg") },
    });
    assert.equal(inconclusive.status, "partial");
    assert.equal(inconclusive.inconclusive, 1);
    assert.equal(inconclusive.issueCount, 1);
    assert.deepEqual(await row(), stable);
    await rename(music, path.join(fixture, "detached"));
    assert.equal((await scanLibraryRoot(scanner, root.id, options)).status, "root-unavailable");
    await mkdir(music);
    assert.equal((await scanLibraryRoot(scanner, root.id, options)).status, "completed");
    assert.deepEqual(await row(), stable);
    assert.equal((await db.select().from(mediaFiles)).length, 1);
    assert.equal((await db.select().from(recordings)).length, 1);
    assert.deepEqual(await readFile(path.join(fixture, "detached", "original.wav")), original);

    const resumedMusic = path.join(fixture, "resumed");
    await mkdir(path.join(resumedMusic, "album", "disc"), { recursive: true });
    const expected = ["one.wav", "two.wav", "album/three.wav", "album/four.wav", "album/disc/five.wav", "album/disc/six.wav"];
    for (const relativePath of expected) await writeFile(path.join(resumedMusic, relativePath), original);
    const resumedRoot = await repository.createRoot({ path: resumedMusic });
    const childSource = `
      import pg from "pg";
      import { drizzle } from "drizzle-orm/node-postgres";
      import { createLibraryScanRepository, scanLibraryRoot } from ${JSON.stringify(fileURLToPath(new URL("../src/index.ts", import.meta.url)))};
      const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 });
      try {
        const result = await scanLibraryRoot(createLibraryScanRepository(drizzle(pool)), process.argv[1], JSON.parse(process.argv[2]));
        console.log(JSON.stringify(result));
      } finally { await pool.end(); }
    `;
    async function restartedScan(cursor?: string): Promise<LibraryScanResult> {
      const output = await exec(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e", childSource, resumedRoot.id,
        JSON.stringify({ ...options, maxEntries: 1, maxFiles: 1, cursor }),
      ], { env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
      return JSON.parse(output.stdout);
    }
    let cursor: string | undefined;
    let completed = false;
    let entriesVisited = 0;
    let imported = 0;
    let verified = 0;
    let retried = false;
    for (let invocation = 0; invocation < 20; invocation++) {
      const batch = await restartedScan(cursor);
      assert.ok(batch.entriesVisited <= 1);
      assert.ok(batch.filesVisited <= 1);
      assert.equal(batch.issueCount, 0);
      assert.equal(batch.existing, 0);
      entriesVisited += batch.entriesVisited;
      imported += batch.imported;
      verified += batch.verified;
      if (!retried && batch.imported === 1) {
        const replay = await restartedScan(cursor);
        assert.equal(replay.existing, 1);
        assert.equal(replay.imported, 0);
        assert.equal(replay.verified, 1);
        assert.equal(replay.nextCursor, batch.nextCursor);
        retried = true;
      }
      cursor = batch.nextCursor;
      if (!cursor) {
        assert.equal(batch.status, "completed");
        completed = true;
        break;
      }
      assert.equal(batch.status, "limited");
    }
    assert.ok(completed, "Fresh child processes must finish the larger tree using only serialized continuation");
    assert.ok(retried, "Retrying the last saved checkpoint must reuse the persisted identity");
    assert.equal(entriesVisited, 8);
    assert.equal(imported, expected.length);
    assert.equal(verified, expected.length);
    const stored = await db.select().from(mediaFiles).where(eq(mediaFiles.rootId, resumedRoot.id));
    assert.deepEqual(stored.map((entry) => entry.relativePath).sort(), expected.sort());
    assert.ok(stored.every((entry) => entry.availability === "verified" && entry.recordingId === null));
    const repeated = await scanLibraryRoot(createLibraryScanRepository(db), resumedRoot.id, options);
    assert.equal(repeated.existing, expected.length);
    assert.equal(repeated.imported, 0);
    assert.equal((await db.select().from(recordings)).length, 1);
    for (const relativePath of expected) {
      assert.deepEqual(await readFile(path.join(resumedMusic, relativePath)), original);
    }
  } finally {
    await pool.end();
    if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env, timeout: 20_000 });
    await rm(fixture, { recursive: true, force: true });
  }
});
