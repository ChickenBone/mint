import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import pg from "pg";

test("public covers proxy private Plex through signed worker requests and consistently hydrate catalogs", {
  skip: !process.env.MINT_LIBRARY_TEST_DATABASE_URL, timeout: 60_000,
}, async (t) => {
  const url = new URL(process.env.MINT_LIBRARY_TEST_DATABASE_URL!);
  assert.match(url.pathname, /^\/mint_library_test/);
  const admin = new pg.Client({ connectionString: url.href });
  const name = `mint_library_test_artwork_${randomBytes(5).toString("hex")}`;
  await admin.connect(); await admin.query(`create database "${name}"`);
  url.pathname = `/${name}`;
  Object.assign(process.env, {
    DATABASE_URL: url.href, PLEX_URL: "http://private-plex-fixture.test", PLEX_TOKEN: "private-fixture-token-not-for-browsers",
    MINT_SIGNING_SECRET: randomBytes(32).toString("hex"),
  });
  const { getDb, closeDb, schema } = await import("@mint/core/db");
  const { runMigrations } = await import("@mint/core/db/migrate");
  const { signToken } = await import("@mint/core/crypto");
  const { toTrackView } = await import("@mint/core/views");
  const { serveArtwork } = await import("./artwork-http");
  const { GET, HEAD } = await import("../../web/src/app/api/artwork/[id]/route");
  const { catalogItems } = await import("../../web/src/lib/player-catalog");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0u0AAAAASUVORK5CYII=", "base64");
  const requests: string[] = [], originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "private-plex-fixture.test") {
      requests.push(url.href);
      assert.equal(new Headers(init?.headers).get("x-plex-token"), process.env.PLEX_TOKEN);
      if (url.pathname === "/library/metadata/101") return Response.json({ MediaContainer: { Metadata: [{ parentThumb: "/library/metadata/50/thumb/123" }] } });
      if (url.pathname === "/library/metadata/102") return Response.json({ MediaContainer: { Metadata: [{}] } });
      assert.equal(url.pathname, "/photo/:/transcode");
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    if (url.hostname === "archive.org") {
      requests.push(url.href);
      assert.equal(new Headers(init?.headers).get("x-plex-token"), null);
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    return originalFetch(input, init);
  });
  const server = createServer((request, response) => void serveArtwork(request, response, request.url!.slice(9)).catch(() => response.destroy()));
  try {
    await runMigrations(path.resolve("../../packages/core/migrations"));
    const db = getDb();
    const [song, fallback] = await db.insert(schema.tracks).values([
      { title: "Plex cover", artist: "Synthetic only", album: "Album", stage: "ready" as const, filePath: "/private/music.wav", plexRatingKey: "101", artworkUrl: "https://archive.org/download/fallback/primary-not-needed.png" },
      { title: "Public fallback", artist: "Synthetic only", album: "Other", stage: "ready" as const, filePath: "/private/other.wav", plexRatingKey: "102", artworkUrl: "https://archive.org/download/fallback/missing-plex.png" },
    ]).returning();
    assert.ok(song && fallback);
    const view = toTrackView(song);
    assert.equal(view.artworkUrl, `/api/artwork/${song.id}`);
    assert.ok(!JSON.stringify(view).includes("private-plex"));
    const catalog = await catalogItems({ userId: "00000000-0000-4000-8000-000000000001" });
    assert.equal(catalog.items.find((item) => item.id === song.id)?.thumb, view.artworkUrl);
    const albums = await catalogItems({ userId: "00000000-0000-4000-8000-000000000001", type: "album" });
    assert.equal(albums.items.find((item) => item.title === "Album")?.thumb, view.artworkUrl);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    process.env.PLAYBACK_WORKER_URL = base;
    assert.equal((await originalFetch(`${base}/artwork/${song.id}`)).status, 401);
    const wrongPurpose = signToken("playback", { trackId: song.id }, 30_000);
    assert.equal((await originalFetch(`${base}/artwork/${song.id}`, { headers: { authorization: `Bearer ${wrongPurpose}` } })).status, 401);
    const wrongTrack = signToken("artwork", { trackId: fallback.id }, 30_000);
    assert.equal((await originalFetch(`${base}/artwork/${song.id}`, { headers: { authorization: `Bearer ${wrongTrack}` } })).status, 401);
    assert.equal(requests.length, 0, "unauthenticated requests cannot trigger private Plex access");
    const request = (id: string, method = "GET", headers: Record<string, string> = {}) => new Request(`https://mint.example/api/artwork/${id}`, { method, headers });
    const params = Promise.resolve({ id: song.id });
    const primary = await GET(request(song.id), { params });
    assert.equal(primary.status, 200); assert.deepEqual(Buffer.from(await primary.arrayBuffer()), png);
    assert.equal(primary.headers.get("content-type"), "image/png");
    assert.ok(primary.headers.get("cache-control")?.includes("max-age=3600"));
    assert.equal(requests.length, 2, "Plex art succeeds without touching public providers");
    const repeat = await GET(request(song.id), { params });
    assert.deepEqual(Buffer.from(await repeat.arrayBuffer()), png);
    assert.equal(requests.length, 2, "repeat browser requests reuse Plex metadata and cached image");
    const head = await HEAD(request(song.id, "HEAD"), { params });
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
    const notModified = await GET(request(song.id, "GET", { "if-none-match": primary.headers.get("etag")! }), { params });
    assert.equal(notModified.status, 304);
    const publicCover = await GET(request(fallback.id), { params: Promise.resolve({ id: fallback.id }) });
    assert.equal(publicCover.status, 200);
    assert.deepEqual(Buffer.from(await publicCover.arrayBuffer()), png);
    assert.ok(publicCover.headers.get("cache-control")?.includes("max-age=300"));
    assert.ok(requests.at(-1)?.startsWith("https://archive.org/"));
    for (const response of [primary, repeat, head, publicCover]) {
      const headers = JSON.stringify([...response.headers]);
      assert.ok(!headers.includes("private-plex")); assert.ok(!headers.includes(process.env.PLEX_TOKEN!));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
    await admin.query(`drop database "${name}"`); await admin.end();
  }
});
