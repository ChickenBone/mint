import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordings } from "@mint/domain-catalog";
import { runMigrations, type MigrationOptions } from "@mint/platform";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  createLibraryRepository,
  LibraryMediaWriteError,
  LibraryRepositoryInputError,
  mediaFiles,
  roots,
  type LibraryFileListItem,
} from "../src/index";

const exec = promisify(execFile);
function constraintFailure(constraint: string, code = "23503") {
  return (error: unknown) => {
    assert.ok(error instanceof DrizzleQueryError);
    assert.ok(error.cause instanceof pg.DatabaseError);
    assert.equal(error.cause.constraint, constraint);
    assert.equal(error.cause.code, code);
    return true;
  };
}
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const files = [
  { tag: "0000_recordings", path: "packages/domain-catalog/migrations/0000_recordings.sql" },
  { tag: "0001_library_identity", path: "packages/domain-library/migrations/0000_library_identity.sql" },
  { tag: "0002_library_listing", path: "packages/domain-library/migrations/0001_library_listing.sql" },
];
const options: MigrationOptions = {
  migrationsRoot: repositoryRoot,
  history: { schema: "library_repository_history", table: "migrations" },
  files,
  journal: {
    version: "7", dialect: "postgresql",
    entries: files.map((file, idx) => ({
      idx, version: "7", when: (idx + 1) * 100, tag: file.tag, breakpoints: true,
    })),
  },
};

