import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogQuery } from "@mint/client";
import { albumSelection, loadAlbumDetail } from "../src/features/albums/album-model";
import { catalogPage } from "./helpers/music-fixtures";

test("albums load only bounded album songs, never editable playlist metadata", async () => {
  const signal = new AbortController().signal;
  const calls: CatalogQuery[] = [];
  const result = await loadAlbumDetail({
    catalog: async (query, passed) => { assert.equal(passed, signal); calls.push(query!); return catalogPage; },
  }, "al_fixture", 100, signal);
  assert.deepEqual(calls, [{ type: "track", kind: "album", id: "al_fixture", size: 100, start: 100 }]);
  assert.equal(result.page, catalogPage);
  assert.equal(result.page.items[0]?.artistId, "ar_fixture", "album-to-artist navigation metadata stays available");
  assert.deepEqual(albumSelection("al_fixture"), { kind: "album", id: "al_fixture" }, "Play selects the full album, not the displayed page");
  assert.ok(!("metadata" in result), "albums cannot acquire playlist mutation controls");
  await assert.rejects(loadAlbumDetail(null, "al_fixture", 0, signal), /Sign in/);
  await assert.rejects(loadAlbumDetail({ catalog: async () => { throw new Error("Album unavailable"); } }, "al_fixture", 0, signal), /Album unavailable/);
});
