import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogQuery, CollectionList } from "@mint/client";
import { loadLibrary } from "../src/features/your-music/library-model";
import { catalogPage, collectionDetail } from "./helpers/music-fixtures";

test("Your Music retains every library facet, collaborative invitations, folders and pins", async () => {
  const signal = new AbortController().signal;
  const native: CollectionList = {
    collections: [{ ...collectionDetail, role: "editor", pinned: true, folderId: "folder" }],
    folders: [{ id: "folder", userId: collectionDetail.ownerId, title: "Fixture folder" }],
    invitations: [{ id: "invitation", title: "Fixture invitation", owner: "Fixture owner" }],
  };
  const catalog = { ...catalogPage, items: [{ id: "import", type: "playlist" as const, title: "Fixture import", playlistSource: "spotify" as const }] };
  for (const type of ["playlist", "album", "artist", "track"] as const) {
    const calls: CatalogQuery[] = [];
    const result = await loadLibrary({
      collections: async (passed) => { assert.equal(passed, signal); return native; },
      catalog: async (query, passed) => { assert.equal(passed, signal); calls.push(query!); return catalog; },
    }, type, 100, signal);
    assert.deepEqual(calls, [{ type, size: 100, start: 100 }]);
    assert.equal(result.native, native);
    assert.equal(result.catalog, catalog);
  }
  await assert.rejects(loadLibrary(null, "playlist", 0, signal), /Sign in/);
});