test("Library repository persists verified files and performs bounded cursor/search reads on PostgreSQL", { timeout: 120_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to local PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp("/tmp/mint-lib-");
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "s");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C",
    PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const pool = new pg.Pool({
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000,
  });
  let failed = false;
  try {
    await mkdir(socket, { mode: 0o700 });
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env, timeout: 30_000 });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-t", "15", "-w", "start",
    ], { env, timeout: 20_000 });
    assert.deepEqual((await pool.query("SELECT 1 AS ready, current_setting('listen_addresses') AS tcp")).rows, [{ ready: 1, tcp: "" }]);
    const queries: string[] = [];
    const db = drizzle(pool, {
      schema: { roots, mediaFiles, recordings },
      logger: { logQuery(query) { queries.push(query); } },
    });
    const repository = createLibraryRepository(db);
    await runMigrations(db, options);
    const expectedHistory = await Promise.all(files.map(async (file, idx) => ({
      hash: createHash("sha256").update(await readFile(path.join(repositoryRoot, file.path))).digest("hex"),
      created_at: String((idx + 1) * 100),
    })));
    assert.deepEqual((await pool.query(
      "SELECT hash, created_at FROM library_repository_history.migrations ORDER BY created_at",
    )).rows, expectedHistory);

    const root = await repository.createRoot({ path: "/fixture/read-only-originals" });
    const [recording] = await db.insert(recordings).values({
      title: "Confirmed Catalog title", version: "Catalog version", durationMs: 180_000,
    }).returning();
    assert.ok(recording);
    const tagged = await repository.createMediaFile({
      rootId: root.id, relativePath: "Private folder/Studio.flac", recordingId: recording.id,
      importedTags: { title: "Café First", artist: "Imported Artist", album: "Imported Album", version: "Studio" },
    });
    const live = await repository.createMediaFile({
      rootId: root.id, relativePath: "Private folder/Live.flac", recordingId: recording.id,
      importedTags: { title: "Café Live", version: "Live" },
    });
    const unknown = await repository.createMediaFile({ rootId: root.id, relativePath: "Private folder/Untagged.flac" });
    const unverified = await repository.createMediaFile({ rootId: root.id, relativePath: "Not-yet-probed.flac" });
    const unavailable = await repository.createMediaFile({
      rootId: root.id, relativePath: "Unavailable.flac", recordingId: recording.id,
      importedTags: { title: "Keep tags" },
    });
    assert.deepEqual(await repository.listFiles(), { items: [], nextCursor: null });
    const [initial] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, unknown.id));
    assert.ok(initial);
    assert.equal(initial.availability, "unverified");
    assert.equal(initial.recordingId, null);
    assert.equal(initial.verifiedAt, null);
    await assert.rejects(pool.query(
      "UPDATE library.media_files SET availability = 'verified' WHERE id = $1", [unverified.id],
    ), { code: "23514", constraint: "media_files_verification_evidence" });
    await assert.rejects(pool.query(
      "UPDATE library.media_files SET availability = 'unavailable' WHERE id = $1", [unverified.id],
    ), { code: "23514", constraint: "media_files_unavailable_reason" });

    const checkedAt = new Date("2030-01-02T03:04:05.000Z");
    const verified = {
      availability: "verified" as const, checkedAt,
      audio: { streamIndex: 0, codec: "flac", decodedSampleFrames: 441_000, durationMs: 181_000 },
    };
    for (const file of [tagged, live, unknown, unavailable]) {
      await repository.recordVerification(file.id, verified);
    }
    await repository.recordVerification(unavailable.id, {
      availability: "unavailable", checkedAt: new Date(checkedAt.getTime() + 1), reason: "unreadable",
    });
    const [retained] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, unavailable.id));
    assert.ok(retained);
    assert.equal(retained.recordingId, recording.id);
    assert.equal(retained.relativePath, "Unavailable.flac");
    assert.equal(retained.importedTitle, "Keep tags");
    assert.equal(retained.audioCodec, "flac");
    assert.equal(retained.verifiedAt?.getTime(), checkedAt.getTime());
    const otherRoot = await repository.createRoot({ path: "/fixture/other-read-only-originals" });
    const otherFile = await repository.createMediaFile({ rootId: otherRoot.id, relativePath: "other.flac" });
    const candidates = [tagged.id, live.id, unknown.id, unverified.id, unavailable.id].sort();
    const firstCandidates = await repository.getRecheckCandidates({ rootId: root.id, limit: 2 });
    assert.match(queries.at(-1)!, /where .*root_id.*order by .*id.*limit/i);
    assert.deepEqual(firstCandidates, {
      root: { id: root.id, path: "/fixture/read-only-originals" },
      ids: candidates.slice(0, 2), nextAfter: candidates[1],
    });
    const secondCandidates = await repository.getRecheckCandidates({ rootId: root.id, limit: 2, after: firstCandidates.nextAfter! });
    assert.deepEqual(secondCandidates.ids, candidates.slice(2, 4));
    assert.equal(secondCandidates.nextAfter, candidates[3]);
    const lastCandidates = await repository.getRecheckCandidates({ rootId: root.id, limit: 2, after: secondCandidates.nextAfter! });
    assert.deepEqual(lastCandidates.ids, candidates.slice(4));
    assert.equal(lastCandidates.nextAfter, null);
    assert.deepEqual(await repository.getRecheckCandidates({ rootId: root.id, limit: 5 }), {
      root: firstCandidates.root, ids: candidates, nextAfter: null,
    });
    assert.deepEqual(await repository.getRecheckCandidates({ rootId: root.id, limit: 1, after: candidates[4] }), {
      root: firstCandidates.root, ids: [], nextAfter: null,
    });
    assert.deepEqual((await repository.getRecheckCandidates({ rootId: otherRoot.id, limit: 100 })).ids, [otherFile.id]);
    const emptyCandidateRoot = await repository.createRoot({ path: "/fixture/empty-read-only-originals" });
    assert.deepEqual(await repository.getRecheckCandidates({ rootId: emptyCandidateRoot.id, limit: 1 }), {
      root: { id: emptyCandidateRoot.id, path: "/fixture/empty-read-only-originals" }, ids: [], nextAfter: null,
    });
    for (const input of [
      { rootId: "invalid", limit: 1 },
      { rootId: root.id, limit: 0 },
      { rootId: root.id, limit: 101 },
      { rootId: root.id, limit: 1.5 },
      { rootId: root.id, limit: 1, after: "../file" },
    ]) {
      const beforeQueries = queries.length;
      await assert.rejects(repository.getRecheckCandidates(input), LibraryRepositoryInputError);
      assert.equal(queries.length, beforeQueries);
    }
    await assert.rejects(repository.getRecheckCandidates({ rootId: randomUUID(), limit: 1 }), LibraryRepositoryInputError);
    await assert.rejects(repository.recordVerification(unavailable.id, verified), LibraryMediaWriteError);
    await assert.rejects(repository.recordVerification(randomUUID(), verified), LibraryMediaWriteError);
    await assert.rejects(repository.recordVerification(unknown.id, {
      ...verified, audio: { ...verified.audio, decodedSampleFrames: 0 },
    }), LibraryRepositoryInputError);

    const visible = await repository.listFiles();
    assert.equal(visible.nextCursor, null);
    assert.equal(visible.items.length, 3);
    assert.deepEqual(visible.items.map((item) => item.id), [tagged.id, live.id, unknown.id].sort());
    assert.deepEqual(visible.items.find((item) => item.id === tagged.id), {
      id: tagged.id, recordingId: recording.id, title: "Café First", artist: "Imported Artist",
      album: "Imported Album", version: "Studio", durationMs: 181_000,
    });
    assert.deepEqual(visible.items.find((item) => item.id === unknown.id), {
      id: unknown.id, recordingId: null, title: "Untagged.flac", artist: "Unknown artist",
      album: "Unknown album", version: null, durationMs: 181_000,
    });
    assert.deepEqual(visible.items.map((item) => Object.keys(item).sort()), Array.from({ length: 3 }, () =>
      ["album", "artist", "durationMs", "id", "recordingId", "title", "version"]));
    assert.doesNotMatch(JSON.stringify(visible), /Private folder|fixture\/read-only|audioCodec|checkedAt|relativePath|rootId/);
    await repository.replaceImportedTags(live.id, {});
    await repository.recordVerification(live.id, { ...verified, audio: { ...verified.audio, durationMs: null } });
    const fallback = (await repository.listFiles()).items.find((item) => item.id === live.id);
    assert.equal(fallback?.title, "Confirmed Catalog title");
    assert.equal(fallback.version, "Catalog version");
    assert.equal(fallback.durationMs, 180_000);
    await repository.replaceImportedTags(live.id, { title: "Café Live", version: "Live" });

    // More than the hard maximum proves both default and explicit bounds without library hydration.
    for (let index = 0; index < 102; index++) {
      const file = await repository.createMediaFile({
        rootId: root.id, relativePath: `Batch/${index}.flac`,
        importedTags: { title: `Batch ${index}`, artist: "CAFÉ Ensemble" },
      });
      await repository.recordVerification(file.id, verified);
    }
    const collect = async (search?: string) => {
      const items: LibraryFileListItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await repository.listFiles({ limit: 7, search, cursor });
        assert.ok(page.items.length <= 7);
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    };
    queries.length = 0;
    const all = await collect();
    assert.equal(all.length, 105);
    assert.equal(new Set(all.map((item) => item.id)).size, 105);
    assert.deepEqual(all.map((item) => item.id), all.map((item) => item.id).sort());
    assert.ok(queries.every((query) => /limit \$\d+/.test(query) && !/offset |select \*/i.test(query)));
    assert.ok(queries.slice(1).every((query) => /"media_files"\."id" >/.test(query)));
    assert.equal((await repository.listFiles()).items.length, 50);
    assert.equal((await repository.listFiles({ limit: 100 })).items.length, 100);
    const searchResults = await collect("ensem CAFÉ");
    assert.equal(searchResults.length, 102);
    assert.equal(new Set(searchResults.map((item) => item.id)).size, 102);
    assert.equal((await repository.listFiles({ search: "first cafe" })).items[0]?.id, tagged.id);
    assert.equal((await repository.listFiles({ search: "Untagged" })).items[0]?.id, unknown.id);
    assert.equal((await repository.listFiles({ search: "Confirmed Catalog" })).items.length, 2);
    for (const search of ["%", "_", "Private folder", "' OR true --", "not present"]) {
      assert.deepEqual(await repository.listFiles({ search }), { items: [], nextCursor: null });
    }
    const first = await repository.listFiles({ limit: 1, search: "cafe" });
    assert.ok(first.nextCursor);
    assert.ok((await repository.listFiles({ limit: 2, search: " CAFÉ ", cursor: first.nextCursor })).items.length <= 2);
    await assert.rejects(repository.listFiles({ search: "different", cursor: first.nextCursor }), LibraryRepositoryInputError);
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
      await assert.rejects(repository.listFiles({ limit }), LibraryRepositoryInputError);
    }
    // @ts-expect-error Runtime callers must not silently default a malformed null page size.
    await assert.rejects(repository.listFiles({ limit: null }), LibraryRepositoryInputError);
    for (const cursor of ["", "%%%", Buffer.from("{}").toString("base64url"), "a".repeat(2049)]) {
      await assert.rejects(repository.listFiles({ cursor }), LibraryRepositoryInputError);
    }
    await assert.rejects(repository.listFiles({ search: "x".repeat(201) }), LibraryRepositoryInputError);
    await assert.rejects(repository.createMediaFile({ rootId: root.id, relativePath: "../escape.flac" }), LibraryRepositoryInputError);
    await assert.rejects(repository.replaceImportedTags(randomUUID(), {}), LibraryMediaWriteError);
    await assert.rejects(repository.createMediaFile({
      rootId: root.id, relativePath: "Bad link.flac", recordingId: randomUUID(),
    }), constraintFailure("media_files_recording_fk"));
    await assert.rejects(repository.createMediaFile({ rootId: randomUUID(), relativePath: "Bad root.flac" }), constraintFailure("media_files_root_fk"));
    await assert.rejects(repository.createMediaFile({ rootId: root.id, relativePath: "Private folder/Untagged.flac" }), constraintFailure("media_files_root_id_relative_path_idx", "23505"));
    await assert.rejects(db.delete(roots).where(eq(roots.id, root.id)), constraintFailure("media_files_root_fk"));
    await assert.rejects(db.delete(recordings).where(eq(recordings.id, recording.id)), constraintFailure("media_files_recording_fk"));
    const [preserved] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, unavailable.id));
    assert.deepEqual(preserved, retained);
    await db.update(mediaFiles).set({ recordingId: null }).where(eq(mediaFiles.recordingId, recording.id));
    await db.delete(recordings).where(eq(recordings.id, recording.id));
    assert.equal((await repository.listFiles({ search: "cafe first" })).items[0]?.recordingId, null);
    const beforeReplay = await repository.listFiles();
    await runMigrations(db, options);
    assert.deepEqual(await repository.listFiles(), beforeReplay);
    assert.deepEqual((await pool.query(
      "SELECT hash, created_at FROM library_repository_history.migrations ORDER BY created_at",
    )).rows, expectedHistory);
    const emptyRoot = await repository.createRoot({ path: "/fixture/empty" });
    await db.delete(roots).where(eq(roots.id, emptyRoot.id));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await pool.end();
    // Even a startup failure can leave a running postmaster; never remove an active cluster.
    if (existsSync(path.join(data, "postmaster.pid"))) {
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-t", "15", "-w", "stop"], { env, timeout: 20_000 });
    }
    if (!failed && !existsSync(path.join(data, "postmaster.pid"))) {
      await rm(cluster, { recursive: true, force: true });
    }
  }
});
