import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
  LIBRARY_MEDIA_READ_MAX_BYTES,
  LibraryFileAccessError,
  LibraryMediaRangeError,
  LibraryPlaybackMediaError,
  LibraryRepositoryInputError,
  mediaFiles,
  openLibraryPlaybackMedia,
  parseLibraryMediaByteRange,
  roots,
  verifyLibraryMediaFile,
} from "../src/index";

const exec = promisify(execFile);
const files = [
  { tag: "0000_recordings", path: "packages/domain-catalog/migrations/0000_recordings.sql" },
  { tag: "0001_library_identity", path: "packages/domain-library/migrations/0000_library_identity.sql" },
  { tag: "0002_library_listing", path: "packages/domain-library/migrations/0001_library_listing.sql" },
];
const migrations: MigrationOptions = {
  migrationsRoot: fileURLToPath(new URL("../../..", import.meta.url)),
  history: { schema: "library_playback_history", table: "migrations" },
  files,
  journal: {
    version: "7", dialect: "postgresql",
    entries: files.map((file, idx) => ({
      idx, version: "7", when: (idx + 1) * 100, tag: file.tag, breakpoints: true,
    })),
  },
};
const playbackError = (code: LibraryPlaybackMediaError["code"]) => (error: unknown) =>
  error instanceof LibraryPlaybackMediaError && error.code === code;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result: Uint8Array[] = [];
  for await (const chunk of chunks) {
    assert.ok(chunk.length > 0 && chunk.length <= LIBRARY_MEDIA_READ_MAX_BYTES);
    result.push(chunk);
  }
  return Buffer.concat(result);
}

