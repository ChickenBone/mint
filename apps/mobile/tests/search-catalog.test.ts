import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { CatalogCoverage, CatalogResult, RecordingSearchItem } from "@mint/client";
import {
  catalogEmptyMessage, catalogNotes, catalogProvenance, catalogSourceLabel, catalogState, catalogSubtitle, catalogText,
  catalogUnavailableMessage, formatFreshness, popularityLabel, recordingActionLabel, recordingLibraryLabel,
  searchRequestCopy, splitCatalogResults, visibleCatalogResults,
} from "../src/features/search/search-model";

const now = Date.parse("2026-11-10T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(now - ms).toISOString();

const recording = (overrides: Partial<RecordingSearchItem> = {}): RecordingSearchItem => ({
  id: "00000000-0000-4000-8000-0000000000a1", title: "Echo", artist: "A Band", album: "First", durationSec: null,
  token: "signed-token", existing: null, ...overrides,
});
const row = (overrides: Partial<CatalogResult> = {}): CatalogResult => ({
  key: "musicbrainz:a1", source: "musicbrainz", kind: "song", title: "Echo", artist: "A Band", album: "First", genres: [],
  popularity: null, updatedAt: null, matched: true, recording: recording(), ...overrides,
});
const coverage = (overrides: Partial<CatalogCoverage> = {}): CatalogCoverage => ({
  status: "ok", mode: "hybrid", relevance: "matched", hasMore: false, retryAfterSeconds: null, ...overrides,
});

test("catalog states separate not configured, unavailable, empty, matched and nearest-only answers", () => {
  const rows = [row()];
  assert.equal(catalogState(coverage({ status: "not_configured", mode: null, relevance: "empty" }), []), "not-configured");
  assert.equal(catalogState(coverage({ status: "unavailable", mode: null, relevance: "empty", retryAfterSeconds: 5 }), []), "unavailable");
  assert.equal(catalogState(coverage({ status: "unavailable", relevance: "matched" }), rows), "unavailable");
  assert.equal(catalogState(coverage({ relevance: "empty" }), []), "empty");
  assert.equal(catalogState(coverage({ relevance: "empty" }), [], 2), "in-library");
  assert.equal(catalogState(coverage(), rows), "matched");
  assert.equal(catalogState(coverage({ status: "lexical-only", mode: "lexical" }), rows), "matched");
  const neighbours = [row({ matched: false }), row({ key: "apple:2", source: "apple", matched: false, recording: null })];
  assert.equal(catalogState(coverage({ relevance: "related-only" }), neighbours), "related-only");
  assert.equal(catalogState(coverage({ status: "lexical-only", mode: "lexical", relevance: "related-only" }), neighbours), "related-only");
});

test("a matched row hidden as a library duplicate never becomes a claim that nothing matched", () => {
  const neighbours = [row({ matched: false })];
  assert.equal(catalogState(coverage({ relevance: "matched" }), neighbours, 1), "matched");
  assert.equal(catalogState(coverage({ relevance: "related-only" }), neighbours, 1), "related-only");
});

test("catalog rows hide only confirmed library duplicates and keep the server order", () => {
  const local = [{ id: "local", type: "track" as const, title: "Écho", artist: "A Band", album: "First", duration: 180000 }];
  const duplicate = row({ key: "dup", recording: recording({ durationSec: 180 }) });
  const unknownLength = row({ key: "unknown", recording: recording({ id: "00000000-0000-4000-8000-0000000000a2" }) });
  const displayOnly = row({ key: "apple", source: "apple", recording: null });
  const shown = visibleCatalogResults(local, [displayOnly, duplicate, unknownLength]);
  assert.deepEqual(shown.rows.map((item) => item.key), ["apple", "unknown"]);
  assert.equal(shown.hiddenCount, 1);
  assert.deepEqual(visibleCatalogResults([], [duplicate, displayOnly]).rows.map((item) => item.key), ["dup", "apple"]);
  assert.equal(visibleCatalogResults([], []).hiddenCount, 0);
});

test("matched and related rows keep server order and are never ranked by popularity", () => {
  const popular = { score: 99, basis: "catalog-derived" as const, observedAt: null };
  const rows = [
    row({ key: "m1", popularity: null }),
    row({ key: "r1", matched: false, popularity: popular }),
    row({ key: "m2", popularity: { ...popular, score: 1 } }),
    row({ key: "r2", matched: false, popularity: null }),
  ];
  const { matched, related } = splitCatalogResults(rows);
  assert.deepEqual(matched.map((item) => item.key), ["m1", "m2"]);
  assert.deepEqual(related.map((item) => item.key), ["r1", "r2"]);
});

test("known catalog sources get readable names and unknown sources are shown as received", () => {
  assert.equal(catalogSourceLabel("musicbrainz"), "MusicBrainz");
  assert.equal(catalogSourceLabel("apple"), "Apple Music");
  assert.equal(catalogSourceLabel("ytmusic"), "YouTube Music");
  assert.equal(catalogSourceLabel("somethingnew"), "somethingnew");
  for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal(catalogSourceLabel(inherited), inherited);
});

test("freshness is relative to the supplied time and never guesses an unknown date", () => {
  assert.equal(formatFreshness(null, now), "Update date unknown");
  assert.equal(formatFreshness("not a date", now), "Update date unknown");
  assert.equal(formatFreshness("", now), "Update date unknown");
  assert.equal(formatFreshness(ago(-2 * DAY), now), "Update date unknown");
  assert.equal(formatFreshness(ago(-HOUR), now), "Updated just now");
  assert.equal(formatFreshness(ago(30_000), now), "Updated just now");
  assert.equal(formatFreshness(ago(MINUTE), now), "Updated 1 minute ago");
  assert.equal(formatFreshness(ago(59 * MINUTE), now), "Updated 59 minutes ago");
  assert.equal(formatFreshness(ago(HOUR), now), "Updated 1 hour ago");
  assert.equal(formatFreshness(ago(23 * HOUR + 59 * MINUTE), now), "Updated 23 hours ago");
  assert.equal(formatFreshness(ago(DAY), now), "Updated 1 day ago");
  assert.equal(formatFreshness(ago(3 * DAY), now), "Updated 3 days ago");
  assert.equal(formatFreshness(ago(29 * DAY), now), "Updated 29 days ago");
  assert.equal(formatFreshness(ago(30 * DAY), now), "Updated 1 month ago");
  assert.equal(formatFreshness(ago(60 * DAY), now), "Updated 2 months ago");
  assert.equal(formatFreshness(ago(364 * DAY), now), "Updated 11 months ago");
  assert.equal(formatFreshness(ago(365 * DAY), now), "Updated 1 year ago");
  assert.equal(formatFreshness(ago(800 * DAY), now), "Updated 2 years ago");
  assert.equal(formatFreshness("2026-11-07", now), "Updated 3 days ago");
});

test("provenance names the source and freshness for each row", () => {
  assert.equal(catalogProvenance({ source: "apple", updatedAt: ago(3 * DAY) }, now), "Apple Music · Updated 3 days ago");
  assert.equal(catalogProvenance({ source: "musicbrainz", updatedAt: null }, now), "MusicBrainz · Update date unknown");
});

test("popularity is attributed and dated, never a number, a play count, or zero", () => {
  assert.equal(popularityLabel(null), null);
  assert.equal(popularityLabel({ score: 87.5, basis: "catalog-derived", observedAt: "2026-03-05T10:00:00.000Z" }), "Popular in the catalog · as of Mar 5, 2026");
  assert.equal(popularityLabel({ score: 0.2, basis: "catalog-derived", observedAt: null }), "Popular in the catalog");
  assert.equal(popularityLabel({ score: 0.2, basis: "catalog-derived", observedAt: "sometime" }), "Popular in the catalog");
  const label = popularityLabel({ score: 87.5, basis: "catalog-derived", observedAt: "2026-12-31T23:59:59.000Z" }) ?? "";
  assert.match(label, /Dec 31, 2026$/);
  assert.doesNotMatch(label, /87|play|listen/i);
});

test("row subtitles tolerate missing artists and albums", () => {
  assert.equal(catalogSubtitle({ artist: "A Band", album: "First" }), "A Band · First");
  assert.equal(catalogSubtitle({ artist: "A Band", album: null }), "A Band");
  assert.equal(catalogSubtitle({ artist: "A Band", album: "  " }), "A Band");
  assert.equal(catalogSubtitle({ artist: "", album: "First" }), "Unknown artist · First");
  assert.equal(catalogSubtitle({ artist: "  ", album: null }), "Unknown artist");
});

test("library state keeps the existing wording and a playable library copy always wins", () => {
  const held = (playable: boolean, stage = "ready") => recording({
    existing: { id: "00000000-0000-4000-8000-0000000000b1", recordingId: null, stage, error: null, detail: null, playable },
  });
  assert.equal(recordingLibraryLabel(recording()), "Not in your library");
  assert.equal(recordingLibraryLabel(held(true)), "In your library");
  assert.equal(recordingLibraryLabel(held(true), "queued"), "In your library");
  assert.equal(recordingLibraryLabel(held(false, "downloading")), "Not ready · downloading");
  assert.equal(recordingLibraryLabel(recording(), "queued"), "Requested · Available once ready");
  assert.equal(recordingLibraryLabel(recording(), "ready"), "In your library · Refresh results to play");
  assert.equal(recordingLibraryLabel(held(false, "failed"), "queued"), "Requested · Available once ready");
});

test("row actions are named for their song and start with the visible label", () => {
  assert.equal(recordingActionLabel("Add to library", recording()), "Add to library: Echo by A Band");
  assert.equal(recordingActionLabel("Play", recording({ artist: "  " })), "Play: Echo");
  assert.equal(recordingActionLabel("Requested", recording({ artist: " A Band " })), "Requested: Echo by A Band");
});

test("an unavailable catalog says library search still works and mentions the wait only when known", () => {
  assert.equal(catalogUnavailableMessage(null), "Searching your library still works. Try again in a moment.");
  assert.equal(catalogUnavailableMessage(1), "Searching your library still works. Try again in about 1 second.");
  assert.equal(catalogUnavailableMessage(30), "Searching your library still works. Try again in about 30 seconds.");
});

test("empty copy distinguishes nothing matched from everything already being in the library", () => {
  assert.equal(catalogEmptyMessage("empty", "blue moon"), "No songs in the catalog matched “blue moon”.");
  assert.equal(catalogEmptyMessage("in-library", "blue moon"), "Everything the catalog returned is already in your library above.");
  for (const state of ["matched", "related-only", "not-configured", "unavailable"] as const) assert.equal(catalogEmptyMessage(state, "blue moon"), null);
});

test("coverage notes are honest for every answered state and absent when the catalog did not answer", () => {
  assert.deepEqual(catalogNotes(coverage(), "matched"), { intro: [catalogText.coverage], footer: [catalogText.audio] });
  assert.deepEqual(catalogNotes(coverage({ hasMore: true }), "matched"), { intro: [catalogText.coverage], footer: [catalogText.hasMore, catalogText.audio] });
  assert.deepEqual(catalogNotes(coverage({ status: "lexical-only", mode: "lexical", relevance: "related-only" }), "related-only"),
    { intro: [catalogText.coverage, catalogText.lexical], footer: [catalogText.audio] });
  assert.deepEqual(catalogNotes(coverage({ relevance: "empty", hasMore: true }), "empty"), { intro: [catalogText.coverage], footer: [] });
  assert.deepEqual(catalogNotes(coverage({ relevance: "empty" }), "in-library"), { intro: [catalogText.coverage], footer: [] });
  assert.deepEqual(catalogNotes(coverage({ status: "unavailable", mode: null }), "unavailable"), { intro: [], footer: [] });
  assert.deepEqual(catalogNotes(coverage({ status: "not_configured", mode: null }), "not-configured"), { intro: [], footer: [] });
});

test("catalog copy states its limits, never promises downloads, and does not call the catalog MusicBrainz", () => {
  assert.match(catalogText.coverage, /may not include every song/);
  assert.match(catalogText.coverage, /out of date/);
  assert.match(catalogText.coverage, /authorized/);
  assert.match(catalogText.shortQuery, /at least two characters/);
  assert.match(catalogText.audio, /never downloads or plays audio/);
  assert.match(catalogText.audio, /Identity unconfirmed/);
  assert.equal(catalogText.closestTitle, "Closest in the catalog");
  assert.match(catalogText.closest, /Nothing matched exactly/);
  assert.match(catalogText.notConfigured, /no music catalog configured/);
  assert.match(catalogText.notConfigured, /only your library/);
  assert.equal(catalogText.unavailableTitle, "The music catalog is unavailable right now");
  assert.doesNotMatch(Object.values(catalogText).join("\n"), /MusicBrainz/);
});

test("saved-request copy says the check uses the metadata catalog and never downloads or plays audio", () => {
  for (const copy of [searchRequestCopy.offer, searchRequestCopy.panel]) {
    assert.match(copy, /metadata catalog/);
    assert.match(copy, /download or play audio/);
    assert.match(copy, /identified/);
  }
  assert.match(searchRequestCopy.offer, /Add to library/);
  assert.doesNotMatch(`${searchRequestCopy.offer} ${searchRequestCopy.panel}`, /MusicBrainz|provider/i);
});

test("the Search screen wires the catalog contract, keeps explicit acquisition and the web cancel confirmation", () => {
  const dir = resolve(import.meta.dirname, "../src/features/search");
  const read = (file: string) => readFileSync(resolve(dir, file), "utf8");
  const screen = read("SearchScreen.tsx");
  assert.match(screen, /catalogStatus: answered\?\.result\.catalog\.status/);
  assert.match(screen, /<CatalogResults/);
  assert.match(screen, /visibleCatalogResults\(/);
  assert.equal((screen.match(/accessibilityLabel=\{recordingActionLabel\(/g) ?? []).length, 1);
  assert.match(screen, /<CatalogRecordingActions /, "Unimported catalog songs offer like-and-import plus import-only.");
  assert.match(screen, /Platform\.OS === "web"/);
  assert.match(screen, /globalThis\.confirm/);
  assert.doesNotMatch(screen, /wider catalog|Recording metadata from MusicBrainz|Save search request/);
  const results = read("CatalogResults.tsx");
  assert.doesNotMatch(results, /requestRecording|searchRecordings/, "Acquisition and search calls stay in the screen.");
  assert.doesNotMatch(results, /\.sort\(|toSorted\(/, "Catalog rows keep the server's relevance order.");
});

test("no Search feature source reads or renders a raw popularity score", () => {
  const dir = resolve(import.meta.dirname, "../src/features/search");
  const sources = readdirSync(dir).filter((file) => /\.tsx?$/.test(file)).map((file) => readFileSync(resolve(dir, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /\.score\b/);
});
