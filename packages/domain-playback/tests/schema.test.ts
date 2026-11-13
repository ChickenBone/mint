import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
  historyPreferences, listeningHistory, playbackSchema, queueEntries, queueSnapshots,
} from "../src/schema";

test("playback tables expose account-owned history and durable queue occurrences", () => {
  assert.equal(playbackSchema.schemaName, "playback");
  assert.equal(getTableName(historyPreferences), "history_preferences");
  assert.equal(getTableName(listeningHistory), "listening_history");
  assert.equal(getTableName(queueSnapshots), "queue_snapshots");
  assert.equal(getTableName(queueEntries), "queue_entries");
  assert.deepEqual(Object.keys(getTableColumns(listeningHistory)).sort(), [
    "completed", "createdAt", "eventId", "id", "listenedMs", "mediaFileId", "userId",
  ]);
  assert.deepEqual(Object.keys(getTableColumns(historyPreferences)).sort(), [
    "historyAfter", "privateSession", "userId",
  ]);
  assert.deepEqual(Object.keys(getTableColumns(queueSnapshots)).sort(), [
    "createdAt", "expiresAt", "id", "revision", "shuffled", "total", "userId",
  ]);
  assert.deepEqual(Object.keys(getTableColumns(queueEntries)).sort(), [
    "id", "mediaFileId", "originalPosition", "position", "queueId", "sourceOccurrenceId",
  ]);
});
