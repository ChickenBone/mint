import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { playbackQueues, playbackQueueEntries } from "@mint/core/playback-queues-db";
import { musicLikes } from "@mint/core/music-db";
import { openQueue, queuePage, editQueue } from "../src/lib/playback-queue-store";
import { catalogItems } from "../src/lib/player-catalog";
import { collectionFromParams, loadCollection } from "../src/lib/browser-catalog";
import { searchTerms } from "../src/lib/catalog-search";
import config from "../next.config";

test("native media is allowed on the initial document before client-side sign-in/navigation", async () => {
  const headers = await config.headers!();
  const policies = headers.flatMap((rule) => rule.headers.filter((header) => header.key === "Content-Security-Policy").map((header) => header.value));
  assert.ok(policies.length); assert.ok(policies.every((policy) => policy.includes("media-src 'self' blob:") && !policy.includes("media-src 'none'")));
  assert.deepEqual(searchTerms("Beyoncé — HALO (live)"), ["beyonce", "halo", "live"]);
});

const url = process.env.MUSIC_TEST_DATABASE_URL;
test("native liked catalog is member-scoped, playable, paginated and distinct from YouTube likes", { skip: !url && "Set MUSIC_TEST_DATABASE_URL for PostgreSQL integration tests" }, async () => {
  const namespace = `likes_${randomUUID().replaceAll("-", "")}`, admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema "${namespace}"`);
  const pool = new pg.Pool({ connectionString: url, max: 3, options: `-c search_path=${namespace},public` }), db = drizzle(pool, { schema });
  const globalDb = globalThis as unknown as { __mintDb?: { db: typeof db; pool: pg.Pool } }, previous = globalDb.__mintDb;
  globalDb.__mintDb = { db, pool };
  try {
    for (const migration of ["0000_init", "0001_workers", "0002_drop_previews", "0003_track_artwork_url", "0004_existing_library", "0005_analysis", "0006_music", "0009_playback_scale"]) {
      const source = await readFile(new URL(`../../../packages/core/migrations/${migration}.sql`, import.meta.url), "utf8");
      for (const statement of source.replaceAll('"public".', `"${namespace}".`).split("--> statement-breakpoint")) if (statement.trim()) await pool.query(statement);
    }
    const [owner, stranger] = await db.insert(schema.users).values(["owner", "stranger"].map((name) => ({
      email: `${name}@likes.test`, name, status: "active" as const, passwordHash: "fixture",
    }))).returning();
    const songs = await db.insert(schema.tracks).values([
      { title: "Native one", artist: "Fixture", stage: "ready", filePath: "/fixture/one.flac" },
      { title: "Native two", artist: "Fixture", stage: "ready", filePath: "/fixture/two.flac" },
      { title: "Unavailable", artist: "Fixture", stage: "queued" },
      { title: "Other account", artist: "Fixture", stage: "ready", filePath: "/fixture/other.flac" },
      { title: "YouTube", artist: "Fixture", stage: "ready", filePath: "/fixture/youtube.flac" },
    ]).returning();
    await db.insert(musicLikes).values([
      ...songs.slice(0, 3).map((song) => ({ userId: owner!.id, trackId: song.id })),
      { userId: stranger!.id, trackId: songs[3]!.id },
    ]);
    await db.insert(schema.userTracks).values({ userId: owner!.id, trackId: songs[4]!.id, origin: "youtube" });
    const collection = { kind: "native-liked" as const, id: "" };
    const first = await catalogItems({ userId: owner!.id, collection, size: 1 });
    const second = await catalogItems({ userId: owner!.id, collection, start: 1, size: 1 });
    assert.equal(first.total, 2); assert.equal(second.total, 2);
    assert.deepEqual(new Set([...first.items, ...second.items].map((item) => item.id)), new Set(songs.slice(0, 2).map((song) => song.id)));
    assert.deepEqual((await catalogItems({ userId: owner!.id, collection: { kind: "native-liked", id: songs[1]!.id } })).items.map((item) => item.id), [songs[1]!.id]);
    assert.equal((await catalogItems({ userId: owner!.id, collection: { kind: "native-liked", id: songs[3]!.id } })).total, 0);
    assert.equal((await catalogItems({ userId: stranger!.id, collection: { kind: "native-liked", id: songs[1]!.id } })).total, 0);
    assert.deepEqual((await catalogItems({ userId: owner!.id, collection: { kind: "liked" } })).items.map((item) => item.id), [songs[4]!.id]);
    const fetcher: typeof fetch = async (input) => {
      const params = new URL(String(input), "http://localhost").searchParams;
      const parsed = collectionFromParams(params);
      assert.ok(parsed.success);
      return Response.json(await catalogItems({ userId: owner!.id, collection: parsed.data, start: Number(params.get("start")), size: 1 }));
    };
    assert.deepEqual(new Set((await loadCollection(collection, new AbortController().signal, fetcher)).map((item) => item.id)),
      new Set(songs.slice(0, 2).map((song) => song.id)));
    assert.deepEqual((await loadCollection({ kind: "native-liked", id: songs[1]!.id }, new AbortController().signal, fetcher)).map((item) => item.id), [songs[1]!.id]);
    const queue = await openQueue(owner!.id, { collection, shuffle: false });
    assert.deepEqual(new Set(queue.items.map((item) => item.id)), new Set(songs.slice(0, 2).map((song) => song.id)));
  } finally { globalDb.__mintDb = previous; await pool.end(); await admin.query(`drop schema "${namespace}" cascade`); await admin.end(); }
});

test("100,123-track snapshots hydrate only a bounded window, preserve exact membership and reject conflicting edits", { skip: !url && "Set MUSIC_TEST_DATABASE_URL for PostgreSQL scale tests" }, async (suite) => {
  const namespace = `scale_${randomUUID().replaceAll("-", "")}`, admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema "${namespace}"`);
  const pool = new pg.Pool({ connectionString: url, max: 3, options: `-c search_path=${namespace},public` }), db = drizzle(pool, { schema });
  const globalDb = globalThis as unknown as { __mintDb?: { db: typeof db; pool: pg.Pool } }, previous = globalDb.__mintDb;
  globalDb.__mintDb = { db, pool };
  try {
    for (const migration of ["0000_init", "0001_workers", "0002_drop_previews", "0003_track_artwork_url", "0004_existing_library", "0005_analysis", "0006_music", "0009_playback_scale"]) {
      const source = await readFile(new URL(`../../../packages/core/migrations/${migration}.sql`, import.meta.url), "utf8");
      for (const statement of source.replaceAll('"public".', `"${namespace}".`).split("--> statement-breakpoint")) if (statement.trim()) await pool.query(statement);
    }
    const [owner, stranger] = await db.insert(schema.users).values(["owner", "stranger"].map((name) => ({ email: `${name}@scale.test`, name, status: "active" as const, passwordHash: "fixture" }))).returning();
    await pool.query("insert into tracks(title,artist,album,stage,file_path) select 'Backlog song '||lpad(i::text,6,'0'),'Scale Artist','Backlog','ready','/fixture/song.flac' from generate_series(1,100123) i");
    const started = performance.now(), opened = await openQueue(owner!.id, { collection: { kind: "library" }, shuffle: true });
    const elapsed = Math.round(performance.now() - started);
    assert.equal(opened.context.total, 100_123); assert.equal(opened.items.length, 100);
    assert.ok(JSON.stringify(opened).length < 100_000, "first playback response stays under 100 kB");
    assert.ok(elapsed < 8000, `opening 100k-song shuffled snapshot took ${elapsed}ms`);
    const counts = await db.execute(sql`select count(*)::int as total,count(distinct track_id)::int as distinct_tracks,count(distinct position)::int as positions
      from playback_queue_entries where queue_id=${opened.context.id}::uuid`);
    assert.deepEqual(counts.rows[0], { total: 100_123, distinct_tracks: 100_123, positions: 100_123 });
    console.log(JSON.stringify({ scaleTracks: opened.context.total, initialMetadataItems: opened.items.length, responseBytes: JSON.stringify(opened).length, openMs: elapsed }));
    await suite.test("late windows and library additions cannot inflate or repeat a frozen collection", async () => {
      const tail = await queuePage(db, owner!.id, opened.context.id, 100_122);
      assert.equal(tail.context.total, 100_123); assert.equal(tail.items.length, 21);
      assert.equal(tail.context.offset, 100_102);
      await db.insert(schema.tracks).values({ title: "Added later", artist: "Scale Artist", stage: "ready", filePath: "/fixture/later.flac" });
      assert.equal((await queuePage(db, owner!.id, opened.context.id, 50000)).context.total, 100_123);
      await assert.rejects(queuePage(db, stranger!.id, opened.context.id, 0), /another account/);
    });
    await suite.test("queue edits are duplicate-safe and revision guarded", async () => {
      const current = opened.items[0]!, removed = opened.items[1]!;
      const edited = await editQueue(owner!.id, opened.context.id, opened.context.revision, current.queueId!, { action: "remove", entryId: removed.queueId! });
      assert.equal(edited.context.total, 100_122); assert.equal(edited.items[0]!.queueId, current.queueId);
      await assert.rejects(editQueue(owner!.id, opened.context.id, 1, current.queueId!, { action: "clear" }), /another device/);
      const appended = await editQueue(owner!.id, opened.context.id, edited.context.revision, current.queueId!, { action: "append", trackIds: [current.id, current.id], next: true });
      assert.equal(appended.context.total, 100_124);
      assert.deepEqual(appended.items.slice(0, 3).map((item) => item.id), [current.id, current.id, current.id]);
      assert.equal(new Set(appended.items.slice(0, 3).map((item) => item.queueId)).size, 3);
    });
    await suite.test("search accepts reordered title/artist tokens, prefixes, accents and misspellings", async () => {
      const [song] = await db.insert(schema.tracks).values({ title: "Bad Romance", artist: "Lady Gaga", album: "The Fame Monster", stage: "ready", filePath: "/fixture/gaga.flac" }).returning();
      const [accent] = await db.insert(schema.tracks).values({ title: "Halo", artist: "Beyoncé", stage: "ready", filePath: "/fixture/halo.flac" }).returning();
      for (const q of ["gaga bad", "romance lady", "bad rom", "gaga bad romnce"]) {
        const page = await catalogItems({ userId: owner!.id, q, type: "track" }); assert.equal(page.items[0]?.id, song!.id, q);
        const queue = await openQueue(owner!.id, { collection: { kind: "library", query: q }, shuffle: true });
        assert.equal(queue.context.total, page.total, "search queue membership matches displayed results");
      }
      assert.equal((await catalogItems({ userId: owner!.id, q: "beyonce halo" })).items[0]?.id, accent!.id);
      assert.equal((await catalogItems({ userId: owner!.id, q: "!!!" })).total, 0);
      const selected = await openQueue(owner!.id, { collection: { kind: "library", query: "beyonce halo" }, shuffle: false });
      const appended = await editQueue(owner!.id, selected.context.id, selected.context.revision, selected.items[0]!.queueId!,
        { action: "append-collection", collection: { kind: "library" }, next: true });
      assert.equal(appended.context.total, 100127);
      assert.equal(appended.items.length, 100);
      assert.equal(appended.items[0]?.id, accent!.id);
      const distinctPositions = await db.execute(sql`select count(distinct position)::int as n from playback_queue_entries where queue_id=${selected.context.id}::uuid`);
      assert.equal(distinctPositions.rows[0]?.n, appended.context.total);
    });
    await db.update(playbackQueues).set({ expiresAt: new Date(0) }).where(eq(playbackQueues.id, opened.context.id));
    await assert.rejects(queuePage(db, owner!.id, opened.context.id, 0), /expired/);
    assert.ok((await db.select().from(playbackQueueEntries).limit(1)).length);
  } finally { globalDb.__mintDb = previous; await pool.end(); await admin.query(`drop schema "${namespace}" cascade`); await admin.end(); }
});