test("real verified media -> caller-owned confined original-byte playback and strict ranges", { timeout: 120_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  assert.equal(process.platform, "linux");
  assert.notEqual(process.getuid?.(), 0, "Unreadable-file proof requires an unprivileged fixture owner");
  const fixture = path.resolve(`.playback-media-${randomUUID().slice(0, 8)}`);
  const data = path.join(fixture, "d");
  const socket = path.join(fixture, "s");
  const music = path.join(fixture, "music");
  const wav = path.join(music, "original.wav");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C",
    PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const pool = new pg.Pool({
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000,
  });
  try {
    await mkdir(fixture, { mode: 0o700 });
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
    assert.deepEqual((await pool.query("SELECT 1 AS ready, current_setting('listen_addresses') AS tcp")).rows,
      [{ ready: 1, tcp: "" }]);
    const db = drizzle(pool, { schema: { roots, mediaFiles, recordings } });
    await runMigrations(db, migrations);
    assert.equal((await pool.query("SELECT * FROM library_playback_history.migrations")).rowCount, 3);
    await exec("/usr/bin/ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
      "-c:a", "pcm_s16le", "-metadata", "title=Generated playback fixture", wav,
    ], { timeout: 10_000 });
    const original = await readFile(wav);
    const originalHash = hash(original);
    assert.ok(original.length > LIBRARY_MEDIA_READ_MAX_BYTES * 2);
    const repository = createLibraryRepository(db);
    const root = await repository.createRoot({ path: music });
    const file = await repository.createMediaFile({ rootId: root.id, relativePath: "original.wav" });
    const row = async (id: string) => {
      const [stored] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, id));
      assert.ok(stored);
      return stored;
    };
    const assertClosed = async () => {
      for (const fd of await readdir("/proc/self/fd")) {
        let target: string;
        try {
          target = await readlink(`/proc/self/fd/${fd}`);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        assert.ok(!target.startsWith(music + "/"), `Owned media descriptor ${fd} leaked`);
      }
    };
    await assert.rejects(openLibraryPlaybackMedia(repository, file.id), playbackError("NOT_VERIFIED"));
    await assert.rejects(openLibraryPlaybackMedia(repository, randomUUID()), playbackError("NOT_FOUND"));
    await assert.rejects(openLibraryPlaybackMedia(repository, "../original.wav"), LibraryRepositoryInputError);
    const verified = await verifyLibraryMediaFile(repository, file.id, {
      ffprobePath: "/usr/bin/ffprobe", ffmpegPath: "/usr/bin/ffmpeg",
      maxProbeInputBytes: 2 * 1024 * 1024, maxDecodeInputBytes: 2 * 1024 * 1024,
      maxOutputBytes: 1024 * 1024, probeTimeoutMs: 5000, decodeTimeoutMs: 5000,
    });
    assert.equal(verified.status, "verified");
    if (verified.status !== "verified") throw new Error("Generated WAV did not actually decode");
    assert.equal(verified.observation.audio.codec, "pcm_s16le");
    assert.equal(verified.observation.audio.decodedSampleFrames, 88_200);
    assert.equal((await row(file.id)).recordingId, null);
    assert.equal((await repository.listFiles()).items[0]?.id, file.id);

    const media = await openLibraryPlaybackMedia(repository, file.id);
    try {
      assert.deepEqual(media.metadata, {
        mediaFileId: file.id, sizeBytes: original.length, contentType: "audio/wav",
      });
      assert.deepEqual(Object.keys(media).sort(), ["chunks", "close", "metadata", "read"]);
      assert.doesNotMatch(JSON.stringify(media), /"(?:relativePath|rootId|root|path|fd|write)"\s*:|\/home\//);
      assert.ok(Object.isFrozen(media) && Object.isFrozen(media.metadata));
      assert.equal(hash(await collect(media.chunks())), originalHash);
      assert.deepEqual(parseLibraryMediaByteRange(undefined, original.length), {
        status: 200, start: 0, end: original.length - 1, length: original.length,
        totalSize: original.length, contentRange: null,
      });
      for (const [header, start, end] of [
        ["bytes=31-1234", 31, 1234],
        ["bytes=950-", 950, original.length - 1],
        ["bytes=-777", original.length - 777, original.length - 1],
        [`bytes=${original.length - 10}-${original.length + 999}`, original.length - 10, original.length - 1],
        [`bytes=-${original.length + 1}`, 0, original.length - 1],
        ["bytes=0-0", 0, 0],
      ] as const) {
        assert.deepEqual(parseLibraryMediaByteRange(header, original.length), {
          status: 206, start, end, length: end - start + 1, totalSize: original.length,
          contentRange: `bytes ${start}-${end}/${original.length}`,
        });
        assert.deepEqual(await collect(media.chunks(header)), original.subarray(start, end + 1));
      }
      for (const header of [
        "", "bytes=-", "bytes=-0", "bytes=2-1", `bytes=${original.length}-`,
        "bytes=0-9007199254740992", "bytes=9007199254740992-", "bytes=-9007199254740992",
        "bytes=0-1,2-3", "bytes= 0-1", "Bytes=0-1", "bytes=1-2\n", "bytes=1.5-2", "bytes=+1-2",
        `bytes=${"0".repeat(130)}-`,
      ]) {
        const is416 = (error: unknown) => {
          assert.ok(error instanceof LibraryMediaRangeError);
          assert.equal(error.status, 416);
          assert.equal(error.totalSize, original.length);
          assert.equal(error.contentRange, `bytes */${original.length}`);
          return true;
        };
        assert.throws(() => parseLibraryMediaByteRange(header, original.length), is416);
        await assert.rejects(collect(media.chunks(header)), is416);
      }
      for (const size of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
        assert.throws(() => parseLibraryMediaByteRange(undefined, size), RangeError);
      }
      for (const [position, length] of [
        [-1, 1], [original.length, 1], [0.5, 1], [Number.MAX_SAFE_INTEGER + 1, 1],
        [0, 0], [0, -1], [0, 0.5], [0, LIBRARY_MEDIA_READ_MAX_BYTES + 1],
      ]) {
        await assert.rejects(media.read(position!, length!), RangeError);
      }
      assert.deepEqual(Buffer.from(await media.read(original.length - 10, LIBRARY_MEDIA_READ_MAX_BYTES)), original.subarray(-10));
      const iterator = media.chunks()[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.length, LIBRARY_MEDIA_READ_MAX_BYTES);
      await iterator.return?.();
      assert.deepEqual(Buffer.from(await media.read(31, 20)), original.subarray(31, 51));

      // Replacing the pathname cannot switch an already confined reader to different bytes.
      const pinned = path.join(music, "pinned.wav");
      await rename(wav, pinned);
      try {
        await writeFile(wav, Buffer.alloc(original.length, 65));
        assert.equal(hash(await collect(media.chunks())), originalHash);
      } finally {
        await rm(wav, { force: true });
        await rename(pinned, wav);
      }
    } finally {
      const closing = media.close();
      assert.equal(media.close(), closing, "Close is caller-owned and performed once");
      await closing;
    }
    await assert.rejects(media.read(0, 1), playbackError("CLOSED"));
    await assert.rejects(collect(media.chunks()), playbackError("CLOSED"));
    await assertClosed();

    const abort = new AbortController();
    const cancellable = await openLibraryPlaybackMedia(repository, file.id, { signal: abort.signal });
    try {
      const iterator = cancellable.chunks()[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.length, LIBRARY_MEDIA_READ_MAX_BYTES);
      abort.abort();
      await assert.rejects(iterator.next(), playbackError("CANCELLED"));
      await assert.rejects(cancellable.read(0, 1), playbackError("CANCELLED"));
    } finally {
      await cancellable.close();
    }
    let lookups = 0;
    await assert.rejects(openLibraryPlaybackMedia({
      ...repository, async getPlaybackTarget(id) { lookups++; return repository.getPlaybackTarget(id); },
    }, file.id, { signal: abort.signal }), playbackError("CANCELLED"));
    assert.equal(lookups, 0);
    await assertClosed();

    // Branch fixtures reuse real positive evidence; only the main file is the decode acceptance path.
    const fixtureVerified = async (relativePath: string, rootId = root.id, codec = verified.observation.audio.codec) => {
      const created = await repository.createMediaFile({ rootId, relativePath });
      await repository.recordVerification(created.id, {
        availability: "verified", checkedAt: new Date(), audio: { ...verified.observation.audio, codec },
      });
      return created;
    };
    const unavailable = await repository.createMediaFile({ rootId: root.id, relativePath: "unavailable.wav" });
    await repository.recordVerification(unavailable.id, { availability: "unavailable", checkedAt: new Date(), reason: "missing" });
    await assert.rejects(openLibraryPlaybackMedia(repository, unavailable.id), playbackError("NOT_VERIFIED"));
    const missing = await fixtureVerified("missing.wav");
    const beforeMissing = await row(missing.id);
    await assert.rejects(openLibraryPlaybackMedia(repository, missing.id), playbackError("FILE_UNAVAILABLE"));
    const afterMissing = await row(missing.id);
    assert.deepEqual(afterMissing, {
      ...beforeMissing, availability: "unavailable", unavailableReason: "missing", checkedAt: afterMissing.checkedAt,
    });
    await writeFile(path.join(music, "empty.wav"), new Uint8Array());
    const empty = await fixtureVerified("empty.wav");
    await assert.rejects(openLibraryPlaybackMedia(repository, empty.id), playbackError("FILE_UNAVAILABLE"));
    assert.equal((await row(empty.id)).unavailableReason, "invalid_audio");
    assert.equal((await row(empty.id)).audioCodec, verified.observation.audio.codec);
    await writeFile(path.join(music, "unreadable.wav"), original, { mode: 0o000 });
    const unreadable = await fixtureVerified("unreadable.wav");
    try {
      await assert.rejects(openLibraryPlaybackMedia(repository, unreadable.id), playbackError("FILE_UNAVAILABLE"));
      assert.equal((await row(unreadable.id)).unavailableReason, "unreadable");
    } finally {
      await chmod(path.join(music, "unreadable.wav"), 0o600);
    }
    const offline = await repository.createRoot({ path: path.join(fixture, "offline") });
    const offlineFile = await fixtureVerified("song.wav", offline.id);
    const beforeOffline = await row(offlineFile.id);
    await assert.rejects(openLibraryPlaybackMedia(repository, offlineFile.id),
      (error: unknown) => error instanceof LibraryFileAccessError && error.code === "ROOT_UNAVAILABLE");
    assert.deepEqual(await row(offlineFile.id), beforeOffline);
    const outside = path.join(fixture, "outside.wav");
    await writeFile(outside, original);
    await symlink(outside, path.join(music, "escape.wav"));
    const escape = await fixtureVerified("escape.wav");
    const beforeEscape = await row(escape.id);
    await assert.rejects(openLibraryPlaybackMedia(repository, escape.id),
      (error: unknown) => error instanceof LibraryFileAccessError && error.code === "PATH_ESCAPES_ROOT");
    assert.deepEqual(await row(escape.id), beforeEscape);
    assert.equal(hash(await readFile(outside)), originalHash);
    for (const relativePath of ["unsupported.bin", "mismatched.mp3"]) {
      await writeFile(path.join(music, relativePath), original);
      const unsupported = await fixtureVerified(relativePath);
      const before = await row(unsupported.id);
      await assert.rejects(openLibraryPlaybackMedia(repository, unsupported.id), playbackError("UNSUPPORTED_ORIGINAL_FORMAT"));
      assert.deepEqual(await row(unsupported.id), before);
    }
    await assertClosed();

    const dbFailure = new Error("Fixture lookup failure");
    await assert.rejects(openLibraryPlaybackMedia({
      ...repository, async getPlaybackTarget() { throw dbFailure; },
    }, file.id), (error: unknown) => error === dbFailure);
    const control = await open(wav, "r");
    const prototype: FileHandle = Object.getPrototypeOf(control);
    await control.close();
    const originalStat = prototype.stat;
    const metadataFailure = new Error("Fixture descriptor metadata failure");
    let statCalls = 0;
    const statMock = t.mock.method(prototype, "stat", async function(this: FileHandle) {
      if (++statCalls === 2) throw metadataFailure;
      return originalStat.call(this);
    });
    try {
      const before = await row(file.id);
      await assert.rejects(openLibraryPlaybackMedia(repository, file.id),
        (error: unknown) => error instanceof LibraryPlaybackMediaError
          && error.code === "METADATA_UNAVAILABLE" && error.cause === metadataFailure);
      assert.deepEqual(await row(file.id), before);
    } finally {
      statMock.mock.restore();
    }
    await assertClosed();

    const readFailure = new Error("Fixture read failure");
    const readErrorMedia = await openLibraryPlaybackMedia(repository, file.id);
    const readMock = t.mock.method(prototype, "read", async () => { throw readFailure; });
    try {
      await assert.rejects(collect(readErrorMedia.chunks()), (error: unknown) => error === readFailure);
    } finally {
      readMock.mock.restore();
      await readErrorMedia.close();
    }
    // FileHandle.close is instance-owned, unlike stat/read on its prototype.
    let closeHandle: FileHandle | undefined;
    const captureHandle = t.mock.method(prototype, "stat", async function(this: FileHandle) {
      closeHandle = this;
      return originalStat.call(this);
    });
    let closeErrorMedia;
    try {
      closeErrorMedia = await openLibraryPlaybackMedia(repository, file.id);
    } finally {
      captureHandle.mock.restore();
    }
    assert.ok(closeHandle);
    const originalClose = closeHandle.close;
    const closeFailure = new Error("Fixture close failure");
    let closeCalls = 0;
    const closeMock = t.mock.method(closeHandle, "close", async function(this: FileHandle) {
      closeCalls++;
      await originalClose.call(this);
      throw closeFailure;
    });
    try {
      const closing = closeErrorMedia.close();
      assert.equal(closeErrorMedia.close(), closing);
      await assert.rejects(closing, (error: unknown) => error === closeFailure);
      await assert.rejects(closeErrorMedia.close(), (error: unknown) => error === closeFailure);
      await assert.rejects(closeErrorMedia.read(0, 1), playbackError("CLOSED"));
      assert.equal(closeCalls, 1);
    } finally {
      closeMock.mock.restore();
    }
    await assertClosed();
    const shrunkPath = path.join(music, "shrunk.wav");
    await writeFile(shrunkPath, original);
    const shrunk = await fixtureVerified("shrunk.wav");
    const shrunkMedia = await openLibraryPlaybackMedia(repository, shrunk.id);
    try {
      await truncate(shrunkPath, 0);
      await assert.rejects(collect(shrunkMedia.chunks()), playbackError("UNEXPECTED_EOF"));
    } finally {
      await shrunkMedia.close();
    }
    assert.equal(hash(await readFile(wav)), originalHash);
    assert.equal((await row(file.id)).availability, "verified");
    await assertClosed();
  } finally {
    t.mock.restoreAll();
    await pool.end();
    if (existsSync(path.join(data, "postmaster.pid"))) {
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-t", "15", "-w", "stop"], { env, timeout: 20_000 });
    }
    if (!existsSync(path.join(data, "postmaster.pid"))) {
      await rm(fixture, { recursive: true, force: true });
    }
  }
});
