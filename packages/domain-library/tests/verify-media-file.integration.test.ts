import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
  AudioProbeConfigurationError,
  createLibraryRepository,
  LibraryFileAccessError,
  LibraryMediaFileNotFoundError,
  LibraryMediaMetadataWriteError,
  LibraryMediaWriteError,
  LibraryRepositoryInputError,
  mediaFiles,
  roots,
  verifyLibraryMediaFile,
  type AudioProbeOptions,
} from "../src/index";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const files = [
  { tag: "0000_recordings", path: "packages/domain-catalog/migrations/0000_recordings.sql" },
  { tag: "0001_library_identity", path: "packages/domain-library/migrations/0000_library_identity.sql" },
  { tag: "0002_library_listing", path: "packages/domain-library/migrations/0001_library_listing.sql" },
];
const migrations: MigrationOptions = {
  migrationsRoot: repositoryRoot,
  history: { schema: "library_verifier_history", table: "migrations" },
  files,
  journal: {
    version: "7", dialect: "postgresql",
    entries: files.map((file, idx) => ({
      idx, version: "7", when: (idx + 1) * 100, tag: file.tag, breakpoints: true,
    })),
  },
};
const probeOptions: AudioProbeOptions = {
  ffprobePath: "/usr/bin/ffprobe", ffmpegPath: "/usr/bin/ffmpeg",
  maxProbeInputBytes: 2 * 1024 * 1024, maxDecodeInputBytes: 2 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024, probeTimeoutMs: 5000, decodeTimeoutMs: 5000,
};

