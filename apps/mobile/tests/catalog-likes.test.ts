import assert from "node:assert/strict";
import test from "node:test";
import { collectionIdentity } from "@mint/client";
import { catalogAlbumItems, catalogRequestLabel, catalogSongAlbums, filterCatalogSongs } from "../src/components/music/catalog-model";
import { likedImportStatus } from "../src/features/playlists/playlist-model";

const existing = (stage: string) => ({ id: "t", recordingId: null, stage, error: null, detail: null, playable: stage === "ready" });
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

test("catalog-only artist and album ids decode to display names", () => {
  assert.deepEqual(collectionIdentity(`ar_${encode("Tame Impala with JENNIE")}`), { artist: "Tame Impala with JENNIE" });
  assert.deepEqual(collectionIdentity(`al_${encode(JSON.stringify(["Beyoncé", "Renaissance"]))}`), { artist: "Beyoncé", album: "Renaissance" });
  assert.equal(collectionIdentity("pl_whatever"), null);
  assert.equal(collectionIdentity("ar_%%%"), null);
});

test("catalog song rows describe like-and-import progress honestly", () => {
  assert.equal(catalogRequestLabel({ existing: null }), "Not in your library");
  assert.equal(catalogRequestLabel({ existing: null }, { trackId: "t", stage: "queued", liked: true }), "Liked · Importing…");
  assert.equal(catalogRequestLabel({ existing: null }, { trackId: "t", stage: "queued", liked: false }), "Importing…");
  assert.equal(catalogRequestLabel({ existing: existing("ready") }, { trackId: "t", stage: "queued", liked: true }), "Liked · Ready to play");
  assert.equal(catalogRequestLabel({ existing: existing("failed") }), "Couldn't import · Try again");
});

test("catalog songs not imported yet filter by correlated album, and catalog albums open album pages", () => {
  const songs = [{ id: "a", album: "Currents" }, { id: "b", album: null }, { id: "c", album: "Lonerism" }, { id: "d", album: "Currents" }];
  assert.deepEqual(catalogSongAlbums(songs), ["Currents", "Lonerism"]);
  assert.deepEqual(filterCatalogSongs(songs, "Currents").map((song) => song.id), ["a", "d"]);
  assert.equal(filterCatalogSongs(songs, null).length, 4);
  assert.deepEqual(catalogAlbumItems([{ id: "al_x", title: "Currents", artist: "Tame Impala" }]),
    [{ type: "album", id: "al_x", title: "Currents", artist: "Not imported yet" }]);
});

test("liked songs that are still importing show their stage", () => {
  assert.equal(likedImportStatus({ stage: "queued", progress: 0 }), "Waiting to import");
  assert.equal(likedImportStatus({ stage: "searching", progress: 0 }), "Finding a source…");
  assert.equal(likedImportStatus({ stage: "downloading", progress: 0.42 }), "Importing · 42%");
  assert.equal(likedImportStatus({ stage: "tagging", progress: 1 }), "Importing…");
  assert.equal(likedImportStatus({ stage: "failed", progress: 0 }), "Couldn't import");
});
