import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { musicCollections, musicEntries, musicExclusions, musicFolders, musicHistory, musicLikes } from "@mint/core/music-db";
import { collectionMutationSchema, createCollectionSchema, historyEventSchema, MusicError, smartRulesSchema } from "@mint/core/music";
import { collectionDetail, createCollection, deleteHistory, listCollections, musicProfile, mutateCollection,
  importedLikeCandidates, parseImportedLikesCursor, organizeCollection, playlistLibrarySearch, recordHistory, respondInvitation, setPrivateSession, smartTracks } from "../src/lib/music-store";
import { importLikedSongs } from "../src/lib/music-client";
import { discoverMusic } from "../src/lib/music-discovery";
import { catalogItems } from "../src/lib/player-catalog";
import { collectionFromParams, collectionParams, loadCollection } from "../src/lib/browser-catalog";

test("music contracts validate safe rules, revisions and bounded history", () => {
  assert.equal(smartRulesSchema.safeParse({ minYear: 2020, maxYear: 2000 }).success, false);
  assert.equal(smartRulesSchema.safeParse({ minBpm: 140, maxBpm: 100 }).success, false);
  assert.equal(smartRulesSchema.safeParse({ genre: "Electronic", mood: "energetic", minBpm: 118, maxBpm: 128, camelotKey: "8A", vocalType: "instrumental" }).success, true);
  assert.equal(collectionMutationSchema.safeParse({ action: "append", revision: 0, trackIds: [randomUUID()] }).success, false);
  assert.equal(collectionMutationSchema.safeParse({ action: "update", revision: 1, artworkUrl: "javascript:alert(1)" }).success, false);
  assert.equal(historyEventSchema.safeParse({ trackId: randomUUID(), eventId: randomUUID(), listenedMs: -1 }).success, false);
  assert.equal(historyEventSchema.safeParse({ trackId: randomUUID(), eventId: randomUUID(), listenedMs: 2000 }).success, true);
  const collection = {
    kind: "library" as const,
    query: "First",
    filters: {
      artist: "The Originals", album: "Record one", codec: "FLAC", minYear: 2000, maxYear: 2005,
      genre: "Electronic", mood: "chill", minBpm: 90, maxBpm: 128, camelotKey: "8A", vocalType: "instrumental" as const,
    },
  };
  const parsed = collectionFromParams(collectionParams(collection));
  assert.ok(parsed.success); assert.deepEqual(parsed.data, collection);
  assert.equal(collectionFromParams(new URLSearchParams({ kind: "library", minYear: "invalid" })).success, false);
  assert.equal(collectionFromParams(new URLSearchParams({ kind: "library", maxYear: "3001" })).success, false);
  assert.equal(collectionFromParams(new URLSearchParams({ kind: "library", minBpm: "10" })).success, false);
});

const url = process.env.MUSIC_TEST_DATABASE_URL;
test("legacy favorites are copied explicitly through existing likes writes, once per song", async () => {
  const calls: string[] = [];
  const a = randomUUID(), b = randomUUID();
  const request = async <T>(path: string, method = "GET"): Promise<T> => {
    assert.equal(method, "PUT");
    calls.push(path);
    return {} as T;
  };
  await importLikedSongs([], request);
  assert.deepEqual(calls, [], "merely viewing favorites must not import them");
  await importLikedSongs([a, b, a], request);
  assert.deepEqual(calls, [`likes/${a}`, `likes/${b}`]);
  await assert.rejects(importLikedSongs(Array.from({ length: 101 }, () => randomUUID()), request), /100/);
  assert.equal(calls.length, 2, "reject oversized batches before writing");
  let writes = 0;
  await assert.rejects(importLikedSongs([a, b], async <T>(): Promise<T> => {
    if (++writes === 2) throw new Error("Disconnected");
    return {} as T;
  }), /Disconnected/, "partial errors must not appear successful");
});

