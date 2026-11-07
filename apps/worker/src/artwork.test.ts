import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { signToken } from "@mint/core/crypto";
import { serveArtwork } from "./artwork-http";
import { loadArtistArtwork, loadTrackArtwork as cachedTrackArtwork, publicArtworkUrl } from "./artwork";
const loadTrackArtwork: typeof cachedTrackArtwork = (track) => cachedTrackArtwork(track, null);

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0u0AAAAASUVORK5CYII=", "base64");
const track = (patch = {}) => ({ id: randomUUID(), plexRatingKey: "101", artworkUrl: "https://archive.org/download/fixture/cover.png",
  mbReleaseGroupId: null, youtubeVideoId: null, ...patch });

test("artist artwork authorization requires a variant-bound signed token", async (t) => {
  const previous = process.env.MINT_SIGNING_SECRET;
  process.env.MINT_SIGNING_SECRET = "test-signing-secret-that-is-long-enough";
  t.after(() => {
    if (previous === undefined) delete process.env.MINT_SIGNING_SECRET;
    else process.env.MINT_SIGNING_SECRET = previous;
  });
  const id = randomUUID();
  const server = createServer((req, res) => void serveArtwork(req, res, id, "artist"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/artwork/${id}`;
  const albumToken = signToken("artwork", { trackId: id, variant: "album" }, 30_000);
  const legacyToken = signToken("artwork", { trackId: id }, 30_000);
  for (const token of [albumToken, legacyToken]) {
    const response = await fetch(base, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("Plex grandparent artist artwork is proxied and missing portraits do not fall back to album covers", async (t) => {
  const previous = { url: process.env.PLEX_URL, token: process.env.PLEX_TOKEN };
  process.env.PLEX_URL = "http://plex-artist-artwork.test";
  process.env.PLEX_TOKEN = "private-artist-fixture-token";
  t.after(() => {
    if (previous.url === undefined) delete process.env.PLEX_URL; else process.env.PLEX_URL = previous.url;
    if (previous.token === undefined) delete process.env.PLEX_TOKEN; else process.env.PLEX_TOKEN = previous.token;
  });
  let metadata = 0, photos = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "plex-artist-artwork.test");
    assert.equal(new Headers(init?.headers).get("x-plex-token"), "private-artist-fixture-token");
    if (url.pathname.startsWith("/library/metadata/")) {
      metadata++;
      return Response.json({ MediaContainer: { Metadata: [{ grandparentThumb: "/library/metadata/70/thumb/789",
        parentThumb: "/library/metadata/50/thumb/123", thumb: "/library/metadata/101/thumb/456" }] } });
    }
    photos++;
    assert.equal(url.pathname, "/photo/:/transcode");
    assert.equal(url.searchParams.get("url"), "/library/metadata/70/thumb/789");
    assert.ok(!url.href.includes("private-artist-fixture-token"));
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  const result = await loadArtistArtwork(track());
  assert.equal(result?.source, "plex");
  assert.deepEqual(result?.bytes, png);
  assert.equal(metadata, 1);
  assert.equal(photos, 1);

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ MediaContainer: { Metadata: [{ parentThumb: "/library/metadata/50/thumb/123" }] } }));
  assert.equal(await loadArtistArtwork(track({ plexRatingKey: "102", artworkUrl: "https://archive.org/download/fixture/album.png" })), null);
});

test("Plex album covers are primary, resized privately, coalesced and shared across an album", async (t) => {
  const previous = { url: process.env.PLEX_URL, token: process.env.PLEX_TOKEN };
  process.env.PLEX_URL = "http://plex-artwork-primary.test";
  process.env.PLEX_TOKEN = "private-fixture-token";
  t.after(() => {
    if (previous.url === undefined) delete process.env.PLEX_URL; else process.env.PLEX_URL = previous.url;
    if (previous.token === undefined) delete process.env.PLEX_TOKEN; else process.env.PLEX_TOKEN = previous.token;
  });
  let metadata = 0, photos = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "plex-artwork-primary.test", "successful Plex art must not request public providers");
    assert.equal(new Headers(init?.headers).get("x-plex-token"), "private-fixture-token");
    assert.equal(init?.redirect, "error");
    if (url.pathname.startsWith("/library/metadata/")) {
      metadata++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ MediaContainer: { Metadata: [{ parentThumb: "/library/metadata/50/thumb/123", thumb: "/library/metadata/101/thumb/456" }] } });
    }
    photos++;
    assert.equal(url.pathname, "/photo/:/transcode");
    assert.equal(url.searchParams.get("url"), "/library/metadata/50/thumb/123");
    assert.equal(url.searchParams.get("width"), "512");
    assert.equal(url.searchParams.get("height"), "512");
    assert.ok(!url.href.includes("private-fixture-token"));
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  const song = track();
  const results = await Promise.all(Array.from({ length: 30 }, () => loadTrackArtwork(song)));
  assert.equal(metadata, 1); assert.equal(photos, 1);
  for (const result of results) {
    assert.equal(result?.source, "plex"); assert.equal(result?.type, "image/png");
    assert.deepEqual(result?.bytes, png);
  }
  assert.equal((await loadTrackArtwork(track({ plexRatingKey: "102" })))?.source, "plex");
  assert.equal(metadata, 2); assert.equal(photos, 1, "other songs on the same album reuse the cover bytes");
  let now = Date.now() + 3601_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  const stale = await loadTrackArtwork(song);
  assert.equal(stale?.source, "plex"); assert.equal(stale?.maxAge, 60);
  assert.deepEqual(stale?.bytes, png, "a temporary outage must not replace a known-good album cover");
  now += 61_000;
  assert.deepEqual((await loadTrackArtwork(song))?.bytes, png, "repeated metadata and image outages retain the last cover");
  now += 8 * 86400_000;
  assert.equal(await loadTrackArtwork(song), null, "failed retries must not indefinitely extend the seven-day stale limit");
});

test("Plex errors fall back to validated public covers, never forward credentials, and retry Plex later", async (t) => {
  const previous = { url: process.env.PLEX_URL, token: process.env.PLEX_TOKEN };
  process.env.PLEX_URL = "http://plex-artwork-fallback.test"; process.env.PLEX_TOKEN = "secret-must-stay-private";
  t.after(() => {
    if (previous.url === undefined) delete process.env.PLEX_URL; else process.env.PLEX_URL = previous.url;
    if (previous.token === undefined) delete process.env.PLEX_TOKEN; else process.env.PLEX_TOKEN = previous.token;
  });
  let now = Date.now(), plexOk = false, calls = 0, publicCalls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "plex-artwork-fallback.test") {
      calls++;
      if (!plexOk) return new Response(null, { status: 503 });
      if (url.pathname.startsWith("/library/metadata/")) return Response.json({ MediaContainer: { Metadata: [{ parentThumb: "/library/metadata/80/thumb/999" }] } });
      return new Response(png);
    }
    publicCalls++;
    assert.equal(new Headers(init?.headers).get("x-plex-token"), null);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(url.hostname, "archive.org");
    return new Response(png);
  });
  const song = track({ artworkUrl: "https://archive.org/download/fallback/cover.png" });
  assert.equal((await loadTrackArtwork(song))?.source, "public");
  assert.equal((await loadTrackArtwork(song))?.maxAge, 300);
  assert.equal(calls, 1); assert.equal(publicCalls, 1, "transient source failures have a short cooldown; the fallback is cached");
  now += 31_000; plexOk = true;
  assert.equal((await loadTrackArtwork(song))?.source, "plex");
  assert.equal(calls, 3);
});

test("missing/invalid Plex thumbs and broken saved art fall through to archive and then YouTube", async (t) => {
  const previous = { url: process.env.PLEX_URL, token: process.env.PLEX_TOKEN };
  process.env.PLEX_URL = "http://plex-artwork-invalid.test"; process.env.PLEX_TOKEN = "private-fixture";
  t.after(() => {
    if (previous.url === undefined) delete process.env.PLEX_URL; else process.env.PLEX_URL = previous.url;
    if (previous.token === undefined) delete process.env.PLEX_TOKEN; else process.env.PLEX_TOKEN = previous.token;
  });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input); calls.push(url.href);
    if (url.hostname.startsWith("plex-artwork")) {
      return Response.json({ MediaContainer: { Metadata: [{ parentThumb: "http://127.0.0.1/secret", thumb: "/library/metadata/1/thumb?X-Plex-Token=secret" }] } });
    }
    assert.equal(new Headers(init?.headers).get("x-plex-token"), null);
    if (url.hostname === "archive.org") return new Response("<html>outage</html>", { headers: { "content-type": "text/html" } });
    if (url.hostname === "coverartarchive.org") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
    assert.equal(url.hostname, "i.ytimg.com");
    return new Response(png);
  });
  const result = await loadTrackArtwork(track({ artworkUrl: "https://archive.org/download/broken/html.jpg",
    mbReleaseGroupId: randomUUID(), youtubeVideoId: "fixture1234" }));
  assert.equal(result?.source, "public"); assert.deepEqual(result?.bytes, png);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((url) => !url.includes("127.0.0.1")));
});

test("public artwork rejects arbitrary/protected URLs, redirect credentials, SVG and oversized bodies", async (t) => {
  for (const value of ["http://archive.org/cover.jpg", "https://archive.org.evil.test/cover", "https://localhost/cover",
    "https://archive.org:444/a", "https://user:secret@archive.org/cover", "file:///etc/passwd", "https://127.0.0.1/cover"]) {
    assert.throws(() => publicArtworkUrl(value), /Unsupported|Invalid/);
  }
  assert.equal(publicArtworkUrl("https://ia800100.us.archive.org/cover.jpg"), "https://ia800100.us.archive.org/cover.jpg");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    if (calls === 2) return new Response(png, { headers: { "content-length": String(5 * 1024 ** 2) } });
    return new Response(new Uint8Array(4 * 1024 ** 2 + 1));
  });
  for (let i = 0; i < 3; i++) assert.equal(await loadTrackArtwork(track({ plexRatingKey: null, artworkUrl: `https://archive.org/download/limits/${i}.jpg` })), null);
});
