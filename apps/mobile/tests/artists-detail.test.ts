import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogPage, CatalogQuery } from "@mint/client";
import { artistSelection, loadArtistDetail } from "../src/features/artists/artist-model";
import { catalogPage } from "./helpers/music-fixtures";

test("artists load bounded songs, album shelf and attributed biography without playlist metadata", async () => {
  const signal = new AbortController().signal;
  const calls: CatalogQuery[] = [];
  const profile: CatalogPage = { ...catalogPage, artistProfile: {
    status: "ready", musicBrainzArtistId: null, fetchedAt: null,
    profile: { artistType: "Group", area: null, biography: "Fixture biography", biographyUrl: null,
      relatedArtists: [], listenCount: null, listenerCount: null, unavailableSources: [] },
  } };
  const result = await loadArtistDetail({
    catalog: async (query, passed) => { assert.equal(passed, signal); calls.push(query!); return query!.type === "track" ? profile : catalogPage; },
  }, "ar_fixture", 100, signal);
  assert.deepEqual(calls, [
    { type: "track", kind: "artist", id: "ar_fixture", size: 100, start: 100 },
    { type: "album", kind: "artist", id: "ar_fixture", size: 20 },
  ]);
  assert.equal(result.albums, catalogPage);
  assert.equal(result.page.artistProfile?.profile?.biography, "Fixture biography");
  assert.deepEqual(artistSelection("ar_fixture"), { kind: "artist", id: "ar_fixture" });
  assert.ok(!("metadata" in result));
  await assert.rejects(loadArtistDetail(null, "ar_fixture", 0, signal), /Sign in/);
  await assert.rejects(loadArtistDetail({ catalog: async () => { throw new Error("Artist unavailable"); } }, "ar_fixture", 0, signal), /Artist unavailable/);
});
