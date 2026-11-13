import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordings } from "@mint/domain-catalog";
import { mediaFiles, roots } from "@mint/domain-library";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { users } from "@mint/domain-accounts";
import {
  createPlaybackQueueRepository, PlaybackQueueError, queueEntries, queueSnapshots,
} from "../src/index";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("queue snapshots preserve verified membership, occurrences, revisions and bounded pages on PostgreSQL", {
  timeout: 120_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to local PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp("/tmp/mint-playback-");
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "s");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C",
    PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const pool = new pg.Pool({
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "", max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 10_000, statement_timeout: 10_000,
  });
  let started = false;
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
    started = true;
    assert.deepEqual((await pool.query("SELECT 1 AS ready, current_setting('listen_addresses') AS tcp")).rows, [
      { ready: 1, tcp: "" },
    ]);

    for (const migration of [
      "packages/domain-accounts/migrations/0000_accounts.sql",
      "packages/domain-catalog/migrations/0000_recordings.sql",
      "packages/domain-library/migrations/0000_library_identity.sql",
      "packages/domain-library/migrations/0001_library_listing.sql",
      "packages/domain-playback/migrations/0000_listening_history.sql",
      "packages/domain-playback/migrations/0001_queue_snapshots.sql",
    ]) {
      await pool.query(await readFile(path.join(repositoryRoot, migration), "utf8"));
    }

    const db = drizzle(pool, { schema: { users, recordings, roots, mediaFiles, queueSnapshots, queueEntries } });
    const [user, otherUser] = await db.insert(users).values([
      { email: "listener@example.test", name: "Listener", passwordHash: "fixture", status: "active" },
      { email: "other@example.test", name: "Other", passwordHash: "fixture", status: "active" },
    ]).returning({ id: users.id });
    assert.ok(user);
    assert.ok(otherUser);
    const [root] = await db.insert(roots).values({ path: "/fixture/read-only-library" }).returning({ id: roots.id });
    assert.ok(root);
    const [recording] = await db.insert(recordings).values({
      title: "Catalog fallback", durationMs: 180_000,
    }).returning({ id: recordings.id });
    assert.ok(recording);
    const verifiedAt = new Date("2025-01-01T00:00:00.000Z");
    const fixtures = await db.insert(mediaFiles).values(Array.from({ length: 125 }, (_, index) => ({
      rootId: root.id,
      relativePath: `Album/track-${String(index).padStart(3, "0")}.flac`,
      recordingId: recording.id,
      availability: "verified" as const,
      checkedAt: verifiedAt,
      verifiedAt,
      audioStreamIndex: 0,
      audioCodec: "flac",
      decodedSampleFrames: 8_640_000,
      durationMs: 180_000,
      importedTitle: `Café Track ${String(index).padStart(3, "0")}`,
      importedArtist: "Example Artist",
      importedAlbum: "Example Album",
    }))).returning({ id: mediaFiles.id });
    assert.equal(fixtures.length, 125);
    const [unverified] = await db.insert(mediaFiles).values({
      rootId: root.id, relativePath: "Album/not-verified.flac", importedTitle: "Café Track Unverified",
    }).returning({ id: mediaFiles.id });
    assert.ok(unverified);
    const orderedIds = fixtures.map(({ id }) => id).sort();
    let clock = new Date("2025-02-01T00:00:00.000Z");
    const repository = createPlaybackQueueRepository(db, () => new Date(clock));

    const libraryQueue = await repository.open(user.id, {
      selection: { source: "library", search: "CAFE track" },
      shuffle: false,
      current: { mediaFileId: orderedIds[110]! },
    });
    assert.equal(libraryQueue.context.total, 125);
    assert.equal(libraryQueue.context.position, 110);
    assert.deepEqual(libraryQueue.items.map((item) => item.id), orderedIds.slice(90, 125));
    assert.ok(libraryQueue.items.length <= 100);
    const snapshotCount = await db.select({ count: sql<number>`count(*)::int` }).from(queueSnapshots);
    await assert.rejects(repository.open(user.id, {
      selection: { source: "items", items: [{ mediaFileId: orderedIds[0]! }, { mediaFileId: unverified.id }] },
      shuffle: false,
    }), (error: unknown) => error instanceof PlaybackQueueError && error.code === "CONFLICT");
    assert.equal((await db.select({ count: sql<number>`count(*)::int` }).from(queueSnapshots))[0]?.count,
      snapshotCount[0]?.count, "invalid explicit selection rolls back its partial snapshot");
    await db.insert(mediaFiles).values({
      rootId: root.id, relativePath: "Album/added-later.flac", availability: "verified",
      checkedAt: verifiedAt, verifiedAt, audioStreamIndex: 0, audioCodec: "flac",
      decodedSampleFrames: 8_640_000, durationMs: 180_000, importedTitle: "Café Track Added",
    });
    assert.equal((await repository.page(user.id, libraryQueue.context.id, 0)).context.total, 125);
    await assert.rejects(repository.page(otherUser.id, libraryQueue.context.id, 0), (error: unknown) =>
      error instanceof PlaybackQueueError && error.code === "NOT_FOUND");

    const occurrences = [randomUUID(), randomUUID()];
    const duplicateQueue = await repository.open(user.id, {
      selection: {
        source: "items",
        items: [
          { mediaFileId: orderedIds[0]!, occurrenceId: occurrences[0]! },
          { mediaFileId: orderedIds[0]!, occurrenceId: occurrences[1]! },
          { mediaFileId: orderedIds[1]! },
          { mediaFileId: orderedIds[2]! },
          { mediaFileId: orderedIds[3]! },
        ],
      },
      shuffle: false,
      current: { mediaFileId: orderedIds[0]!, occurrenceId: occurrences[1]! },
    });
    assert.equal(duplicateQueue.context.position, 1);
    assert.deepEqual(duplicateQueue.items.slice(0, 2).map((item) => item.id), [
      orderedIds[0], orderedIds[0],
    ]);
    assert.notEqual(duplicateQueue.items[0]?.queueId, duplicateQueue.items[1]?.queueId);
    assert.deepEqual(duplicateQueue.items.slice(0, 2).map((item) => item.occurrenceId), occurrences);
    const currentEntryId = duplicateQueue.items[1]!.queueId;
    const appended = await repository.edit(user.id, duplicateQueue.context.id, {
      revision: duplicateQueue.context.revision,
      currentEntryId,
      edit: {
        action: "append",
        selection: { source: "items", items: [{ mediaFileId: orderedIds[4]! }] },
        next: true,
      },
    });
    assert.equal(appended.context.position, 1);
    assert.deepEqual(appended.items.map((item) => item.id), [
      orderedIds[0], orderedIds[0], orderedIds[4], orderedIds[1], orderedIds[2], orderedIds[3],
    ]);
    await assert.rejects(repository.edit(user.id, duplicateQueue.context.id, {
      revision: duplicateQueue.context.revision,
      currentEntryId,
      edit: { action: "clear" },
    }), (error: unknown) => error instanceof PlaybackQueueError && error.code === "CONFLICT");

    const moved = await repository.edit(user.id, duplicateQueue.context.id, {
      revision: appended.context.revision,
      currentEntryId,
      edit: {
        action: "move",
        entryId: appended.items[5]!.queueId,
        before: appended.items[3]!.queueId,
      },
    });
    assert.deepEqual(moved.items.map((item) => item.id), [
      orderedIds[0], orderedIds[0], orderedIds[4], orderedIds[3], orderedIds[1], orderedIds[2],
    ]);
    assert.equal(moved.context.position, 1);
    const removed = await repository.edit(user.id, duplicateQueue.context.id, {
      revision: moved.context.revision,
      currentEntryId,
      edit: { action: "remove", entryId: moved.items[3]!.queueId },
    });
    assert.deepEqual(removed.items.map((item) => item.id), [
      orderedIds[0], orderedIds[0], orderedIds[4], orderedIds[1], orderedIds[2],
    ]);
    assert.equal(removed.context.position, 1);
    const cleared = await repository.edit(user.id, duplicateQueue.context.id, {
      revision: removed.context.revision,
      currentEntryId,
      edit: { action: "clear" },
    });
    assert.equal(cleared.context.total, 2);
    assert.equal(cleared.context.position, 1);

    const shuffleQueue = await repository.open(user.id, {
      selection: { source: "items", items: orderedIds.slice(0, 4).map((mediaFileId) => ({ mediaFileId })) },
      shuffle: false,
      current: { mediaFileId: orderedIds[1]! },
    });
    const shuffleCurrentId = shuffleQueue.items[1]!.queueId;
    const shuffled = await repository.edit(user.id, shuffleQueue.context.id, {
      revision: shuffleQueue.context.revision,
      currentEntryId: shuffleCurrentId,
      edit: { action: "shuffle", enabled: true },
    });
    assert.equal(shuffled.context.position, 1);
    assert.equal(shuffled.items[1]?.queueId, shuffleCurrentId);
    assert.deepEqual(shuffled.items.slice(0, 2).map((item) => item.id), orderedIds.slice(0, 2));
    const unshuffled = await repository.edit(user.id, shuffleQueue.context.id, {
      revision: shuffled.context.revision,
      currentEntryId: shuffleCurrentId,
      edit: { action: "shuffle", enabled: false },
    });
    assert.deepEqual(unshuffled.items.map((item) => item.id), orderedIds.slice(0, 4));
    assert.equal(unshuffled.items[1]?.queueId, shuffleCurrentId);

    const staleQueue = await repository.open(user.id, {
      selection: { source: "items", items: orderedIds.slice(10, 12).map((mediaFileId) => ({ mediaFileId })) },
      shuffle: false,
    });
    await db.update(mediaFiles).set({
      availability: "unavailable",
      checkedAt: new Date(verifiedAt.getTime() + 1),
      unavailableReason: "missing",
    }).where(eq(mediaFiles.id, orderedIds[10]!));
    await assert.rejects(repository.page(user.id, staleQueue.context.id, 0), (error: unknown) =>
      error instanceof PlaybackQueueError && error.code === "CONFLICT");
    clock = new Date(clock.getTime() + 8 * 86_400_000);
    await assert.rejects(repository.page(user.id, libraryQueue.context.id, 0), (error: unknown) =>
      error instanceof PlaybackQueueError && error.code === "NOT_FOUND");
  } finally {
    await pool.end();
    if (started && existsSync(path.join(data, "postmaster.pid"))) {
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-t", "15", "-w", "stop"], {
        env, timeout: 20_000,
      });
    }
    if (!existsSync(path.join(data, "postmaster.pid"))) {
      await rm(cluster, { recursive: true, force: true });
    }
  }
});
