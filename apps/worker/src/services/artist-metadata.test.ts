import assert from "node:assert/strict";
import test from "node:test";
import { fetchArtistMetadata as cachedArtistMetadata } from "./artist-metadata";
const fetchArtistMetadata: typeof cachedArtistMetadata = (name, ids) => cachedArtistMetadata(name, ids, null);

const artistId = "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11";
const relatedId = "4ac1c9a0-4d3d-4c65-99b6-123456789abc";

test("artist lookup refuses ambiguous exact MusicBrainz names", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.hostname, "musicbrainz.org");
    assert.equal(url.pathname, "/ws/2/artist");
    assert.equal(url.searchParams.get("fmt"), "json");
    const expectedAgent = url.hostname === "musicbrainz.org"
      ? "Mint/3.5 ( https://github.com/ChickenBone/mint )"
      : "Mint/3.5 (https://github.com/ChickenBone/mint)";
    assert.equal(new Headers(init?.headers).get("user-agent"), expectedAgent);
    return Response.json({ artists: [
      { id: artistId, name: "The Artist", score: 100 },
      { id: relatedId, name: "The Artist", score: 100 },
      { id: "00000000-0000-4000-8000-000000000001", name: "The Artist (Live)", score: 100 },
    ] });
  });
  const result = await fetchArtistMetadata("The Artist");
  assert.deepEqual(result, { status: "ambiguous", musicBrainzArtistId: null, profile: null });
  assert.equal(calls, 1, "an ambiguous search must not trigger downstream enrichment");
});

test("artist enrichment fetches attributed Wikipedia summaries and ListenBrainz community data", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(`${url.hostname}${url.pathname}`);
    if (url.hostname !== "musicbrainz.org") assert.equal(init?.redirect, "error");
    const expectedAgent = url.hostname === "musicbrainz.org"
      ? "Mint/3.5 ( https://github.com/ChickenBone/mint )"
      : "Mint/3.5 (https://github.com/ChickenBone/mint)";
    assert.equal(new Headers(init?.headers).get("user-agent"), expectedAgent);
    if (url.hostname === "musicbrainz.org") {
      assert.equal(url.pathname, `/ws/2/artist/${artistId}`);
      assert.equal(url.searchParams.get("inc"), "artist-rels+url-rels");
      return Response.json({ id: artistId, name: "The Artist", type: "Group", area: { name: "London" }, relations: [
        { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q12345" } },
        { type: "member of band", artist: { id: relatedId, name: "Another Artist" } },
      ] });
    }
    if (url.hostname === "www.wikidata.org") {
      assert.equal(url.searchParams.get("ids"), "Q12345");
      return Response.json({ entities: { Q12345: { sitelinks: { enwiki: { title: "The Artist" } } } } });
    }
    if (url.hostname === "en.wikipedia.org") {
      assert.equal(init?.redirect, "error");
      return Response.json({
        extract: "A  musical group founded in 2001.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/The_Artist" } },
      });
    }
    if (url.hostname === "api.listenbrainz.org") {
      assert.equal(init?.redirect, "error");
      assert.equal(url.pathname, "/1/popularity/artist");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { artist_mbids: [artistId] });
      return Response.json([{ artist_mbid: artistId, total_listen_count: 12345, total_user_count: 678 }]);
    }
    assert.equal(url.hostname, "labs.api.listenbrainz.org");
    assert.equal(init?.redirect, "error");
    return Response.json([{ artist_mbid: relatedId, artist_name: "Another Artist", score: 0.9 }]);
  });

  const result = await fetchArtistMetadata("The Artist", [artistId]);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.musicBrainzArtistId, artistId);
  assert.deepEqual(result.profile.unavailableSources, []);
  assert.equal(result.profile.artistType, "Group");
  assert.equal(result.profile.area, "London");
  assert.equal(result.profile.biography, "A musical group founded in 2001.");
  assert.equal(result.profile.biographyUrl, "https://en.wikipedia.org/wiki/The_Artist");
  assert.deepEqual(result.profile.relatedArtists, [{ name: "Another Artist", musicBrainzArtistId: relatedId, source: "listenbrainz" }]);
  assert.equal(result.profile.listenCount, 12345);
  assert.equal(result.profile.listenerCount, 678);
  assert.deepEqual(result.profile.unavailableSources, []);
  assert.ok(requests.includes("en.wikipedia.org/api/rest_v1/page/summary/The%20Artist"));
});

test("artist enrichment records optional provider failures rather than hiding them", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "musicbrainz.org") {
      return Response.json({ id: artistId, name: "The Artist", relations: [] });
    }
    return new Response(null, { status: 503 });
  });
  const result = await fetchArtistMetadata("The Artist", [artistId]);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.profile.unavailableSources.sort(), [
      "listenbrainz-popularity", "listenbrainz-related",
    ]);
  }
});
