import assert from "node:assert/strict";
import test from "node:test";
import { publicCacheFixture } from "../../../../packages/core/src/public-cache-fixture";
import { PublicProviderBusyError } from "@mint/core/public-cache";
import { musicBrainzJson } from "./musicbrainz";
import { fetchArtistMetadata } from "./artist-metadata";
import { findAlbumArtwork } from "./artwork";
import { readPublicArtwork } from "../artwork";
import { readPublicMetadata } from "./public-metadata";

const id = "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11", related = "4ac1c9a0-4d3d-4c65-99b6-123456789abc";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0u0AAAAASUVORK5CYII=", "base64");
test("MusicBrainz read identity includes all parameters and coalesces across store instances", async (t) => {
  let now = Date.now(), calls = 0;
  const fixture = publicCacheFixture(() => now);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls++; assert.equal(init?.redirect, "error");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ recordings: [{ id, title: "Public recording", score: 100 }] });
  });
  const url = "https://musicbrainz.org/ws/2/recording", query = { fmt: "json", query: "Public recording", limit: 10 };
  await Promise.all(Array.from({ length: 25 }, (_, index) => musicBrainzJson(url, query, { cache: index % 2 ? fixture.cache : fixture.instance() })));
  await musicBrainzJson(url, query, { cache: fixture.instance() });
  assert.equal(calls, 1, "26 matching lookups use a single source request");
  now += 2100;
  await musicBrainzJson(url, { ...query, limit: 15 }, { cache: fixture.cache }); assert.equal(calls, 2);
  now += 2100;
  await musicBrainzJson(url, { ...query, query: "Another recording" }, { cache: fixture.cache }); assert.equal(calls, 3);
});
test("MusicBrainz 429 and malformed metadata never become an empty success or retry storm", async (t) => {
  let calls = 0;
  const fixture = publicCacheFixture();
  t.mock.method(globalThis, "fetch", async () => {
    calls++; return new Response(null, { status: 429, headers: { "retry-after": "180" } });
  });
  const url = "https://musicbrainz.org/ws/2/artist";
  await assert.rejects(musicBrainzJson(url, { fmt: "json", query: "One" }, { cache: fixture.cache }), PublicProviderBusyError);
  await assert.rejects(musicBrainzJson(url, { fmt: "json", query: "Two" }, { cache: fixture.instance() }), PublicProviderBusyError);
  assert.equal(calls, 1);
  const invalid = publicCacheFixture();
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.rejects(musicBrainzJson(url, { fmt: "json", query: "One" }, { cache: invalid.cache }), /Invalid MusicBrainz/);
  assert.ok([...invalid.entries.keys()].every((key) => key.includes("cooldown") || key.includes("throttle")));
  const malformed = publicCacheFixture();
  await assert.rejects(readPublicMetadata(`https://coverartarchive.org/release-group/${id}`, {
    provider: "CoverArtArchive", cache: malformed.cache, request: async () => Response.json(null),
    notFound: () => null, validate: (value) => value, negative: (value) => value === null,
  }), /Invalid public metadata/);
  assert.ok([...malformed.entries.keys()].every((key) => key.includes("cooldown") || key.includes("throttle")));
});
test("artist metadata caches MusicBrainz, Wikidata, Wikipedia and both public ListenBrainz reads", async (t) => {
  const fixture = publicCacheFixture(), calls = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    calls.set(url.hostname, (calls.get(url.hostname) ?? 0) + 1);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    if (url.hostname === "musicbrainz.org") return Response.json({ id, name: "The Artist",
      relations: [{ type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q12345" } }] });
    if (url.hostname === "www.wikidata.org") return Response.json({ entities: { Q12345: { sitelinks: { enwiki: { title: "The Artist" } } } } });
    if (url.hostname === "en.wikipedia.org") return Response.json({ extract: "An original fixture biography.",
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/The_Artist" } } });
    if (url.hostname === "api.listenbrainz.org") {
      assert.equal(init?.method, "POST"); assert.deepEqual(JSON.parse(String(init?.body)), { artist_mbids: [id] });
      return Response.json([{ artist_mbid: id, total_listen_count: 123, total_user_count: 12 }]);
    }
    assert.equal(url.hostname, "labs.api.listenbrainz.org");
    return Response.json([{ artist_mbid: related, artist_name: "Related Artist" }]);
  });
  const values = await Promise.all([fetchArtistMetadata("The Artist", [id], fixture.cache),
    fetchArtistMetadata("The Artist", [id], fixture.instance())]);
  const repeated = await fetchArtistMetadata("The Artist", [id], fixture.instance());
  assert.ok(values.every((result) => result.status === "ready")); assert.equal(repeated.status, "ready");
  assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), 5, "three enrichment requests use five total provider reads, not fifteen");
  assert.ok([...calls.values()].every((count) => count === 1));
});
test("optional metadata invalid shapes and transient failures stay explicitly unavailable", async (t) => {
  const fixture = publicCacheFixture();
  t.mock.method(globalThis, "fetch", async (input: string | URL) => new URL(input).hostname === "musicbrainz.org"
    ? Response.json({ id, name: "The Artist", relations: [] }) : Response.json({ error: "Invalid upstream shape" }));
  const result = await fetchArtistMetadata("The Artist", [id], fixture.cache);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.deepEqual(result.profile.unavailableSources.sort(), ["listenbrainz-popularity", "listenbrainz-related"]);
  await assert.rejects(readPublicMetadata("https://www.wikidata.org/w/api.php?action=query", {
    provider: "Wikidata", cache: fixture.instance(), init: { headers: { authorization: "Bearer private" } }, validate: (value) => value,
  }), /credentials/);
});
test("approved CAA resolution and public raster bytes persist separately and reduce identical reads", async (t) => {
  let now = Date.now(), calls = 0;
  const fixture = publicCacheFixture(() => now), image = "https://archive.org/download/cached-cover/cover.png";
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    calls++; assert.equal(new Headers(init?.headers).get("authorization"), null);
    const url = new URL(input);
    return url.hostname === "coverartarchive.org" ? Response.json({ images: [{ approved: true, front: true, thumbnails: { "500": image } }] }) : new Response(png);
  });
  await Promise.all([findAlbumArtwork("Artist", "Album", id, fixture.cache), findAlbumArtwork("Artist", "Album", id, fixture.instance())]);
  await findAlbumArtwork("Artist", "Album", id, fixture.instance()); assert.equal(calls, 1);
  now += 2000;
  const images = await Promise.all(Array.from({ length: 20 }, (_, index) => readPublicArtwork(image, index % 2 ? fixture.cache : fixture.instance())));
  assert.ok(images.every((value) => value.type === "image/png" && value.bytes.equals(png)));
  await readPublicArtwork(image, fixture.instance());
  assert.equal(calls, 2, "three resolutions and twenty-one image loads make two upstream reads");
});
test("public images honor 429 cooldown, retain stale bytes with age, and expire at seven days", async () => {
  let now = Date.now(), calls = 0;
  const fixture = publicCacheFixture(() => now), url = "https://i.ytimg.com/vi/fixture1234/mqdefault.jpg";
  const good: typeof fetch = async () => { calls++; return new Response(png); };
  await readPublicArtwork(url, fixture.cache, good);
  now += 86401_000;
  const busy: typeof fetch = async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "120" } }); };
  const stale = await readPublicArtwork(url, fixture.instance(), busy);
  assert.equal("cacheStale" in stale && stale.cacheStale, true);
  assert.equal("ageSeconds" in stale && stale.ageSeconds, 86401);
  await readPublicArtwork(url, fixture.instance(), busy); assert.equal(calls, 2);
  now += 7 * 86400_000;
  await assert.rejects(readPublicArtwork(url, fixture.instance(), busy), PublicProviderBusyError);
  assert.equal(calls, 3);
});
test("real image 404s are bounded negatives, while unsafe redirects and non-raster bytes never publish", async () => {
  let now = Date.now(), calls = 0;
  const fixture = publicCacheFixture(() => now), url = "https://archive.org/download/missing/cover.png";
  const missing: typeof fetch = async () => { calls++; return new Response(null, { status: 404 }); };
  await assert.rejects(readPublicArtwork(url, fixture.cache, missing), /404/);
  await assert.rejects(readPublicArtwork(url, fixture.instance(), missing), /404/); assert.equal(calls, 1);
  now += 301_000;
  await readPublicArtwork(url, fixture.instance(), async () => { calls++; return new Response(png); });
  assert.equal(calls, 2);
  const unsafe = publicCacheFixture();
  let hops = 0;
  await assert.rejects(readPublicArtwork("https://coverartarchive.org/release-group/" + id + "/front-500", unsafe.cache,
    async () => { hops++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); }), /Unsupported/);
  assert.equal(hops, 1); assert.ok([...unsafe.entries.keys()].every((key) => key.includes("cooldown") || key.includes("throttle")));
  const invalid = publicCacheFixture();
  await assert.rejects(readPublicArtwork(url, invalid.cache, async () => new Response("<svg/>")), /raster/);
  assert.ok([...invalid.entries.keys()].every((key) => key.includes("cooldown") || key.includes("throttle")));
});
