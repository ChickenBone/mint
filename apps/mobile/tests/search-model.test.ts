import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentSearch, uniqueRecordings } from "../src/features/search/search-model";

test("search ignores stale and aborted responses", () => {
  assert.equal(isCurrentSearch("old", "new"), false);
  assert.equal(isCurrentSearch("same", "same", true), false);
  assert.equal(isCurrentSearch("same", "same"), true);
});

test("mixed search suppresses only conservatively confirmed recordings", () => {
  const local = [{ id: "local", type: "track" as const, title: "Écho", artist: "A Band", album: "First", duration: 180000 }];
  const matches = [
    { id: "same", title: "Echo", artist: "A Band", album: "First", durationSec: 180 },
    { id: "live", title: "Echo", artist: "A Band", album: "Live", durationSec: 180 },
    { id: "unknown", title: "Echo", artist: "A Band", album: "First", durationSec: null },
    { id: "long", title: "Echo", artist: "A Band", album: "First", durationSec: 240 },
  ];
  assert.deepEqual(uniqueRecordings(local, matches).map((item) => item.id), ["live", "unknown", "long"]);
});

test("native search hides catalog copies linked to the displayed library track", () => {
  const local = [{ id: "local", type: "track" as const, title: "Écho", artist: "A Band", album: "First" }];
  const linked = { id: "recording", title: "Echo", artist: "A Band", album: "Compilation", durationSec: null,
    existing: { id: "local", playable: true } };
  assert.deepEqual(uniqueRecordings(local, [linked]), []);
  assert.equal(uniqueRecordings(local, [{ ...linked, title: "Echo (Live)" }]).length, 1);
  assert.equal(uniqueRecordings(local, [{ ...linked, existing: { id: "another", playable: true } }]).length, 1);
});

test("native search deduplicates repeated catalog IDs and prefers the playable copy", () => {
  const missing = { id: "same", title: "Echo", artist: "A Band", album: "First", durationSec: null };
  const playable = { ...missing, existing: { id: "local", playable: true } };
  assert.deepEqual(uniqueRecordings([], [missing, playable, { ...missing, id: "different" }]),
    [playable, { ...missing, id: "different" }]);
});
