import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reconcileRecordings,
  type LinkedRecording, type RecordingAuthorityLink, type RecordingObservation,
  type RecordingReconciliationReader, type RecordingReference, type RecordingSource,
} from "../src/index";

function song(source: RecordingSource, identifier: string, extra: Partial<RecordingObservation> = {}): RecordingObservation {
  return {
    key: `${source}:global:song:${identifier}`, source, identifier, country: "global",
    title: "Northern Lights", artist: "Example Artist", album: "Album",
    url: `https://example.test/${source}/${identifier}`, observedAt: "2026-01-01T00:00:00Z",
    durationMs: 180000, ...extra,
  };
}

const mb = song("musicbrainz", "00000000-0000-4000-8000-000000000001");
const deezer = song("deezer", "123");
const link: RecordingAuthorityLink = {
  authority: mb, source: "deezer", identifier: "123", url: "https://example.test/link",
  observedAt: "2026-01-02T00:00:00Z", canonicalStatus: "accepted",
};

function reader(options: {
  recordings?: RecordingObservation[];
  links?: RecordingAuthorityLink[];
  lexical?: RecordingObservation[];
} = {}): RecordingReconciliationReader {
  const recordings = options.recordings ?? [];
  const links = options.links ?? [];
  const valid = (item: RecordingAuthorityLink) =>
    ["musicbrainz", "wikidata"].includes(item.authority.source)
    && !["excluded", "conflict"].includes(item.canonicalStatus);
  return {
    async findByReference(ref, limit) {
      return recordings.filter((row) => row.source === ref.source && row.identifier === ref.identifier && row.country === ref.country).slice(0, limit);
    },
    async findAuthorityLinks(ref, limit) {
      return links.filter((item) => valid(item) && item.source === ref.source && item.identifier === ref.identifier).slice(0, limit);
    },
    async findLinkedRecordings(keys, limit) {
      const results: LinkedRecording[] = [];
      for (const item of links.filter((item) => valid(item) && keys.includes(item.authority.key))) {
        for (const target of recordings.filter((row) => row.source === item.source && row.identifier === item.identifier)) {
          results.push({ link: item, target });
        }
      }
      return results.slice(0, limit);
    },
    async search(_title, _artist, limit) { return (options.lexical ?? []).slice(0, limit); },
  };
}

const metadata = { title: "Nórthern Lights", artist: "EXAMPLE Artist", album: "Album", durationMs: 182000 };
const ref = (source: RecordingSource, identifier: string): RecordingReference => ({ source, identifier });

test("metadata rank is review-only and detects version, artist and duration conflicts", async () => {
  const live = song("deezer", "124", { title: "Northern Lights (Live)", artist: "Other", durationMs: 240000 });
  const result = await reconcileRecordings(reader({ lexical: [live, deezer] }), metadata);
  assert.equal(result.status, "candidates");
  assert.equal(result.reviewRequired, true);
  assert.equal(result.automaticMerge, false);
  assert.match(result.scoreNotice, /not a match probability/);
  assert.equal(result.candidates[0]?.rankScore, 100);
  assert.deepEqual(result.candidates[0]?.evidence.map((e) => e.code), ["title_exact", "artist_exact", "album_exact", "duration_within_2s"]);
  assert.deepEqual(result.candidates[1]?.conflicts, ["title_mismatch", "artist_mismatch", "version_mismatch", "duration_mismatch"]);
  assert.ok(result.candidates.every((candidate) => candidate.reviewRequired && candidate.matchType === "metadata_candidate"));
});

test("explicit authority links work in both directions and retain provenance", async () => {
  const store = reader({ recordings: [mb, deezer], links: [link], lexical: [mb, deezer] });
  for (const reference of [ref("musicbrainz", mb.identifier), ref("deezer", "123")]) {
    const result = await reconcileRecordings(store, { ...metadata, references: [reference] });
    assert.equal(result.status, "identified");
    assert.equal(result.reviewRequired, false);
    assert.deepEqual(result.candidates.map((candidate) => candidate.key).sort(), [deezer.key, mb.key].sort());
    assert.ok(result.candidates.every((candidate) => candidate.matchType === "explicit_identifier"));
    const evidence = result.candidates.flatMap((candidate) => candidate.evidence).find((item) => item.code === "authority_link");
    assert.deepEqual(evidence, { code: "authority_link", authority: "musicbrainz", source: "deezer", identifier: "123", url: link.url, observedAt: link.observedAt });
  }
});