test("imported favorites cursors validate exact timestamps and track identities", () => {
  assert.equal(parseImportedLikesCursor(null), undefined);
  const position = { likedAt: "2026-01-01T00:00:00.123456Z", trackId: randomUUID() };
  assert.deepEqual(parseImportedLikesCursor(Buffer.from(JSON.stringify(position)).toString("base64url")), position);
  for (const value of ["invalid", "x".repeat(257), Buffer.from(JSON.stringify({ likedAt: "yesterday", trackId: position.trackId })).toString("base64url")]) {
    assert.throws(() => parseImportedLikesCursor(value), (error: unknown) => error instanceof MusicError && error.status === 400);
  }
});

test("native music persists isolation, collaboration, duplicates, privacy and library discovery", { skip: !url && "Set MUSIC_TEST_DATABASE_URL to run real PostgreSQL integration tests" }, async (suite) => {
  const namespace = `music_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema "${namespace}"`);
  const pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${namespace}` });
  const db = drizzle(pool, { schema });
  const globalDb = globalThis as unknown as { __mintDb?: { db: typeof db; pool: pg.Pool } };
  const previous = globalDb.__mintDb;
  globalDb.__mintDb = { db, pool };
  try {
    for (const migration of ["0000_init", "0001_workers", "0002_drop_previews", "0003_track_artwork_url", "0004_existing_library", "0005_analysis", "0006_music", "0009_playback_scale"]) {
      const source = await readFile(new URL(`../../../packages/core/migrations/${migration}.sql`, import.meta.url), "utf8");
      for (const statement of source.replaceAll('"public".', `"${namespace}".`).split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
    const [owner, editor, stranger] = await db.insert(schema.users).values(["owner", "editor", "stranger"].map((name) => ({
      email: `${name}@music.example`, name, status: "active" as const, passwordHash: "fixture-not-a-password",
    }))).returning();
    assert.ok(owner && editor && stranger);
    const [a, b, c, pending] = await db.insert(schema.tracks).values([
      { title: "First", artist: "The Originals", album: "Record one", year: 2001, codec: "flac", stage: "ready" as const, filePath: "/fixture/first.flac", durationSec: 90 },
      { title: "Second", artist: "The Originals", album: "Record one", year: 2002, existingCodec: "opus", stage: "ready" as const, existingFilePath: "/fixture/second.opus", existingDurationSec: 120 },
      { title: "Third", artist: "Other Artist", album: "Other Record", year: 2010, stage: "ready" as const, filePath: "/fixture/third.flac", durationSec: 90 },
      { title: "Pending", artist: "The Originals", year: 2001, stage: "queued" as const },
    ]).returning();
    assert.ok(a && b && c && pending);
    const create = (userId: string, input: unknown) => createCollection(db, userId, createCollectionSchema.parse(input));
    const mutation = (userId: string, id: string, input: unknown) => mutateCollection(db, userId, id, collectionMutationSchema.parse(input));
    const status = (value: number) => (error: unknown) => error instanceof MusicError && error.status === value;

    await suite.test("duplicate entries have distinct identities and preserve ordered playback pages", async () => {
      const playlist = await create(owner.id, { title: "Intentional repeats", trackIds: [a.id, b.id, a.id] });
      const detail = await collectionDetail(db, owner.id, playlist.id);
      assert.deepEqual(detail.entries.map((e) => e.track.id), [a.id, b.id, a.id]);
      assert.equal(new Set(detail.entries.map((e) => e.entryId)).size, 3);
      const first = await catalogItems({ userId: owner.id, collection: { kind: "playlist", id: playlist.id }, start: 0, size: 2 });
      const next = await catalogItems({ userId: owner.id, collection: { kind: "playlist", id: playlist.id }, start: 2, size: 2 });
      assert.equal(first.total, 3); assert.equal(next.total, 3);
      assert.deepEqual([...first.items, ...next.items].map((e) => e.id), [a.id, b.id, a.id]);
      assert.notEqual(first.items[0]?.occurrenceId, next.items[0]?.occurrenceId);
      assert.equal(first.items[1]?.duration, 120_000);
      const loaded = await loadCollection({ kind: "playlist", id: playlist.id }, new AbortController().signal, async (input) => {
        const params = new URL(String(input), "http://mint.test").searchParams;
        const collection = collectionFromParams(params); assert.ok(collection.success);
        return Response.json(await catalogItems({ userId: owner.id, collection: collection.data, start: Number(params.get("start")), size: 2 }));
      });
      assert.deepEqual(loaded.map((item) => item.id), [a.id, b.id, a.id], "queue loading preserves repeated native entries");
      const reordered = [detail.entries[2]!.entryId, detail.entries[0]!.entryId, detail.entries[1]!.entryId];
      await mutation(owner.id, playlist.id, { action: "reorder", revision: 1, entryIds: reordered });
      await mutation(owner.id, playlist.id, { action: "remove", revision: 2, entryId: reordered[0] });
      assert.deepEqual((await collectionDetail(db, owner.id, playlist.id)).entries.map((e) => e.track.id), [a.id, b.id]);
    });

    await suite.test("global library metadata filters survive URL roundtrips and match the full playback queue", async () => {
      const collection = { kind: "library" as const, query: "First", filters: { artist: "originals", album: "Record", codec: "FLAC", minYear: 2000, maxYear: 2005 } };
      const urlParams = collectionParams(collection), parsed = collectionFromParams(urlParams);
      assert.ok(parsed.success);
      const view = await catalogItems({ userId: owner.id, collection: parsed.data, start: 0, size: 100 });
      assert.deepEqual(view.items.map((item) => item.id), [a.id]);
      const queue = await loadCollection(collection, new AbortController().signal, async (input) => {
        const params = new URL(String(input), "http://mint.test").searchParams, selected = collectionFromParams(params);
        assert.ok(selected.success); assert.deepEqual(selected.data, collection);
        return Response.json(await catalogItems({ userId: owner.id, collection: selected.data,
          start: Number(params.get("start")), size: Number(params.get("size")) }));
      });
      assert.deepEqual(queue.map((item) => item.id), view.items.map((item) => item.id));
      const opus = await catalogItems({ userId: owner.id, collection: { kind: "library", filters: { codec: "OPUS" } } });
      assert.deepEqual(opus.items.map((item) => item.id), [b.id], "existing-library codec participates in filtering");
      const albums = await catalogItems({ userId: owner.id, type: "album", collection: { kind: "library", filters: { minYear: 2000, maxYear: 2005 } } });
      assert.equal(albums.items.length, 1); assert.equal(albums.items[0]?.title, "Record one");
      const escaped = await catalogItems({ userId: owner.id, collection: { kind: "library", filters: { artist: "%" } } });
      assert.equal(escaped.total, 0, "metadata text is literal rather than wildcard SQL");
      await assert.rejects(catalogItems({ userId: owner.id, collection: { kind: "library", filters: { minYear: 2010, maxYear: 2000 } } }), /reversed/);
    });

    await suite.test("owner invitations, accepted editors and strangers are isolated", async () => {
      const playlist = await create(owner.id, { title: "Shared", trackIds: [a.id] });
      await assert.rejects(collectionDetail(db, stranger.id, playlist.id), status(404));
      await mutation(owner.id, playlist.id, { action: "invite", revision: 1, email: editor.email.toUpperCase() });
      assert.equal((await listCollections(db, editor.id)).invitations[0]?.id, playlist.id);
      await assert.rejects(collectionDetail(db, editor.id, playlist.id), status(404));
      await respondInvitation(db, editor.id, playlist.id, true);
      assert.equal((await collectionDetail(db, editor.id, playlist.id)).role, "editor");
      await mutation(editor.id, playlist.id, { action: "append", revision: 2, trackIds: [b.id, b.id] });
      await assert.rejects(mutation(editor.id, playlist.id, { action: "delete", revision: 3 }), status(403));
      await assert.rejects(mutation(stranger.id, playlist.id, { action: "append", revision: 3, trackIds: [c.id] }), status(404));
      await mutation(owner.id, playlist.id, { action: "revoke", revision: 3, userId: editor.id });
      await assert.rejects(collectionDetail(db, editor.id, playlist.id), status(404));
      assert.equal((await collectionDetail(db, owner.id, playlist.id)).entries.length, 3);
    });

    await suite.test("playlist song search reaches later pages with stable ties and repeat additions", async () => {
      const fixtureTracks = await db.insert(schema.tracks).values(Array.from({ length: 205 }, () => ({
        title: "Playlist paging song", artist: "Playlist paging fixture", album: "Literal %_\\ album",
        stage: "ready" as const, filePath: "/fixture/paging.flac",
      }))).returning();
      try {
        const first = await playlistLibrarySearch(db, "Playlist paging fixture");
        const second = await playlistLibrarySearch(db, "Playlist paging fixture", first.nextPage!);
        const last = await playlistLibrarySearch(db, "Playlist paging fixture", second.nextPage!);
        assert.deepEqual([first.tracks.length, second.tracks.length, last.tracks.length], [100, 100, 5]);
        assert.equal(last.nextPage, null);
        const ids = [...first.tracks, ...second.tracks, ...last.tracks].map((track) => track.id);
        assert.deepEqual(ids, fixtureTracks.map((track) => track.id).sort(), "UUID tie-breaking preserves every matching song exactly once");
        assert.deepEqual((await playlistLibrarySearch(db, "Playlist paging fixture")).tracks.map((track) => track.id),
          first.tracks.map((track) => track.id), "Previous returns the same first page");
        assert.equal((await playlistLibrarySearch(db, "%_\\", 2)).tracks.length, 5, "special characters remain literal");
        assert.equal((await playlistLibrarySearch(db, "No such fixture")).tracks.length, 0);
        assert.equal((await playlistLibrarySearch(db, "Pending")).tracks.length, 0, "unplayable songs stay excluded");
        assert.equal((await playlistLibrarySearch(db, "", 2)).tracks.length, 8, "clearing search browses the shared playable library");
        for (const page of [-1, 0.5, 10001, NaN]) await assert.rejects(playlistLibrarySearch(db, "", page));
        await assert.rejects(playlistLibrarySearch(db, "x".repeat(101)));
        const selected = last.tracks[0]!.id;
        const playlist = await create(owner.id, { title: "Later-page picks" });
        await mutation(owner.id, playlist.id, { action: "append", revision: 1, trackIds: [selected, selected] });
        const detail = await collectionDetail(db, owner.id, playlist.id);
        assert.deepEqual(detail.entries.map((entry) => entry.track.id), [selected, selected]);
        assert.equal(new Set(detail.entries.map((entry) => entry.entryId)).size, 2);
        await assert.rejects(collectionDetail(db, stranger.id, playlist.id), status(404));
        await mutation(owner.id, playlist.id, { action: "delete", revision: 2 });
      } finally {
        await db.delete(schema.tracks).where(inArray(schema.tracks.id, fixtureTracks.map((track) => track.id)));
      }
    });

    await suite.test("simultaneous editors cannot silently overwrite a revision", async () => {
      const playlist = await create(owner.id, { title: "Racing", trackIds: [a.id] });
      const results = await Promise.allSettled([
        mutation(owner.id, playlist.id, { action: "update", revision: 1, title: "First writer" }),
        mutation(owner.id, playlist.id, { action: "append", revision: 1, trackIds: [b.id] }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = results.find((r) => r.status === "rejected");
      assert.ok(rejected?.status === "rejected" && rejected.reason instanceof MusicError && rejected.reason.status === 409);
      assert.equal((await collectionDetail(db, owner.id, playlist.id)).revision, 2);
      await assert.rejects(mutation(owner.id, playlist.id, { action: "append", revision: 2, trackIds: [randomUUID()] }), status(400));
      assert.equal((await collectionDetail(db, owner.id, playlist.id)).revision, 2, "failed writes must roll back revision");
    });

    await suite.test("YouTube imports can be copied without mutation and native likes stay separate", async () => {
      const [source] = await db.insert(schema.playlists).values({ userId: owner.id, youtubePlaylistId: "source_fixture", title: "Source managed" }).returning();
      assert.ok(source);
      await db.insert(schema.playlistTracks).values([{ playlistId: source.id, trackId: b.id, position: 0 }, { playlistId: source.id, trackId: a.id, position: 1 }]);
      const copy = await create(owner.id, { title: "Native copy", sourcePlaylistId: source.id });
      assert.deepEqual((await collectionDetail(db, owner.id, copy.id)).entries.map((e) => e.track.id), [b.id, a.id]);
      await assert.rejects(create(stranger.id, { title: "Stolen", sourcePlaylistId: source.id }), status(404));
      await mutation(owner.id, copy.id, { action: "remove", revision: 1, entryId: (await collectionDetail(db, owner.id, copy.id)).entries[0]!.entryId });
      assert.equal((await db.select().from(schema.playlistTracks).where(eq(schema.playlistTracks.playlistId, source.id))).length, 2);
      await db.insert(schema.userTracks).values({ userId: owner.id, trackId: a.id });
      await db.insert(musicLikes).values({ userId: owner.id, trackId: b.id });
      assert.deepEqual((await musicProfile(db, owner.id)).likes, [b.id]);
      assert.equal((await musicProfile(db, stranger.id)).likes.length, 0);
      assert.equal((await db.select().from(schema.userTracks).where(eq(schema.userTracks.userId, owner.id))).length, 1);
      assert.deepEqual((await importedLikeCandidates(db, owner.id)).tracks.map((track) => track.id), [a.id]);
      assert.equal((await importedLikeCandidates(db, stranger.id)).tracks.length, 0);
      await importLikedSongs([a.id], async <T>(path: string, method = "GET"): Promise<T> => {
        assert.equal(method, "PUT");
        await db.insert(musicLikes).values({ userId: owner.id, trackId: path.split("/")[1]! }).onConflictDoNothing();
        return {} as T;
      });
      assert.equal((await importedLikeCandidates(db, owner.id)).tracks.length, 0, "native likes are not offered again");
      await db.delete(musicLikes).where(and(eq(musicLikes.userId, owner.id), eq(musicLikes.trackId, a.id)));
      await db.insert(schema.userTracks).values({ userId: owner.id, trackId: a.id })
        .onConflictDoUpdate({ target: [schema.userTracks.userId, schema.userTracks.trackId], set: { origin: "youtube" } });
      assert.deepEqual((await musicProfile(db, owner.id)).likes, [b.id], "continuous source sync cannot restore a native unlike");
      assert.deepEqual((await importedLikeCandidates(db, owner.id)).tracks.map((track) => track.id), [a.id], "the preserved source remains explicitly convertible");
      await db.insert(schema.userTracks).values({ userId: owner.id, trackId: pending.id, origin: "request" });
      assert.deepEqual((await importedLikeCandidates(db, owner.id)).tracks.map((track) => track.id), [a.id], "requested songs are not presented as legacy favorites");
      await db.delete(schema.userTracks).where(and(eq(schema.userTracks.userId, owner.id), eq(schema.userTracks.trackId, pending.id)));
    });

    await suite.test("smart rules query actual library fields and the owner's private profile", async () => {
      const rules = smartRulesSchema.parse({ artist: "Originals", minYear: 2000, maxYear: 2005, liked: true });
      assert.deepEqual((await smartTracks(db, owner.id, rules)).map((r) => r.id), [b.id]);
      assert.equal((await smartTracks(db, stranger.id, rules)).length, 0);
      assert.deepEqual((await smartTracks(db, owner.id, smartRulesSchema.parse({ codec: "FLAC", minYear: 2000, maxYear: 2005 }))).map((r) => r.id), [a.id]);
      assert.equal((await smartTracks(db, owner.id, smartRulesSchema.parse({ artist: "Originals" }))).some((r) => r.id === pending.id), false);
      const smart = await create(owner.id, { title: "Smart", rules });
      await assert.rejects(mutation(owner.id, smart.id, { action: "append", revision: 1, trackIds: [c.id] }), status(400));
      const copy = await create(owner.id, { title: "Smart snapshot", sourceCollectionId: smart.id });
      assert.equal(copy.rules, null);
      assert.deepEqual((await collectionDetail(db, owner.id, copy.id)).entries.map((e) => e.track.id), [b.id]);
    });

    await suite.test("imported favorites page without writes, preserve ties and stay account scoped", async () => {
      const [member] = await db.insert(schema.users).values({
        email: "paging@music.example", name: "Paging", status: "active", passwordHash: "fixture-not-a-password",
      }).returning();
      assert.ok(member);
      const fixtureTracks = await db.insert(schema.tracks).values(Array.from({ length: 102 }, (_, index) => ({
        title: `Paging ${index}`, artist: "Pagination fixture", stage: "queued" as const,
      }))).returning();
      await db.insert(schema.userTracks).values(fixtureTracks.map((track) => ({
        userId: member.id, trackId: track.id, likedAt: new Date("2026-01-01T00:00:00.000Z"), origin: "youtube",
      })));
      const first = await importedLikeCandidates(db, member.id);
      assert.equal(first.tracks.length, 100);
      assert.ok(first.nextCursor);
      const next = await importedLikeCandidates(db, member.id, first.nextCursor);
      assert.equal(next.tracks.length, 2);
      assert.equal(next.nextCursor, null);
      assert.equal(new Set([...first.tracks, ...next.tracks].map((track) => track.id)).size, 102, "timestamp ties cannot skip or repeat songs");
      assert.deepEqual((await importedLikeCandidates(db, member.id)).tracks.map((track) => track.id), first.tracks.map((track) => track.id), "back navigation is stable without importing");
      assert.equal((await musicProfile(db, member.id)).likes.length, 0, "pagination never creates native likes");
      assert.equal((await importedLikeCandidates(db, stranger.id, first.nextCursor)).tracks.length, 0, "a cursor cannot expose another account's favorites");
      await db.insert(musicLikes).values({ userId: member.id, trackId: first.tracks[0]!.id });
      assert.deepEqual((await importedLikeCandidates(db, member.id, first.nextCursor)).tracks.map((track) => track.id), next.tracks.map((track) => track.id), "copying earlier songs does not move later page boundaries");
    });

    await suite.test("folders and pins are per-user and refuse cross-user folders", async () => {
      const playlist = await create(owner.id, { title: "Organized" });
      const [ownFolder, otherFolder] = await db.insert(musicFolders).values([{ userId: owner.id, title: "Mine" }, { userId: stranger.id, title: "Other" }]).returning();
      assert.ok(ownFolder && otherFolder);
      await assert.rejects(organizeCollection(db, owner.id, playlist.id, { folderId: otherFolder.id, pinned: true }), status(404));
      await organizeCollection(db, owner.id, playlist.id, { folderId: ownFolder.id, pinned: true });
      const row = (await listCollections(db, owner.id)).collections.find((r) => r.id === playlist.id);
      assert.equal(row?.folderId, ownFolder.id); assert.equal(row.pinned, true);
      assert.equal((await listCollections(db, stranger.id)).collections.some((r) => r.id === playlist.id), false);
      await db.delete(musicFolders).where(eq(musicFolders.id, ownFolder.id));
      assert.equal((await listCollections(db, owner.id)).collections.find((r) => r.id === playlist.id)?.folderId, null);
    });

    await suite.test("history is idempotent, clamped, private, per-user and deletable", async () => {
      const event = { eventId: randomUUID(), trackId: a.id, listenedMs: 120_000, completed: true };
      assert.equal((await recordHistory(db, owner.id, event)).recorded, true);
      assert.equal((await recordHistory(db, owner.id, event)).recorded, false);
      const [stored] = await db.select().from(musicHistory).where(eq(musicHistory.id, event.eventId));
      assert.equal(stored?.listenedMs, 90_000); assert.equal(stored.completed, true);
      assert.equal((await db.select().from(musicHistory).where(eq(musicHistory.userId, stranger.id))).length, 0);
      await setPrivateSession(db, owner.id, true);
      assert.equal((await recordHistory(db, owner.id, { ...event, eventId: randomUUID() })).recorded, false);
      await setPrivateSession(db, owner.id, false);
      assert.equal((await recordHistory(db, owner.id, { ...event, eventId: randomUUID(), listenedMs: 10, completed: false })).recorded, false);
      const partialId = randomUUID();
      assert.equal((await recordHistory(db, owner.id, { ...event, eventId: randomUUID(), startedAt: new Date(Date.now() - 60_000).toISOString() })).recorded, false, "cross-tab old episodes must not reveal private listening");
      assert.equal((await recordHistory(db, owner.id, { ...event, eventId: randomUUID() })).recorded, false, "old clients without episode start remain private after a privacy boundary");
      await recordHistory(db, owner.id, { ...event, eventId: partialId, listenedMs: 5000, startedAt: new Date().toISOString() });
      assert.equal((await db.select().from(musicHistory).where(eq(musicHistory.id, partialId)))[0]?.completed, false);
      await deleteHistory(db, stranger.id, event.eventId);
      assert.equal((await db.select().from(musicHistory).where(eq(musicHistory.id, event.eventId))).length, 1);
      await deleteHistory(db, owner.id, event.eventId);
      assert.equal((await db.select().from(musicHistory).where(eq(musicHistory.id, event.eventId))).length, 0);
      assert.equal((await recordHistory(db, owner.id, { ...event, startedAt: new Date(Date.now() - 60_000).toISOString() })).recorded, false, "queued retry cannot restore a deleted play");
    });

    await suite.test("discovery is playable library-only, explains metadata honestly and respects exclusions", async () => {
      const radio = await discoverMusic(db, owner.id, "radio", [a.id]);
      assert.equal(radio.items[0]?.track.id, b.id);
      assert.match(radio.items[0]?.reason ?? "", /album|Originals/);
      assert.equal(radio.items.some((r) => r.track.id === pending.id || r.track.id === a.id), false);
      const count = (await db.select({ count: sql<number>`count(*)::int` }).from(schema.tracks))[0]!.count;
      await db.insert(musicExclusions).values({ userId: owner.id, trackId: b.id });
      assert.equal((await discoverMusic(db, owner.id, "for-you")).items.some((r) => r.track.id === b.id), false);
      const emptySonic = await discoverMusic(db, owner.id, "sonic", [a.id]);
      assert.equal(emptySonic.items.length, 0); assert.match(emptySonic.explanation, /measured|measures|Sonic/);
      await db.update(musicHistory).set({ createdAt: new Date(Date.now() - 10 * 86400_000) }).where(eq(musicHistory.userId, owner.id));
      const rediscover = await discoverMusic(db, owner.id, "rediscover");
      assert.equal(rediscover.items[0]?.track.id, a.id); assert.match(rediscover.items[0]?.reason ?? "", /Last played/);
      assert.equal((await db.select({ count: sql<number>`count(*)::int` }).from(schema.tracks))[0]!.count, count, "discovery must never acquire or invent tracks");
    });

    await suite.test("deleting native collections cascades entries but never removes library files", async () => {
      const playlist = await create(owner.id, { title: "Delete me", trackIds: [a.id, a.id] });
      await mutation(owner.id, playlist.id, { action: "delete", revision: 1 });
      assert.equal((await db.select().from(musicEntries).where(eq(musicEntries.collectionId, playlist.id))).length, 0);
      assert.equal((await db.select().from(musicCollections).where(eq(musicCollections.id, playlist.id))).length, 0);
      assert.equal((await db.select().from(schema.tracks).where(eq(schema.tracks.id, a.id))).length, 1);
    });
  } finally {
    globalDb.__mintDb = previous;
    await pool.end();
    await admin.query(`drop schema "${namespace}" cascade`);
    await admin.end();
  }
});
