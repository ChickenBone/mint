import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogCoverage, SearchRequestView } from "@mint/client";
import {
  activeSearchRequest, canCancelSearchRequest, canRetrySearchRequest, catalogArtistItems, isCurrentSearch,
  recordingRequestInput, searchRequestStatusLabel, shouldOfferSearchRequest, topSearchResult, uniqueRecordings,
} from "../src/features/search/search-model";

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

test("native search uses exact links without hiding conflicting versions", () => {
  const local = [{ id: "local", type: "track" as const, title: "Écho", artist: "A Band", album: "First", duration: 180000 }];
  const linked = { id: "recording", title: "Echo", artist: "A Band", album: null, durationSec: null,
    existing: { id: "local", recordingId: "recording", playable: true } };
  assert.deepEqual(uniqueRecordings(local, [linked]), [], "Missing album and duration do not defeat an exact link.");
  assert.deepEqual(uniqueRecordings([{ ...local[0]!, album: undefined, duration: undefined }],
    [{ ...linked, album: "First", durationSec: 180 }]), [], "Incomplete library metadata also keeps a valid link.");
  assert.deepEqual(uniqueRecordings(local, [{ ...linked, album: "Compilation", durationSec: 182.5 }]), [],
    "An exact link may appear on a compilation and tolerate small duration differences.");
  assert.equal(uniqueRecordings(local, [{ ...linked, title: "Echo (Live)" }]).length, 1,
    "A title/version conflict remains visible.");
  assert.equal(uniqueRecordings(local, [{ ...linked, durationSec: 183 }]).length, 1,
    "A duration conflict remains visible.");
  assert.equal(uniqueRecordings(local, [{ ...linked, artist: "Another Band" }]).length, 1,
    "A conflicting artist remains visible.");
  assert.equal(uniqueRecordings(local, [{ ...linked, album: "First", durationSec: 180,
    existing: { ...linked.existing, recordingId: "different-recording" } }]).length, 1,
    "An explicit recording-ID conflict must not be hidden by a matching title and duration.");
  assert.equal(uniqueRecordings(local, [{ ...linked, existing: { id: "another", recordingId: "recording", playable: true } }]).length, 1);
  assert.deepEqual(uniqueRecordings(local, [{ ...linked,
    existing: { id: "local", recordingId: null, playable: true } }]), [],
    "The existing local-track link works when recording metadata is incomplete.");
});

test("native search deduplicates repeated catalog IDs and prefers the playable copy", () => {
  const missing = { id: "same", title: "Echo", artist: "A Band", album: "First", durationSec: null };
  const playable = { ...missing, existing: { id: "local", playable: true } };
  assert.deepEqual(uniqueRecordings([], [missing, playable, { ...missing, id: "different" }]),
    [playable, { ...missing, id: "different" }]);
});

test("top search result follows relevance across local songs, albums, artists and catalog recordings", () => {
  const artist = { id: "artist", type: "artist" as const, title: "Echoes" };
  const song = { id: "song", type: "track" as const, title: "Écho", artist: "A Band" };
  const album = { id: "album", type: "album" as const, title: "First", artist: "A Band" };
  const recording = {
    key: "catalog", source: "musicbrainz", kind: "song" as const, title: "Blue Moon", artist: "A Band", album: null,
    genres: [], popularity: null, updatedAt: null, matched: true, recording: null,
  };
  const library = [artist, song, album];
  assert.deepEqual(topSearchResult("Echo", library, [], []), { source: "library", item: song });
  assert.deepEqual(topSearchResult("Echoes", library, [], []), { source: "library", item: artist });
  assert.deepEqual(topSearchResult("A Band First", library, [], []), { source: "library", item: album });
  assert.deepEqual(topSearchResult("blue moon", library, [], [recording]), { source: "catalog", row: recording });
  assert.deepEqual(topSearchResult("blue moon", [], [], [recording]), { source: "catalog", row: recording },
    "A catalog result remains available while the independent library search is pending.");
  assert.equal(topSearchResult("blue moon", [], [], [{ ...recording, matched: false }]), null);
  assert.equal(topSearchResult("unrelated", library, [], []), null);
  assert.equal(topSearchResult("!!!", library, [], [recording]), null);
  assert.deepEqual(topSearchResult("Echo", [song], [], [{ ...recording, title: "Echo" }]),
    { source: "library", item: song }, "An equally relevant playable library item wins.");
});

test("catalog artists are deduplicated against local names and each other", () => {
  const local = [{ id: "local", type: "artist" as const, title: "Beyoncé" }];
  assert.deepEqual(catalogArtistItems(local, [
    { id: "a", name: "Beyonce" }, { id: "b", name: "A Band" }, { id: "c", name: "a-band" },
  ]), [{ id: "b", type: "artist", title: "A Band" }]);
});

