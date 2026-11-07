import assert from "node:assert/strict";
import test from "node:test";
import { reorderedEntries } from "../src/features/playlists/collection-model";

test("playlist reorder retains duplicate song occurrences without mutating input", () => {
  const original = ["song-a-first", "song-b", "song-a-second"];
  assert.deepEqual(reorderedEntries(original, "song-a-second", -1), ["song-a-first", "song-a-second", "song-b"]);
  assert.deepEqual(original, ["song-a-first", "song-b", "song-a-second"]);
  assert.throws(() => reorderedEntries(original, "missing", 1), /Reload/);
  assert.throws(() => reorderedEntries(original, "song-a-first", -1), /Reload/);
  assert.throws(() => reorderedEntries(["same", "same"], "same", 1), /Reload/);
});
