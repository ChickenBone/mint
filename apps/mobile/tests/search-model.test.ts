import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogCoverage, SearchRequestView } from "@mint/client";
import {
  activeSearchRequest, canCancelSearchRequest, canRetrySearchRequest, isCurrentSearch, searchRequestStatusLabel,
  recordingRequestInput, shouldOfferSearchRequest, uniqueRecordings,
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
