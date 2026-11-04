import assert from "node:assert/strict";
import test from "node:test";
import { matchRecording } from "./services/musicbrainz";
import { importedFile } from "./services/lidarr";

test("an explicit MusicBrainz recording is looked up by identity and cannot be replaced by a fuzzy result", async (t) => {
  const id = "b00b6c22-98cd-4ce0-84bb-d8dd07146b45";
  let title = "Distant Window", duration = 180000;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    assert.equal(url.pathname, `/ws/2/recording/${id}`);
    assert.equal(url.searchParams.get("inc"), "artists+releases+release-groups");
    return Response.json({ id, title, length: duration, "artist-credit": [{ name: "The Paper Moons", artist: { id: "artist", name: "The Paper Moons" } }],
      releases: [{ id: "release", title: "Night Letters", status: "Official", "release-group": { id: "group", "primary-type": "Album" } }] });
  });
  const query = { mbRecordingId: id, title, artist: "The Paper Moons", album: "Night Letters", durationSec: 180 };
  assert.equal((await matchRecording(query))?.recordingId, id);
  title = "Distant Window (Live)";
  assert.equal(await matchRecording(query), null);
  title = query.title; duration = 184000;
  assert.equal(await matchRecording(query), null);
});
test("Lidarr cannot fall back to another same-name recording when a recording identity was selected", async (t) => {
  const oldUrl = process.env.LIDARR_URL, oldKey = process.env.LIDARR_API_KEY;
  process.env.LIDARR_URL = "http://lidarr.fixture"; process.env.LIDARR_API_KEY = "fixture-only";
  let exact = false, duplicate = false, fileCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/track")) {
      const row = { title: "Distant Window", foreignRecordingId: exact ? "wanted" : "another", hasFile: true, trackFileId: 1 };
      return Response.json(duplicate ? [row, row] : [row]);
    }
    fileCalls++; return Response.json({ path: "/mint-fixture/download.flac", size: 128 });
  });
  try {
    assert.equal(await importedFile(1, { recordingId: "wanted", title: "Distant Window" }), null); assert.equal(fileCalls, 0);
    exact = true; assert.equal((await importedFile(1, { recordingId: "wanted", title: "Distant Window" }))?.size, 128);
    duplicate = true; await assert.rejects(importedFile(1, { recordingId: "wanted", title: "Distant Window" }), /multiple editions/);
  } finally {
    if (oldUrl === undefined) delete process.env.LIDARR_URL; else process.env.LIDARR_URL = oldUrl;
    if (oldKey === undefined) delete process.env.LIDARR_API_KEY; else process.env.LIDARR_API_KEY = oldKey;
  }
});
