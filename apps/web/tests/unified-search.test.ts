import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingSearchItem } from "../src/lib/music-requests";
import type { PlayerItem } from "../src/lib/player-protocol";
import { searchResponseIsCurrent, uniqueExternalResults } from "../src/lib/unified-search";

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

test("stale or cancelled search responses are rejected", () => {
  assert.equal(searchResponseIsCurrent("quiet orbit", "quiet orbit", false), true);
  assert.equal(searchResponseIsCurrent("quiet orbit", "late windows", false), false);
  assert.equal(searchResponseIsCurrent("quiet orbit", "quiet orbit", true), false);
});