test("excluded, conflicting and non-authority links never identify a candidate", async () => {
  for (const item of [
    { ...link, canonicalStatus: "excluded" },
    { ...link, canonicalStatus: "conflict" },
    { ...link, authority: deezer },
  ]) {
    const result = await reconcileRecordings(reader({ links: [item] }), { references: [ref("deezer", "123")] });
    assert.equal(result.status, "no_match");
  }
});

test("conflicting authorities, disconnected references and metadata mismatch remain ambiguous", async () => {
  const other = song("musicbrainz", "00000000-0000-4000-8000-000000000002");
  const result = await reconcileRecordings(reader({ recordings: [deezer], links: [link, { ...link, authority: other }] }), {
    title: "Northern Lights (Remix)", artist: "Example Artist", durationMs: 240000,
    references: [ref("deezer", "123"), ref("spotify", "a".repeat(22))],
  });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.conflicts, ["multiple_authority_recordings", "disconnected_references", "metadata_conflict"]);
  assert.ok(result.candidates.every((candidate) => candidate.reviewRequired));
});

test("duration tolerance is inclusive and identifier evidence never overrides conflicts", async () => {
  for (const [durationMs, status] of [[182000, "identified"], [182001, "ambiguous"]] as const) {
    const result = await reconcileRecordings(reader({ recordings: [mb] }), {
      title: mb.title, artist: mb.artist, durationMs, references: [ref("musicbrainz", mb.identifier)],
    });
    assert.equal(result.status, status);
    assert.deepEqual(result.candidates[0]?.conflicts, status === "identified" ? [] : ["duration_mismatch"]);
    assert.equal(result.reviewRequired, status === "ambiguous");
  }
});

test("bounded lexical overflow does not turn a clean explicit match ambiguous", async () => {
  const lexical = Array.from({ length: 60 }, (_, i) => song("deezer", String(1000 + i)));
  const result = await reconcileRecordings(reader({ recordings: [mb], lexical }), { ...metadata, references: [ref("musicbrainz", mb.identifier)] });
  assert.equal(result.status, "identified");
  assert.equal(result.candidates.length, 10);
  assert.equal(result.candidatesTruncated, true);
});

test("bounded authority overflow makes identified results ambiguous", async () => {
  const links = Array.from({ length: 51 }, (_, i) => ({ ...link, authority: song("musicbrainz", `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`) }));
  const result = await reconcileRecordings(reader({ links }), { references: [ref("deezer", "123")] });
  assert.equal(result.status, "ambiguous");
  assert.ok(result.conflicts.includes("candidate_window_truncated"));
  assert.equal(result.candidatesTruncated, true);
});

test("YouTube and YouTube Music use the same explicit video ID without title identity", async () => {
  const video = song("youtube", "abcdefghijk");
  const music = song("ytmusic", "abcdefghijk");
  const result = await reconcileRecordings(reader({ recordings: [video, music] }), { references: [ref("youtube", video.identifier)] });
  assert.equal(result.status, "identified");
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((candidate) => candidate.evidence.some((item) => item.code === "provider_id" && item.source === "youtube")));
});

test("reference limit is enforced before examining entries or querying the reader", async () => {
  const references = Array.from({ length: 6 }, () => ref("deezer", "123"));
  Object.defineProperty(references, 0, { get() { throw new Error("reference was examined"); } });
  const store = reader();
  store.findByReference = async () => { throw new Error("reader was called"); };
  await assert.rejects(reconcileRecordings(store, { references }), {
    name: "TypeError", message: "Invalid recording reconciliation query",
  });
  const withinLimit = await reconcileRecordings(reader(), {
    references: Array.from({ length: 5 }, () => ref("deezer", "123")),
  });
  assert.equal(withinLimit.status, "no_match");
});

test("invalid inputs and reader budget or provenance violations fail explicitly", async () => {
  for (const query of [
    {}, { title: "  ", artist: "  " }, { references: [ref("apple", "123")] },
    { references: [ref("discogs" as RecordingSource, "123")] },
    { references: Array.from({ length: 6 }, () => ref("deezer", "123")) },
    { title: "A", artist: "B", durationMs: 0 }, { title: "A", artist: "B", durationMs: 2.5 },
  ]) {
    await assert.rejects(reconcileRecordings(reader(), query), TypeError);
  }
  const oversized = reader();
  oversized.search = async () => Array.from({ length: 52 }, () => deezer);
  await assert.rejects(reconcileRecordings(oversized, metadata), /exceeded/);
  const incorrect = reader();
  incorrect.findByReference = async () => [mb];
  await assert.rejects(reconcileRecordings(incorrect, { references: [ref("deezer", "123")] }), /unrelated/);
});