const searchRequest = (overrides: Partial<SearchRequestView> = {}): SearchRequestView => ({
  id: "00000000-0000-4000-8000-000000000001",
  query: "blue moon",
  status: "active",
  enrichmentStatus: "queued",
  musicBrainzRecordingId: null,
  trackId: null,
  track: null,
  createdAt: "2026-11-10T12:00:00.000Z",
  updatedAt: "2026-11-10T12:00:00.000Z",
  closedAt: null,
  ...overrides,
});

test("no-match intent is offered only after the catalog answered with no matched recording", () => {
  const ready = {
    query: "  Blue Moon ",
    current: true,
    localReady: true,
    localError: false,
    localRecordingCount: 0,
    recordingsReady: true,
    recordingsError: false,
    recordingCount: 0,
    catalogStatus: "ok" as CatalogCoverage["status"] | null,
    hasActiveRequest: false,
  };
  assert.equal(shouldOfferSearchRequest(ready), true);
  assert.equal(shouldOfferSearchRequest({ ...ready, catalogStatus: "lexical-only" }), true);
  assert.equal(shouldOfferSearchRequest({ ...ready, catalogStatus: "unavailable" }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, catalogStatus: "not_configured" }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, catalogStatus: null }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, query: "x" }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, current: false }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, localReady: false }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, localError: true }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, localRecordingCount: 1 }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, recordingsReady: false }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, recordingsError: true }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, recordingCount: 1 }), false);
  assert.equal(shouldOfferSearchRequest({ ...ready, hasActiveRequest: true }), false);
});

test("search intent states remain distinct and playable requires the linked playable contract", () => {
  assert.equal(searchRequestStatusLabel(searchRequest()), "Checking metadata");
  assert.equal(searchRequestStatusLabel(searchRequest({ enrichmentStatus: "running" })), "Checking metadata");
  assert.equal(searchRequestStatusLabel(searchRequest({ enrichmentStatus: "complete" })), "Metadata match found · not playable");
  assert.equal(searchRequestStatusLabel(searchRequest({ enrichmentStatus: "not_found" })), "Not found in the catalog");
  assert.equal(searchRequestStatusLabel(searchRequest({ enrichmentStatus: "ambiguous" })), "Ambiguous · needs a choice");
  assert.equal(searchRequestStatusLabel(searchRequest({ enrichmentStatus: "failed" })), "Catalog check failed · try again");
  assert.equal(searchRequestStatusLabel(searchRequest({ trackId: "00000000-0000-4000-8000-000000000002",
    track: { stage: "downloading", playable: false } })), "Requested · downloading");
  assert.equal(searchRequestStatusLabel(searchRequest({ trackId: "00000000-0000-4000-8000-000000000002",
    track: { stage: "ready", playable: false } })), "Requested · not playable yet");
  assert.equal(searchRequestStatusLabel(searchRequest({ trackId: "00000000-0000-4000-8000-000000000002",
    track: { stage: "failed", playable: false } })), "Requested · processing failed");
  assert.equal(searchRequestStatusLabel(searchRequest({ trackId: "00000000-0000-4000-8000-000000000002",
    track: { stage: "ready", playable: true } })), "Playable · in your library");
  assert.equal(searchRequestStatusLabel(searchRequest({ status: "cancelled" })), "Cancelled");
});

test("retry and cancel are limited to active unlinked requests; active normalized queries link", () => {
  assert.equal(canRetrySearchRequest(searchRequest({ enrichmentStatus: "not_found" })), true);
  assert.equal(canRetrySearchRequest(searchRequest({ enrichmentStatus: "failed" })), true);
  assert.equal(canRetrySearchRequest(searchRequest({ enrichmentStatus: "ambiguous" })), true);
  assert.equal(canRetrySearchRequest(searchRequest({ enrichmentStatus: "running" })), false);
  assert.equal(canRetrySearchRequest(searchRequest({ enrichmentStatus: "complete" })), false);
  assert.equal(canRetrySearchRequest(searchRequest({ trackId: "00000000-0000-4000-8000-000000000002",
    track: { stage: "downloading", playable: false }, enrichmentStatus: "failed" })), false);
  assert.equal(canCancelSearchRequest(searchRequest()), true);
  assert.equal(canCancelSearchRequest(searchRequest({ status: "closed" })), false);
  assert.equal(canCancelSearchRequest(searchRequest({ status: "cancelled" })), false);
  assert.equal(canCancelSearchRequest(searchRequest({ trackId: "00000000-0000-4000-8000-000000000002",
    track: { stage: "queued", playable: false } })), false);
  const active = searchRequest({ query: "Blúe-Moon" });
  assert.equal(activeSearchRequest([searchRequest({ status: "closed" }), active], "blue moon")?.id, active.id);
  assert.equal(activeSearchRequest([searchRequest({ status: "cancelled" })], "blue moon"), null);
  assert.deepEqual(recordingRequestInput("signed-token", [active], "blue moon"), {
    token: "signed-token", searchRequestId: active.id,
  });
  assert.deepEqual(recordingRequestInput("signed-token", [searchRequest({ status: "closed" })], "blue moon"), {
    token: "signed-token",
  });
});
