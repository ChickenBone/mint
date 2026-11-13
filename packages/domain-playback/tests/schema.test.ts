import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { historyPreferences, listeningHistory, playbackSchema } from "../src/schema";

test("playback history tables expose only account-owned events and privacy state", () => {
  assert.equal(playbackSchema.schemaName, "playback");
  assert.equal(getTableName(historyPreferences), "history_preferences");
  assert.equal(getTableName(listeningHistory), "listening_history");
  assert.deepEqual(Object.keys(getTableColumns(listeningHistory)).sort(), [
    "completed", "createdAt", "eventId", "id", "listenedMs", "mediaFileId", "userId",
  ]);
  assert.deepEqual(Object.keys(getTableColumns(historyPreferences)).sort(), [
    "historyAfter", "privateSession", "userId",
  ]);
});
