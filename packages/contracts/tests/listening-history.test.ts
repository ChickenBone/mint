import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listeningHistoryDeleteInputSchema, listeningHistoryListInputSchema,
  listeningHistoryPageSchema, listeningHistoryPrivateSessionInputSchema,
  listeningHistoryRecordInputSchema,
} from "../src/index";

const id = "00000000-0000-4000-8000-000000000001";
const track = {
  id, recordingId: null, title: "Fixture", artist: "Fixture artist",
  album: "Fixture album", version: null, durationMs: 120_000,
};
const page = {
  entries: [{
    event: { id, createdAt: "2025-01-01T00:00:00.000Z", listenedMs: 90_000, completed: true },
    track,
  }],
};

test("listening history contracts bound playback and history inputs", () => {
  assert.deepEqual(listeningHistoryRecordInputSchema.parse({
    eventId: id, mediaFileId: id, listenedMs: 1000,
  }), { eventId: id, mediaFileId: id, listenedMs: 1000, completed: false });
  assert.ok(listeningHistoryListInputSchema.safeParse({ page: 10_000 }).success);
  assert.ok(listeningHistoryDeleteInputSchema.safeParse({}).success);
  assert.ok(listeningHistoryPrivateSessionInputSchema.safeParse({ privateSession: true }).success);
  for (const invalid of [
    { eventId: id, mediaFileId: id, listenedMs: -1 },
    { eventId: id, mediaFileId: id, listenedMs: 86_400_001 },
    { eventId: id, mediaFileId: id, listenedMs: 1.5 },
    { eventId: id, mediaFileId: id, listenedMs: 1000, unknown: true },
    { page: -1 }, { page: 1.5 }, { page: 10_001 }, { page: "0" },
    { entryId: "" }, { privateSession: true, userId: id },
  ]) {
    const schema = "mediaFileId" in invalid ? listeningHistoryRecordInputSchema
      : "page" in invalid ? listeningHistoryListInputSchema
        : "entryId" in invalid ? listeningHistoryDeleteInputSchema
          : listeningHistoryPrivateSessionInputSchema;
    assert.equal(schema.safeParse(invalid).success, false);
  }
});

test("history page output is bounded and excludes unrelated account or filesystem data", () => {
  assert.ok(listeningHistoryPageSchema.safeParse(page).success);
  for (const invalid of [
    { entries: Array.from({ length: 102 }, () => page.entries[0]) },
    { entries: [{ ...page.entries[0]!, userId: id }] },
    { entries: [{ ...page.entries[0]!, track: { ...track, relativePath: "/private/file.flac" } }] },
    { entries: [{ ...page.entries[0]!, event: { ...page.entries[0]!.event, listenedMs: 86_400_001 } }] },
  ]) {
    assert.equal(listeningHistoryPageSchema.safeParse(invalid).success, false);
  }
});
