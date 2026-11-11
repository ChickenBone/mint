import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogBridge, configuredCatalogBridge } from "@mint/core";
import { verifyToken } from "@mint/core/crypto";
import { albumPlayerId, externalCatalogPageSchema, MintApi } from "@mint/client";
import { catalogPageForListener, decodeCatalogLibraryAlbum } from "../src/lib/catalog-connection-data";
import { nativeHttp } from "../src/lib/native-http";
import { readRequestRecording } from "../src/lib/music-requests";

const id = "00000000-0000-4000-8000-000000000001";
const user = { id: "fixture-user", name: "Fixture listener", email: "fixture@example.invalid", role: "user" as const, status: "active" as const };
test("local album links are decoded canonically without inferring an external identity from names", () => {
  assert.deepEqual(decodeCatalogLibraryAlbum(albumPlayerId("Fixture artist", "Fixture album")), ["Fixture artist", "Fixture album"]);
  for (const bad of ["artist name", `al_${Buffer.from('["artist"]').toString("base64url")}`,
    `al_${Buffer.from('["artist","album", "extra"]').toString("base64url")}`, `${albumPlayerId("artist", "album")}=`, "al_invalid"]) {
    assert.equal(decodeCatalogLibraryAlbum(bad), null);
  }
});
test("catalog recordings become non-playable metadata and account/purpose-bound explicit request choices", async () => {
  const original = process.env.MINT_SIGNING_SECRET;
  process.env.MINT_SIGNING_SECRET = "fixture-not-a-real-signing-secret-1234567890";
  try {
    const bridge = new CatalogBridge("https://example.invalid", "fixture-not-a-real-bridge-token-123456", async () =>
      Response.json({ items: [{ id, title: "Fixture recording", artist: "Fixture artist", url: `https://musicbrainz.org/recording/${id}` }], next_cursor: null }));
    const raw = await bridge.page("albums", id);
    const result = catalogPageForListener(raw, user.id, "albums");
    const [recording] = result.items;
    assert.equal(recording?.playable, false);
    assert.equal(recording?.source, "musicbrainz");
    assert.equal(recording?.requestToken?.includes("fixture-not-a-real-bridge-token"), false);
    assert.deepEqual(readRequestRecording(user.id, recording!.requestToken!), {
      id, title: "Fixture recording", artist: "Fixture artist", album: null, durationSec: null,
    });
    assert.throws(() => readRequestRecording("another-fixture-user", recording!.requestToken!), /expired/);
    assert.equal(verifyToken("audio", recording!.requestToken), null);
    const albums = catalogPageForListener({ items: [{ id, title: "Fixture album", artist: "Fixture artist", url: `https://musicbrainz.org/release-group/${id}` }], next_cursor: null }, user.id, "artists");
    assert.equal(albums.items[0]?.requestToken, undefined, "album browsing does not create album acquisition permission");
    assert.equal(externalCatalogPageSchema.safeParse({ ...result, items: [{ ...recording, playable: true }] }).success, false);

    const calls: string[] = [];
    const api = new MintApi({ serverUrl: "https://mint.example.invalid", token: `mn1.${id}.${"a".repeat(43)}`,
      fetch: async (url, init) => {
        calls.push(String(url));
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer mn1.${id}.${"a".repeat(43)}`);
        return Response.json(result);
      } });
    const page = await api.request(`catalog/albums/${id}/recordings?limit=50`, externalCatalogPageSchema);
    assert.equal(page.items[0]?.playable, false);
    assert.equal(calls.length, 1, "browsing performs a single metadata GET, never an acquisition or queue request");
  } finally {
    if (original === undefined) delete process.env.MINT_SIGNING_SECRET;
    else process.env.MINT_SIGNING_SECRET = original;
  }
});

test("unconfigured catalog fallback stays separate from playable data and privately transported", async () => {
  assert.equal(configuredCatalogBridge({}), null);
  const request = new Request(`https://mint.example.invalid/api/native/catalog/artists/${id}/albums`);
  const response = await nativeHttp(request, async () =>
    Response.json(externalCatalogPageSchema.parse({ configured: false, items: [], nextCursor: null })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { configured: false, items: [], nextCursor: null });
  assert.equal(externalCatalogPageSchema.safeParse({ configured: false, items: [{
    id, title: "Fixture", artist: "Fixture", source: "musicbrainz", playable: false,
    url: `https://musicbrainz.org/recording/${id}`,
  }], nextCursor: null }).success, false);
});
