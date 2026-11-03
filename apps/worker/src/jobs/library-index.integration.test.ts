import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

test("20,000-song Plex import, idempotence, reuse, upgrades and read-only boundaries", {
  skip: !process.env.MINT_LIBRARY_TEST_DATABASE_URL,
  timeout: 120_000,
}, async (t) => {
  const url = process.env.MINT_LIBRARY_TEST_DATABASE_URL!;
  assert.match(new URL(url).pathname, /^\/mint_library_test/);
  assert.ok(process.env.MINT_LIBRARY_TEST_REDIS_URL);
  const root = await mkdtemp(path.join(os.tmpdir(), "mint-library-test-"));
  await writeFile(path.join(root, "fixture.audio"), Buffer.alloc(128));
  Object.assign(process.env, {
    DATABASE_URL: url,
    REDIS_URL: process.env.MINT_LIBRARY_TEST_REDIS_URL,
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PLEX_URL: "http://plex.test",
    PLEX_TOKEN: "fixture-only",
    PLEX_MUSIC_SECTION_ID: "1",
    PLEX_READ_ONLY: "true",
    INDEX_EXISTING_LIBRARY: "true",
    EXISTING_PLEX_MUSIC_DIR: "/plex-library",
    EXISTING_MUSIC_DIR: root,
    MUSIC_DIR: path.join(root, "music"),
    STAGING_DIR: path.join(root, "staging"),
  });
  const { getDb, closeDb, schema } = await import("@mint/core/db");
  const { runMigrations } = await import("@mint/core/db/migrate");
  const { getRedis } = await import("@mint/core/redis");
  const { encrypt } = await import("@mint/core/crypto");
  const { computeStats, toTrackView } = await import("@mint/core");
  const { eq, sql } = await import("drizzle-orm");
  const { indexLibrary } = await import("../library-index");
  const { keepExisting, requestExistingUpgrade, reusePendingTrack } = await import("../existing-track");
  const { queues, connection } = await import("../queues");
  const { processSync } = await import("./sync");
  const plex = await import("../services/plex");
  const db = getDb();
  const redis = getRedis();
  const originalFetch = globalThis.fetch;
  const offsets: number[] = [];
  const fixture = (i: number) => ({
    ratingKey: String(i + 1),
    title: `Song ${String(i).padStart(5, "0")}`,
    grandparentTitle: "Fixture Artist",
    parentTitle: "Fixture Album",
    duration: 200_000,
    musicAnalysisVersion: "1",
    Media: [{ audioCodec: i === 0 ? "mp3" : "flac", Part: [{ id: i, file: "/plex-library/fixture.audio", size: 128 }] }],
  });
  const video = (id: string, i: number, duration = "PT3M20S") => ({
    id,
    snippet: { title: fixture(i).title, channelTitle: "Fixture Artist - Topic", description: "", categoryId: "10" },
    contentDetails: { duration },
  });
  const videos = [video("fixture0001", 1), video("fixture0002", 1), video("fixture0003", 0), video("fixture0004", 2, "PT4M")];
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    assert.equal(init?.method ?? "GET", "GET", "read-only integrations must not issue writes");
    if (u.hostname === "plex.test") {
      assert.equal(new Headers(init?.headers).get("x-plex-token"), "fixture-only");
      if (u.pathname === "/identity") return Response.json({ MediaContainer: { machineIdentifier: "fixture-server" } });
      assert.equal(u.pathname, "/library/sections/1/all");
      assert.equal(u.searchParams.get("type"), "10");
      const headers = new Headers(init?.headers);
      const start = Number(headers.get("X-Plex-Container-Start"));
      const size = Number(headers.get("X-Plex-Container-Size"));
      assert.equal(size, 200);
      offsets.push(start);
      return Response.json({ MediaContainer: { totalSize: 20_000, Metadata: Array.from({ length: Math.min(size, 20_000 - start) }, (_, i) => fixture(start + i)) } });
    }
    assert.equal(u.hostname, "www.googleapis.com", "unexpected external request");
    if (u.pathname.endsWith("/videos")) return Response.json({ items: videos });
    assert.ok(u.pathname.endsWith("/playlists"));
    return Response.json({ items: [] });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await Promise.all(Object.values(queues).map((queue) => queue.close()));
    await connection.quit();
    await redis.quit();
    await closeDb();
    await rm(root, { recursive: true });
  });

  await runMigrations(path.resolve("../../packages/core/migrations"));
  await runMigrations(path.resolve("../../packages/core/migrations"));
  assert.equal(await db.$count(schema.tracks), 0, "requires an empty dedicated test database");
  await indexLibrary();
  assert.deepEqual(offsets, Array.from({ length: 100 }, (_, i) => i * 200));
  assert.equal(await db.$count(schema.tracks), 20_000);
  assert.equal(JSON.parse((await redis.get("mint:library-index"))!).indexed, 20_000);
  const tracks = await db.select().from(schema.tracks).where(sql`existing_library_key in ('fixture-server:1:1', 'fixture-server:1:2')`);
  const lossy = tracks.find((track) => track.existingCodec === "mp3")!;
  const lossless = tracks.find((track) => track.existingCodec === "flac")!;
  assert.equal(toTrackView(lossless).youtubeVideoId, null);
  assert.equal(toTrackView(lossless).artworkUrl, "");
  assert.equal((await computeStats(db)).existingTracks, 20_000);

  // A rescan refreshes originals but must not undo a separately saved upgrade.
  await db.update(schema.tracks).set({ filePath: "/music/upgrades/saved.flac", codec: "flac", source: "lidarr" }).where(eq(schema.tracks.id, lossy.id));
  await indexLibrary();
  assert.equal(await db.$count(schema.tracks), 20_000);
  const upgraded = (await db.select().from(schema.tracks).where(eq(schema.tracks.id, lossy.id)))[0]!;
  assert.equal(upgraded.filePath, "/music/upgrades/saved.flac");
  assert.equal(upgraded.codec, "flac");
  await keepExisting({ ...upgraded, durationSec: 999, sonicAnalyzed: false }, "fixture rejected");
  const restored = (await db.select().from(schema.tracks).where(eq(schema.tracks.id, lossy.id)))[0]!;
  assert.equal(restored.filePath, path.join(root, "fixture.audio"));
  assert.equal(restored.codec, "mp3");
  assert.equal(restored.durationSec, 200);
  assert.equal(restored.sonicAnalyzed, true);
  assert.equal(restored.bytes, 128);
  assert.equal(restored.source, null);
  const failedQueue = t.mock.method(queues.acquire, "add", async () => { throw new Error("fixture Redis failure"); });
  await assert.rejects(requestExistingUpgrade(restored, "fixture0003"), /fixture Redis failure/);
  failedQueue.mock.restore();
  const [afterQueueFailure] = await db.select().from(schema.tracks).where(eq(schema.tracks.id, lossy.id));
  assert.equal(afterQueueFailure!.upgradeAttempted, false);
  assert.equal(afterQueueFailure!.stage, "ready");

  const [user] = await db.insert(schema.users).values({ email: "fixture@example.test", name: "Fixture", passwordHash: "unused-fixture", status: "active" }).returning();
  const [playlist] = await db.insert(schema.playlists).values({ userId: user!.id, youtubePlaylistId: "fixture", title: "Fixture" }).returning();
  const [pending] = await db.insert(schema.tracks).values({ youtubeVideoId: "pending0001", title: lossless.title, artist: lossless.artist, durationSec: 200 }).returning();
  await db.insert(schema.userTracks).values({ userId: user!.id, trackId: pending!.id });
  await db.insert(schema.playlistTracks).values({ playlistId: playlist!.id, trackId: pending!.id, position: 7 });
  assert.equal(await reusePendingTrack(pending!), lossless.id);
  assert.equal(await db.$count(schema.tracks, eq(schema.tracks.id, pending!.id)), 0);
  assert.equal((await db.select().from(schema.userTracks))[0]!.trackId, lossless.id);
  assert.equal((await db.select().from(schema.playlistTracks))[0]!.position, 7);
  assert.equal((await db.select().from(schema.playlistTracks))[0]!.trackId, lossless.id);
  await requestExistingUpgrade(lossless, "unusedlossless");
  assert.equal(await queues.acquire.count(), 0);

  await db.insert(schema.youtubeAccounts).values({
    userId: user!.id,
    googleSub: "fixture-sub",
    accessTokenEnc: encrypt("fixture-access"),
    refreshTokenEnc: encrypt("fixture-refresh"),
    expiresAt: new Date(Date.now() + 3_600_000),
    scope: "fixture",
  });
  const sync = await queues.sync.add("fixture", { userId: user!.id, reason: "manual" });
  await redis.set("mint:library-index", JSON.stringify({ state: "indexing" }));
  await assert.rejects(processSync(sync), /must finish indexing/);
  await redis.set("mint:library-index", JSON.stringify({ state: "ready" }));
  await processSync(sync);
  await processSync(sync);
  assert.equal(await db.$count(schema.tracks), 20_001, "aliases reuse originals; ambiguous edition is held");
  assert.equal(await db.$count(schema.userTracks, eq(schema.userTracks.userId, user!.id)), 3);
  assert.equal(await queues.acquire.count(), 1, "only one lossy-original upgrade is queued");
  const [held] = await db.select().from(schema.tracks).where(eq(schema.tracks.youtubeVideoId, "fixture0004"));
  assert.equal(held!.stage, "failed");
  assert.match(held!.error!, /ambiguous/);
  const [alias1] = await db.select().from(schema.trackVideos).where(eq(schema.trackVideos.videoId, "fixture0001"));
  const [alias2] = await db.select().from(schema.trackVideos).where(eq(schema.trackVideos.videoId, "fixture0002"));
  assert.equal(alias1!.trackId, alias2!.trackId);

  const beforeWrites = offsets.length;
  for (const write of [
    () => plex.refreshPath("/music"),
    () => plex.analyze("1"),
    () => plex.createMusicSection("/music"),
    () => plex.syncPlaylist("Fixture", ["1"]),
  ]) await assert.rejects(write, /read-only/);
  assert.equal(offsets.length, beforeWrites, "writes are refused before a network request");

  if (process.env.MINT_AUDIO_TEST === "true") {
    const run = promisify(execFile);
    await mkdir(path.join(root, "staging"));
    const original = path.join(root, "original.mp3");
    const candidate = path.join(root, "candidate.flac");
    const cover = path.join(root, "cover.png");
    for (const [file, codec] of [[original, "libmp3lame"], [candidate, "flac"]] as const) {
      await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-c:a", codec, file]);
    }
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=100x100", "-frames:v", "1", cover]);
    const bytes = await readFile(original);
    await chmod(original, 0o444);
    const server = createServer(async (_req, res) => res.writeHead(200, { "content-type": "image/png" }).end(await readFile(cover)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const [audio] = await db.insert(schema.tracks).values({
      title: "Fixture Tone", artist: "Fixture Artist", durationSec: 10,
      youtubeVideoId: "audio000001", existingLibraryKey: "fixture-server:1:audio",
      existingFilePath: original, existingCodec: "mp3", existingDurationSec: 10,
      filePath: original, codec: "mp3", stage: "queued",
      artworkUrl: `http://127.0.0.1:${address.port}/cover.png`,
    }).returning();
    const { processFinalize } = await import("./finalize");
    const rejected = await queues.finalize.add("fixture-rejected", { trackId: audio!.id, sourcePath: original, source: "cobalt", inLibrary: true });
    assert.deepEqual(await processFinalize(rejected), { skipped: "not a lossless upgrade" });
    const accepted = await queues.finalize.add("fixture-accepted", { trackId: audio!.id, sourcePath: candidate, source: "lidarr", inLibrary: true });
    const result = await processFinalize(accepted);
    assert.equal("filePath" in result, true);
    const [saved] = await db.select().from(schema.tracks).where(eq(schema.tracks.id, audio!.id));
    assert.equal(saved!.stage, "ready");
    assert.equal(saved!.codec, "flac");
    assert.ok(saved!.filePath!.startsWith(path.join(root, "music", "upgrades", audio!.id) + path.sep));
    assert.equal(saved!.plexRatingKey, null);
    assert.equal(saved!.sonicAnalyzed, false);
    assert.deepEqual(await readFile(original), bytes);
    assert.ok((await readFile(candidate)).length, "Lidarr-owned source is retained too");
  }

  // Backfill UI artwork without reading Plex covers, replacing saved covers, or touching media.
  const { backfillArtwork } = await import("./artwork");
  const savedCover = "https://archive.org/download/fixture/existing.jpg";
  await db.update(schema.tracks).set({ artworkUrl: savedCover });
  const originalBytes = await readFile(path.join(root, "fixture.audio"));
  const artRows = await db.insert(schema.tracks).values(Array.from({ length: 12 }, (_, album) =>
    Array.from({ length: 2 }, (_, song) => ({
      title: `Artwork track ${song}`, artist: "Artwork Fixture",
      album: `Album ${String(album).padStart(2, "0")}`,
      mbReleaseGroupId: "8e8a594f-2175-38c7-a871-abb68ec363e7",
      filePath: "/existing-music/fixture.audio", stage: "ready" as const,
      artworkUrl: song === 0 && album === 0 ? savedCover : null,
    })),
  ).flat()).returning();
  let lookups = 0;
  let unavailable = false;
  let absent = false;
  globalThis.fetch = async (input) => {
    assert.equal(new URL(String(input)).hostname, "coverartarchive.org", "artwork must not access Plex, media hosts or paid APIs");
    lookups++;
    if (unavailable) return Response.json({}, { status: 503 });
    if (absent) return Response.json({}, { status: 404 });
    return Response.json({ images: [{ front: true, approved: true, thumbnails: { "500": "https://archive.org/download/fixture/front-500.jpg" } }] });
  };
  await Promise.all([backfillArtwork(), backfillArtwork()]);
  assert.equal(lookups, 10, "one bounded lookup per album, not per song; concurrent jobs must not duplicate work");
  await backfillArtwork();
  assert.equal(lookups, 12, "keyset cursor must advance past the first batch");
  const enriched = await db.select().from(schema.tracks).where(eq(schema.tracks.artist, "Artwork Fixture"));
  assert.equal(enriched.filter((track) => track.artworkUrl?.endsWith("front-500.jpg")).length, 23);
  assert.equal(enriched.find((track) => track.id === artRows[0]!.id)!.artworkUrl, savedCover);
  assert.equal(enriched[0]!.stage, "ready");
  await backfillArtwork();
  await db.update(schema.tracks).set({ artworkUrl: null }).where(eq(schema.tracks.id, artRows[1]!.id));
  await backfillArtwork();
  assert.equal(lookups, 12, "cached cover must be reused for later tracks on an already matched album");
  await backfillArtwork();
  await db.update(schema.tracks).set({ artworkUrl: null, album: "Transient" }).where(eq(schema.tracks.id, artRows[1]!.id));
  unavailable = true;
  await backfillArtwork();
  await backfillArtwork();
  unavailable = false;
  await backfillArtwork();
  assert.equal(lookups, 14, "transient API failure must be retried, not cached as no cover");
  assert.equal((await db.select().from(schema.tracks).where(eq(schema.tracks.id, artRows[1]!.id)))[0]!.artworkUrl?.endsWith("front-500.jpg"), true);
  await backfillArtwork();
  await db.update(schema.tracks).set({ artworkUrl: null, album: "Missing" }).where(eq(schema.tracks.id, artRows[1]!.id));
  absent = true;
  await backfillArtwork();
  await backfillArtwork();
  await backfillArtwork();
  assert.equal(lookups, 15, "missing cover responses must have a negative cache to avoid hammering the free API");
  assert.deepEqual(await readFile(path.join(root, "fixture.audio")), originalBytes);
});