test("persisted file identity -> confined real decode -> PostgreSQL verified listing", { timeout: 120_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to local PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  assert.equal(process.platform, "linux");
  assert.notEqual(process.getuid?.(), 0, "Unreadable-file proof requires an unprivileged fixture owner");
  const fixture = await mkdtemp("/tmp/mint-vfy-");
  const data = path.join(fixture, "d");
  const socket = path.join(fixture, "s");
  const music = path.join(fixture, "music");
  const wav = path.join(music, "original.wav");
  const image = path.join(music, "image.bmp");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C",
    PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const pool = new pg.Pool({
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000,
  });
  let succeeded = false;
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
    assert.deepEqual((await pool.query("SELECT 1 AS ready, current_setting('listen_addresses') AS tcp")).rows,
      [{ ready: 1, tcp: "" }]);
    const db = drizzle(pool, { schema: { roots, mediaFiles, recordings } });
    await runMigrations(db, migrations);
    assert.equal((await pool.query("SELECT * FROM library_verifier_history.migrations")).rowCount, 3);
    await exec("/usr/bin/ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.5",
      "-c:a", "pcm_s16le", "-metadata", "title=Generated title", "-metadata", "artist=Generated artist",
      "-metadata", "album=Generated album", wav,
    ], { timeout: 10_000 });
    await exec("/usr/bin/ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16",
      "-frames:v", "1", "-threads", "1", image,
    ], { timeout: 10_000 });
    const original = await readFile(wav);
    const imageBytes = await readFile(image);
    const repository = createLibraryRepository(db);
    const root = await repository.createRoot({ path: music });
    const file = await repository.createMediaFile({
      rootId: root.id, relativePath: "original.wav",
      importedTags: { title: "Previous title", version: "Preserved version" },
    });
    const row = async (id = file.id) => {
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
    assert.deepEqual(await repository.getVerificationTarget(file.id), {
      root: { id: root.id, path: music }, mediaFile: { rootId: root.id, relativePath: "original.wav" },
    });
    assert.deepEqual(await repository.listFiles(), { items: [], nextCursor: null });
    await assert.rejects(verifyLibraryMediaFile(repository, randomUUID(), probeOptions), LibraryMediaFileNotFoundError);
    await assert.rejects(verifyLibraryMediaFile(repository, "../original.wav", probeOptions), LibraryRepositoryInputError);

    const verified = await verifyLibraryMediaFile(repository, file.id, probeOptions);
    assert.equal(verified.status, "verified");
    if (verified.status !== "verified") throw new Error("Real audio did not verify");
    assert.equal(verified.metadata, "imported");
    assert.deepEqual(verified.observation.audio, {
      streamIndex: 0, codec: "pcm_s16le", decodedSampleFrames: 22_050, durationMs: 500,
    });
    const positive = await row();
    assert.equal(positive.availability, "verified");
    assert.equal(positive.recordingId, null);
    assert.equal(positive.audioCodec, "pcm_s16le");
    assert.equal(positive.audioStreamIndex, 0);
    assert.equal(positive.decodedSampleFrames, 22_050);
    assert.equal(positive.durationMs, 500);
    assert.deepEqual(positive.checkedAt, verified.observation.checkedAt);
    assert.deepEqual(positive.verifiedAt, verified.observation.checkedAt);
    assert.equal((await db.select().from(recordings)).length, 0, "No speculative recording identity");
    assert.deepEqual(await repository.listFiles({ limit: 1, search: "artist generated" }), {
      items: [{
        id: file.id, recordingId: null, title: "Generated title", artist: "Generated artist",
        album: "Generated album", version: "Preserved version", durationMs: 500,
      }], nextCursor: null,
    });
    await assertClosed();

    for (const [overrides, reason] of [
      [{ ffmpegPath: path.join(fixture, "absent-ffmpeg") }, "tool-infrastructure"],
      [{ maxDecodeInputBytes: 64 }, "resource-limit"],
      [{ maxOutputBytes: 64 }, "resource-limit"],
      [{ decodeTimeoutMs: 1 }, "time-limit"],
    ] as const) {
      const before = await row();
      const result = await verifyLibraryMediaFile(repository, file.id, { ...probeOptions, ...overrides });
      assert.equal(result.status, "inconclusive");
      if (result.status !== "inconclusive") throw new Error("Tool failure became definitive");
      assert.equal(result.reason, reason);
      assert.equal(result.verificationPersisted, false);
      assert.deepEqual(await row(), before);
      await assertClosed();
    }
    await assert.rejects(verifyLibraryMediaFile(repository, file.id, {
      ...probeOptions, maxDecodeInputBytes: 0,
    }), AudioProbeConfigurationError);
    assert.deepEqual(await row(), positive);
    await assertClosed();

    const abort = new AbortController();
    abort.abort();
    assert.deepEqual(await verifyLibraryMediaFile(repository, file.id, { ...probeOptions, signal: abort.signal }),
      { status: "inconclusive", reason: "cancelled", verificationPersisted: false });
    const during = new AbortController();
    const timer = setTimeout(() => during.abort(), 10);
    try {
      const result = await verifyLibraryMediaFile(repository, file.id, { ...probeOptions, signal: during.signal });
      assert.equal(result.status, "inconclusive");
      if (result.status === "inconclusive") assert.equal(result.reason, "cancelled");
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(await row(), positive);
    await assertClosed();

    const fallback = await verifyLibraryMediaFile(repository, file.id, {
      ...probeOptions, ffprobePath: path.join(fixture, "absent-ffprobe"),
    });
    assert.equal(fallback.status, "verified");
    if (fallback.status !== "verified") throw new Error("Optional probe failure blocked full decode");
    assert.equal(fallback.metadata, "unavailable");
    assert.deepEqual(fallback.observation.probe, { status: "unavailable", reason: "spawn-failed" });
    const afterFallback = await row();
    for (const key of ["importedTitle", "importedArtist", "importedAlbum", "importedVersion"] as const) {
      assert.equal(afterFallback[key], positive[key]);
    }

    const metadataFailure = new Error("Fixture metadata write failure");
    await assert.rejects(verifyLibraryMediaFile({
      ...repository,
      async importVerifiedAudioTags() { throw metadataFailure; },
    }, file.id, probeOptions), (error: unknown) => {
      assert.ok(error instanceof LibraryMediaMetadataWriteError);
      assert.equal(error.cause, metadataFailure);
      assert.equal(error.verificationPersisted, true);
      assert.equal(error.observation.audio.decodedSampleFrames, 22_050);
      assert.equal(error.mediaFileId, file.id);
      return true;
    });
    assert.equal((await row()).availability, "verified");
    assert.equal((await row()).importedVersion, "Preserved version");
    const afterWrite = new AbortController();
    const cancelledAfterWrite = await verifyLibraryMediaFile({
      ...repository,
      async recordVerification(id, outcome) {
        await repository.recordVerification(id, outcome);
        afterWrite.abort();
      },
    }, file.id, { ...probeOptions, signal: afterWrite.signal });
    assert.deepEqual(cancelledAfterWrite, {
      status: "inconclusive", reason: "cancelled", verificationPersisted: true,
    });
    assert.equal((await row()).availability, "verified");

    const offline = await repository.createRoot({ path: path.join(fixture, "offline") });
    const offlineFile = await repository.createMediaFile({ rootId: offline.id, relativePath: "song.wav" });
    const offlineBefore = await row(offlineFile.id);
    await assert.rejects(verifyLibraryMediaFile(repository, offlineFile.id, probeOptions),
      (error: unknown) => error instanceof LibraryFileAccessError && error.code === "ROOT_UNAVAILABLE");
    assert.deepEqual(await row(offlineFile.id), offlineBefore);
    const outside = path.join(fixture, "outside.wav");
    await writeFile(outside, original);
    await symlink(outside, path.join(music, "escape.wav"));
    const escape = await repository.createMediaFile({ rootId: root.id, relativePath: "escape.wav" });
    const escapeBefore = await row(escape.id);
    await assert.rejects(verifyLibraryMediaFile(repository, escape.id, probeOptions),
      (error: unknown) => error instanceof LibraryFileAccessError && error.code === "PATH_ESCAPES_ROOT");
    assert.deepEqual(await row(escape.id), escapeBefore);
    assert.deepEqual(await readFile(outside), original);

    const noAudio = await repository.createMediaFile({ rootId: root.id, relativePath: "image.bmp" });
    const rejected = await verifyLibraryMediaFile(repository, noAudio.id, probeOptions);
    assert.equal(rejected.status, "unavailable");
    if (rejected.status === "unavailable") assert.equal(rejected.outcome.reason, "invalid_audio");
    assert.equal((await row(noAudio.id)).unavailableReason, "invalid_audio");
    assert.equal((await row(noAudio.id)).audioCodec, null);
    const junkPath = path.join(music, "junk.bin");
    await writeFile(junkPath, Buffer.alloc(4096, 65));
    const junk = await repository.createMediaFile({ rootId: root.id, relativePath: "junk.bin" });
    const junkBefore = await row(junk.id);
    const junkResult = await verifyLibraryMediaFile(repository, junk.id, probeOptions);
    assert.equal(junkResult.status, "inconclusive");
    assert.deepEqual(await row(junk.id), junkBefore);

    const [recording] = await db.insert(recordings).values({ title: "Confirmed identity" }).returning();
    assert.ok(recording);
    await writeFile(path.join(music, "linked.wav"), original);
    const linked = await repository.createMediaFile({
      rootId: root.id, relativePath: "linked.wav", recordingId: recording.id,
    });
    assert.equal((await verifyLibraryMediaFile(repository, linked.id, probeOptions)).status, "verified");
    const first = await repository.listFiles({ limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await repository.listFiles({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.items, ...second.items].map((item) => item.id).sort(), [file.id, linked.id].sort());
    assert.doesNotMatch(JSON.stringify(first), /relativePath|rootId|audioCodec|checkedAt|\/tmp\//);

    await chmod(path.join(music, "linked.wav"), 0);
    try {
      const before = await row(linked.id);
      const result = await verifyLibraryMediaFile(repository, linked.id, probeOptions);
      assert.equal(result.status, "unavailable");
      if (result.status === "unavailable") assert.equal(result.outcome.reason, "unreadable");
      const after = await row(linked.id);
      assert.deepEqual(after, { ...before, availability: "unavailable", unavailableReason: "unreadable", checkedAt: after.checkedAt });
    } finally {
      await chmod(path.join(music, "linked.wav"), 0o600);
    }
    assert.equal((await verifyLibraryMediaFile(repository, linked.id, probeOptions)).status, "verified");
    const beforeMissing = await row(linked.id);
    assert.deepEqual(await readFile(path.join(music, "linked.wav")), original);
    await rm(path.join(music, "linked.wav"));
    const missing = await verifyLibraryMediaFile(repository, linked.id, probeOptions);
    assert.equal(missing.status, "unavailable");
    if (missing.status === "unavailable") assert.equal(missing.outcome.reason, "missing");
    const afterMissing = await row(linked.id);
    assert.deepEqual(afterMissing, {
      ...beforeMissing, availability: "unavailable", unavailableReason: "missing", checkedAt: afterMissing.checkedAt,
    });
    assert.equal(afterMissing.recordingId, recording.id);
    assert.deepEqual((await repository.listFiles()).items.map((item) => item.id), [file.id]);

    const newer = new Date(Date.now() + 60_000);
    await assert.rejects(verifyLibraryMediaFile({
      ...repository,
      async importVerifiedAudioTags(id, checkedAt, tags) {
        await repository.recordVerification(id, {
          availability: "verified", checkedAt: newer, audio: verified.observation.audio,
        });
        await repository.importVerifiedAudioTags(id, checkedAt, tags);
      },
    }, file.id, probeOptions), (error: unknown) =>
      error instanceof LibraryMediaMetadataWriteError && error.cause instanceof LibraryMediaWriteError);
    const beforeStale = await row();
    await assert.rejects(verifyLibraryMediaFile(repository, file.id, probeOptions), LibraryMediaWriteError);
    assert.deepEqual(await row(), beforeStale);
    assert.deepEqual(beforeStale.checkedAt, newer);
    assert.equal(beforeStale.importedVersion, "Preserved version");
    assert.deepEqual(await readFile(wav), original);
    assert.deepEqual(await readFile(image), imageBytes);
    await assertClosed();
    succeeded = true;
  } finally {
    await pool.end();
    if (existsSync(path.join(data, "postmaster.pid"))) {
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-t", "15", "-w", "stop"], { env, timeout: 20_000 });
    }
    if (succeeded && !existsSync(path.join(data, "postmaster.pid"))) {
      await rm(fixture, { recursive: true, force: true });
    }
  }
});
