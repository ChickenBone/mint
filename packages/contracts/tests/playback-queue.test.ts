import assert from "node:assert/strict";
import { test } from "node:test";
import {
  playbackQueueEditInputSchema,
  playbackQueueOpenInputSchema,
  playbackQueuePageSchema,
} from "../src/index";

const queueId = "12345678-1234-4234-8234-123456789012";
const mediaFileId = "12345678-1234-4234-8234-123456789013";
const firstOccurrence = "12345678-1234-4234-8234-123456789014";
const secondOccurrence = "12345678-1234-4234-8234-123456789015";

test("queue selections support frozen library searches and duplicate explicit occurrences", () => {
  assert.equal(playbackQueueOpenInputSchema.safeParse({
    selection: { source: "library", search: "Cafe Ensemble" },
    shuffle: true,
    current: { mediaFileId },
  }).success, true);
  assert.equal(playbackQueueOpenInputSchema.safeParse({
    selection: {
      source: "items",
      items: [
        { mediaFileId, occurrenceId: firstOccurrence },
        { mediaFileId, occurrenceId: secondOccurrence },
      ],
    },
    shuffle: false,
    current: { mediaFileId, occurrenceId: secondOccurrence },
  }).success, true);
  assert.equal(playbackQueueOpenInputSchema.safeParse({
    selection: { source: "items", items: [{ mediaFileId }] },
    shuffle: false,
    current: { mediaFileId: queueId },
  }).success, false);
  assert.equal(playbackQueueOpenInputSchema.safeParse({
    selection: { source: "items", items: Array(5001).fill({ mediaFileId }) },
    shuffle: false,
  }).success, false);
  assert.equal(playbackQueueOpenInputSchema.safeParse({
    selection: { source: "spotify", id: queueId },
    shuffle: false,
  }).success, false);
  assert.equal(playbackQueueOpenInputSchema.safeParse({
    selection: { source: "library", search: "\0" },
    shuffle: false,
  }).success, false);
});

test("queue edit inputs are revisioned, occurrence-addressed, and bounded", () => {
  assert.equal(playbackQueueEditInputSchema.safeParse({
    revision: 1,
    currentEntryId: queueId,
    edit: {
      action: "append",
      selection: { source: "items", items: [{ mediaFileId }, { mediaFileId }] },
      next: true,
    },
  }).success, true);
  assert.equal(playbackQueueEditInputSchema.safeParse({
    revision: 1,
    currentEntryId: queueId,
    edit: { action: "append-collection", collection: { kind: "playlist", id: queueId }, next: true },
  }).success, false);
  assert.equal(playbackQueueEditInputSchema.safeParse({
    revision: 0,
    currentEntryId: queueId,
    edit: { action: "clear" },
  }).success, false);
});

test("queue pages cap hydration and validate snapshot ranges", () => {
  const context = { id: queueId, total: 1_000_000, revision: 1, offset: 0, position: 0, shuffle: false };
  const item = {
    id: mediaFileId, recordingId: null, title: "Track", artist: "Artist",
    album: "Album", version: null, durationMs: 180_000, queueId: secondOccurrence,
  };
  assert.equal(playbackQueuePageSchema.safeParse({ context, items: [item] }).success, true);
  assert.equal(playbackQueuePageSchema.safeParse({ context, items: Array(101).fill(item) }).success, false);
  assert.equal(playbackQueuePageSchema.safeParse({
    context: { ...context, total: 1, offset: 1 }, items: [item],
  }).success, false);
});
