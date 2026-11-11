import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingSearchItem } from "../src/lib/music-requests";
import type { PlayerItem } from "../src/lib/player-protocol";
import { recordingsOutsideTop, searchResponseIsCurrent, topSearchResult, uniqueExternalResults } from "../src/lib/unified-search";

const localTrack = (overrides: Partial<PlayerItem> = {}): PlayerItem => ({
  id: "local-track",
  title: "Cafe Lights",
  type: "track",
  artist: "The Paper Moons",
  album: "Rooms in Blue",
  duration: 180_000,
  ...overrides,
});

const recording = (id: string, overrides: Partial<RecordingSearchItem> = {}): RecordingSearchItem => ({
  id,
  title: "Cafe Lights",
  artist: "The Paper Moons",
  album: "Rooms in Blue",
  durationSec: 180,
  token: "fixture-token",
  existing: null,
  ...overrides,
});

test("external results are suppressed only for a confidently matching local recording", () => {
  const results = uniqueExternalResults([localTrack({ title: "Café—Lights" })], [
    recording("same", { title: "Cafe Lights" }),
    recording("different-edition", { album: "Rooms in Blue (Deluxe)" }),
    recording("different-duration", { durationSec: 184 }),
    recording("unknown-duration", { durationSec: null }),
    recording("unknown-album", { album: null }),
    recording("different-artist", { artist: "Another Artist" }),
  ]);

  assert.deepEqual(results.map((item) => item.id), [
    "different-edition",
    "different-duration",
    "unknown-duration",
    "different-artist",
  ]);
});

test("records without a matching local track remain visible", () => {
  const nonTrack: PlayerItem = { id: "artist", title: "Cafe Lights", type: "artist", artist: "The Paper Moons" };
  assert.deepEqual(uniqueExternalResults([nonTrack], [recording("external")]).map((item) => item.id), ["external"]);
});

test("a linked library recording wins even when catalog release or duration metadata differs", () => {
  const linked = recording("linked", { album: "A compilation", durationSec: null,
    existing: { id: "local-track", recordingId: "linked", stage: "ready", error: null, detail: null, playable: true } });
  assert.deepEqual(uniqueExternalResults([localTrack()], [linked]), []);
  assert.equal(uniqueExternalResults([localTrack()], [{ ...linked, title: "Cafe Lights (Live)" }]).length, 1);
  assert.equal(uniqueExternalResults([localTrack()], [{ ...linked, durationSec: 240 }]).length, 1);
});

test("repeated catalog IDs prefer the playable entry without collapsing distinct recording IDs", () => {
  const missing = recording("same", { durationSec: null });
  const playable = recording("same", { durationSec: null,
    existing: { id: "local-track", recordingId: "same", stage: "ready", error: null, detail: null, playable: true } });
  assert.deepEqual(uniqueExternalResults([], [missing, playable, recording("another", { durationSec: null })]),
    [playable, recording("another", { durationSec: null })]);
});

test("stale or cancelled search responses are rejected", () => {
  assert.equal(searchResponseIsCurrent("quiet orbit", "quiet orbit", false), true);
  assert.equal(searchResponseIsCurrent("quiet orbit", "late windows", false), false);
  assert.equal(searchResponseIsCurrent("quiet orbit", "quiet orbit", true), false);
});

test("top result follows title relevance rather than always preferring an artist", () => {
  const artist: PlayerItem = { id: "artist", type: "artist", title: "The Paper Moons" };
  const album: PlayerItem = { id: "album", type: "album", title: "Rooms in Blue", artist: artist.title };
  const song = localTrack();
  assert.equal(topSearchResult("café lights", [artist, album, localTrack({ id: "other", title: "Cafe Lights (Live)" }), song]), song);
  assert.equal(topSearchResult("the paper moons", [song, album, artist]), artist);
  assert.equal(topSearchResult("rooms in blue", [song, artist, album]), album);
  assert.equal(topSearchResult("lights cafe", [artist, album, song]), song);
  assert.equal(topSearchResult("", [song, artist]), null);
  assert.equal(topSearchResult("no results", []), null);
});

test("an exact wider-catalog song outranks library metadata matches but tied library songs win", () => {
  const library = { type: "track" as const, title: "Night Drive", artist: "Quiet Orbit", source: "library" };
  const artist = { type: "artist" as const, title: "Quiet Orbit Ensemble", source: "library" };
  const external = { type: "track" as const, title: "Quiet Orbit", artist: "The Paper Moons", source: "recording" };
  assert.equal(topSearchResult("quiet orbit", [artist, library, external]), external);
  const playable = { ...external, source: "library" };
  assert.equal(topSearchResult("quiet orbit", [playable, external]), playable);
});

test("returned recordings stay in More songs until the external top is rendered", () => {
  const featured = recording("featured"), other = recording("other");
  const returned = [featured, other];
  assert.deepEqual(recordingsOutsideTop(returned, featured, false), returned);
  assert.deepEqual(recordingsOutsideTop(returned, featured, true), [other]);
  assert.deepEqual(recordingsOutsideTop([featured], featured, false), [featured]);
  assert.deepEqual(recordingsOutsideTop([featured], featured, true), []);
  assert.deepEqual(recordingsOutsideTop(returned, null, true), returned);
});
