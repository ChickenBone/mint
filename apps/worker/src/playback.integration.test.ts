import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

test("approved-member streaming, range seeking, session revocation and member-private catalogs", {
  skip: !process.env.MINT_LIBRARY_TEST_DATABASE_URL, timeout: 60_000,
}, async () => {
  const base = new URL(process.env.MINT_LIBRARY_TEST_DATABASE_URL!);
  assert.match(base.pathname, /^\/mint_library_test/);
  const name = `mint_library_test_playback_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base.href });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "mint-playback-http-"));
  Object.assign(process.env, {
    DATABASE_URL: base.href, MUSIC_DIR: root, EXISTING_MUSIC_DIR: root,
    MINT_SIGNING_SECRET: randomBytes(32).toString("hex"),
  });
  const { getDb, closeDb, schema } = await import("@mint/core/db");
  const { runMigrations } = await import("@mint/core/db/migrate");
  const { signToken, sha256 } = await import("@mint/core/crypto");
  const { eq } = await import("drizzle-orm");
  const { servePlayback } = await import("./playback");
  const { catalogItems, catalogResponse, playerArtworkUrl } = await import("../../web/src/lib/player-catalog");
  const { albumPlayerId, artistPlayerId, trackPlayerItem, playerItemSchema } = await import("../../web/src/lib/player-protocol");
  const server = createServer((req, res) => {
    void servePlayback(req, res, req.url!.slice(1)).catch((error: unknown) => { res.destroy(error instanceof Error ? error : undefined); });
  });
  try {
    await runMigrations(path.resolve("../../packages/core/migrations"));
    const db = getDb();
    const artwork = "https://i.ytimg.com/vi/fixture/mqdefault.jpg";
    assert.equal(playerArtworkUrl(`/photo/:/transcode?url=${encodeURIComponent(artwork)}`, "https://mint.example.test"), artwork);
    assert.equal(playerArtworkUrl(`/photo/:/transcode?url=${encodeURIComponent(`/photo/:/transcode?url=${encodeURIComponent(artwork)}`)}`, "https://mint.example.test"), artwork);
    for (const target of ["https://untrusted.example/image.jpg", "http://127.0.0.1/private", "/photo/:/transcode?url=http://worker:8080/private", "https://secret@i.ytimg.com/image.jpg"]) {
      assert.throws(() => playerArtworkUrl(target, "https://mint.example.test"));
    }
    const unicodeArtist = "Björk / 宇多田ヒカル", unicodeAlbum = "世界 / Début";
    assert.equal(albumPlayerId(unicodeArtist, unicodeAlbum), `al_${Buffer.from(JSON.stringify([unicodeArtist, unicodeAlbum])).toString("base64url")}`);
    assert.equal(artistPlayerId(unicodeArtist), `ar_${Buffer.from(unicodeArtist).toString("base64url")}`);
    assert.ok(playerItemSchema.safeParse(trackPlayerItem({ id: "00000000-0000-0000-0000-000000000001", title: "Test", artist: unicodeArtist, album: unicodeAlbum, artworkUrl: artwork })).success);
    const [member, other] = await db.insert(schema.users).values([
      { email: "one@example.test", name: "One", passwordHash: "fixture", status: "active" as const },
      { email: "two@example.test", name: "Two", passwordHash: "fixture", status: "active" as const },
    ]).returning();
    const sessionHash = sha256("fixture-member-session");
    await db.insert(schema.sessions).values({ id: sessionHash, userId: member!.id, expiresAt: new Date(Date.now() + 60_000) });
    const file = path.join(root, "song.wav");
    const bytes = Buffer.from("RIFF fixture media content for byte range assertions");
    await writeFile(file, bytes);
    const [song, queued] = await db.insert(schema.tracks).values([
      { title: "Available", artist: "Artist", album: "Album", stage: "ready" as const, filePath: file },
      { title: "Not downloaded", artist: "Artist", stage: "queued" as const },
    ]).returning();
    await db.insert(schema.userTracks).values({ userId: member!.id, trackId: song!.id });
    const [privatePlaylist] = await db.insert(schema.playlists).values({ userId: other!.id, youtubePlaylistId: "private-fixture", title: "Private to Two" }).returning();
    await db.insert(schema.playlistTracks).values({ playlistId: privatePlaylist!.id, trackId: song!.id, position: 0 });
    assert.equal((await catalogItems({ userId: member!.id })).items.length, 1);
    assert.equal((await catalogItems({ userId: other!.id, playlist: "liked" })).items.length, 0);
    assert.equal((await catalogItems({ userId: member!.id, playlist: privatePlaylist!.id })).items.length, 0);
    assert.equal((await catalogItems({ userId: other!.id, playlist: privatePlaylist!.id })).items.length, 1);
    assert.equal((await catalogItems({ userId: member!.id, q: "Available" })).total, 1);
    await assert.rejects(catalogItems({ userId: member!.id, size: Infinity }), /pagination/);
    await assert.rejects(catalogItems({ userId: member!.id, id: "al_invalid" }), /Invalid album/);
    assert.ok(!JSON.stringify(await catalogItems({ userId: member!.id })).includes(file));
    const album = (await catalogItems({ userId: member!.id, type: "9" })).items[0]!;
    const result = await catalogResponse(`/library/metadata/${album.ratingKey}`, new URLSearchParams(), member!.id);
    assert.ok(result && "MediaContainer" in result);
    assert.equal((result.MediaContainer as { Metadata: Array<{ type: string }> }).Metadata[0]!.type, "album");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const origin = `http://127.0.0.1:${addr.port}`;
    const token = (trackId: string, userId = member!.id) => signToken("playback", { trackId, userId, sessionHash }, 30_000);
    assert.equal((await fetch(`${origin}/${song!.id}`)).status, 401);
    assert.equal((await fetch(`${origin}/${song!.id}`, { headers: { authorization: `Bearer ${signToken("playback", { trackId: song!.id, sessionHash }, 30_000)}` } })).status, 401);
    assert.equal((await fetch(`${origin}/${queued!.id}`, { headers: { authorization: `Bearer ${token(song!.id)}` } })).status, 401);
    assert.equal((await fetch(`${origin}/${song!.id}`, { headers: { authorization: `Bearer ${signToken("playback", { trackId: song!.id, userId: member!.id, sessionHash }, -1)}` } })).status, 401);
    assert.equal((await fetch(`${origin}/${song!.id}`, { headers: { authorization: `Bearer ${token(song!.id, other!.id)}` } })).status, 401);
    const headers = { authorization: `Bearer ${token(song!.id)}` };
    const partial = await fetch(`${origin}/${song!.id}`, { headers: { ...headers, range: "bytes=5-12" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 5-12/${bytes.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(5, 13));
    const head = await fetch(`${origin}/${song!.id}`, { method: "HEAD", headers });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal((await fetch(`${origin}/${song!.id}`, { headers: { ...headers, range: "bytes=99999-" } })).status, 416);
    assert.equal((await fetch(`${origin}/${queued!.id}`, { headers: { authorization: `Bearer ${token(queued!.id)}` } })).status, 404);
    await db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.sessions.id, sessionHash));
    assert.equal((await fetch(`${origin}/${song!.id}`, { headers })).status, 401);
    await db.update(schema.sessions).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.sessions.id, sessionHash));
    await db.update(schema.users).set({ status: "disabled" }).where(eq(schema.users.id, member!.id));
    assert.equal((await fetch(`${origin}/${song!.id}`, { headers })).status, 401);
    await db.insert(schema.tracks).values(Array.from({ length: 500 }, (_, i) => ({
      title: `Paging ${i}`, artist: "Paging", stage: "ready" as const, filePath: file,
    })));
    assert.equal((await catalogItems({ userId: other!.id, size: 500 })).items.length, 500);
    assert.equal((await catalogItems({ userId: other!.id, size: 500, start: 500 })).items.length, 1);
    await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, member!.id));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionHash));
    assert.equal((await fetch(`${origin}/${song!.id}`, { headers })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
    await rm(root, { recursive: true, force: true });
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
