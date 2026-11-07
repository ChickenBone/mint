import assert from "node:assert/strict";
import test from "node:test";
import { CHARTS, chartKey, chartRecordingResolution, chartRequestEffect, compatibleChartRecording, confidentChartRecording, matchChartEntry, type ChartCandidate, type ChartRequestOutcome, type ChartEntry, type ChartSnapshot } from "../src/lib/charts";
import { boundedProviderJson, ChartProviderError, fetchChart } from "../src/lib/chart-providers";
import { cachedChart, chartCacheKey, CHART_KEEP_SECONDS, type ChartCacheStore } from "../src/lib/chart-cache";

const now = new Date("2026-11-04T04:00:00Z");
const entry: ChartEntry = { id: "fixture-1", rank: 1, title: "Distant Window", artist: "The Paper Moons", album: "Night Letters",
  durationSec: 180, recordingId: null, isrc: null, url: "https://music.apple.com/us/album/fictional/1", artwork: null, genres: ["Alternative"] };
const local: ChartCandidate = { id: "local", title: entry.title, artist: entry.artist, album: entry.album,
  durationSec: 180, mbRecordingId: null, stage: "ready", playable: true, progress: 1 };
const snapshot = (): ChartSnapshot => ({ entries: [entry], fetchedAt: now.toISOString(), providerUpdatedAt: now.toISOString(),
  revision: "fixture", period: "Provider-defined period", notice: null });
function memory() {
  const data = new Map<string, { value: string; seconds: number }>();
  const store: ChartCacheStore = {
    get: async (key) => data.get(key)?.value ?? null,
    set: async (key, value, seconds, absent) => { if (absent && data.has(key)) return false; data.set(key, { value, seconds }); return true; },
    release: async (key, value) => { if (data.get(key)?.value === value) data.delete(key); },
    publish: async (key, value, seconds, lease, token) => {
      if (data.get(lease)?.value !== token) return false;
      data.set(key, { value, seconds }); return true;
    },
  };
  return { data, store };
}
test("chart identity normalizes accents and punctuation without deleting versions", () => {
  assert.equal(chartKey("Björk / SONG—ONE"), chartKey("Bjork Song One"));
  assert.equal(matchChartEntry(entry, [local]).availability, "available");
  assert.equal(matchChartEntry(entry, [{ ...local, artist: "Cover Artist" }]).availability, "missing");
  for (const title of ["Distant Window (Live)", "Distant Window - Remix", "Distant Window (Remastered)"]) {
    assert.equal(matchChartEntry(entry, [{ ...local, title }]).availability, "missing");
  }
  assert.equal(matchChartEntry(entry, [{ ...local, durationSec: 184 }]).availability, "missing");
  assert.equal(matchChartEntry(entry, [local, { ...local, id: "second" }]).availability, "ambiguous");
  assert.equal(matchChartEntry(entry, [{ ...local, durationSec: null }]).availability, "ambiguous");
  assert.equal(matchChartEntry(entry, [{ ...local, album: null }]).availability, "ambiguous");
  assert.equal(matchChartEntry(entry, [{ ...local, album: "Night Letters (2025 Remaster)" }]).availability, "ambiguous");
  assert.equal(matchChartEntry({ ...entry, recordingId: "9b16c594-19cd-4ac4-86b2-303114b97045" }, [{ ...local, mbRecordingId: "bb48ac0a-adb0-4b9e-962e-d1591ed7f2e3" }]).availability, "missing");
  assert.equal(compatibleChartRecording(entry, { ...local, durationSec: 200 }), false);
  assert.equal(compatibleChartRecording({ ...entry, isrc: "USFI12600001" }, { ...local, isrcs: ["USFI12600002"] }), false);
  assert.equal(compatibleChartRecording({ ...entry, isrc: "USFI12600001" }, { ...local, isrcs: ["USFI12600001"] }), true);
});
test("acquisition states never turn an absent file into playback; account selection resolves editions", () => {
  assert.equal(matchChartEntry(entry, [{ ...local, playable: false, stage: "queued", progress: 0 }]).availability, "requested");
  assert.equal(matchChartEntry(entry, [{ ...local, playable: false, stage: "downloading", progress: .45 }]).availability, "processing");
  assert.equal(matchChartEntry(entry, [{ ...local, playable: false, stage: "failed" }]).availability, "failed");
  assert.equal(matchChartEntry({ ...entry, durationSec: null }, [local]).availability, "ambiguous");
  assert.equal(matchChartEntry({ ...entry, durationSec: null }, [local], local.id).availability, "available");
  assert.equal(matchChartEntry(entry, [{ ...local, title: "Distant Window (Live)" }], local.id).availability, "missing");
});
const recordingId = "9b16c594-19cd-4ac4-86b2-303114b97045";
const recording = { id: recordingId, title: entry.title, artist: entry.artist, album: entry.album,
  durationSec: entry.durationSec, isrcs: ["USFI12600001"], token: "existing-account-bound-signature",
  existing: null };
test("resolution exposes only compatible candidates and preserves their signed result objects", () => {
  const uncertain = { ...recording, id: "bb48ac0a-adb0-4b9e-962e-d1591ed7f2e3", durationSec: null };
  const results = chartRecordingResolution(entry, [uncertain, { ...recording, artist: "Cover Artist" },
    { ...recording, title: `${entry.title} (Live)` }, { ...recording, title: `${entry.title} - Remix` },
    { ...recording, durationSec: 200 }]);
  assert.deepEqual(results.results, [uncertain]);
  assert.equal(results.results[0], uncertain, "Filtering must retain the original signed metadata/token, not manufacture a replacement");
  assert.equal(results.automatic, null, "Missing duration is compatible, not positive confidence");
  assert.deepEqual(chartRecordingResolution(entry, [{ ...recording, artist: "Cover Artist" },
    { ...recording, durationSec: 200 }]), { results: [], automatic: null });
});
test("explicit-request resolution automatically selects only a uniquely confident recording", () => {
  assert.equal(chartRecordingResolution(entry, [recording]).automatic, recording);
  const unknownDuration = { ...recording, id: "bb48ac0a-adb0-4b9e-962e-d1591ed7f2e3", durationSec: null };
  assert.equal(chartRecordingResolution(entry, [unknownDuration, recording]).automatic, recording);
  const alternate = { ...recording, id: "bb48ac0a-adb0-4b9e-962e-d1591ed7f2e3" };
  const ambiguous = chartRecordingResolution(entry, [recording, alternate]);
  assert.equal(ambiguous.automatic, null);
  assert.deepEqual(ambiguous.results, [recording, alternate], "Genuine ambiguity retains both usable choices");
  assert.equal(chartRecordingResolution(entry, [recording], true).automatic, null,
    "A unique search match must not override ambiguous local editions");
  assert.equal(chartRecordingResolution({ ...entry, durationSec: null }, [recording]).automatic, null);
  assert.equal(chartRecordingResolution(entry, [{ ...recording, album: null }]).automatic, null,
    "Duration alone cannot resolve missing edition metadata");
});
test("matching recording identity corrects missing album and duration false negatives without invented confidence", () => {
  const identified = { ...entry, recordingId };
  const incomplete = { ...recording, album: null, durationSec: null };
  assert.equal(confidentChartRecording(identified, incomplete), true,
    "The recording ID, not absent album/duration metadata, supplies identity evidence");
  assert.equal(chartRecordingResolution(identified, [incomplete]).automatic, incomplete);
  assert.equal(matchChartEntry(identified, [{ ...local, mbRecordingId: recordingId, album: null, durationSec: null }]).availability, "available");
  assert.equal(matchChartEntry(identified, [{ ...local, mbRecordingId: null, album: null }]).availability, "ambiguous");
  assert.equal(matchChartEntry({ ...entry, isrc: recording.isrcs[0]! }, [local]).availability, "available",
    "Local duration/album matching is unchanged; the index does not pretend to verify ISRC");
  const isrcEntry = { ...entry, isrc: recording.isrcs[0]!, durationSec: null };
  assert.equal(chartRecordingResolution(isrcEntry, [incomplete]).automatic, incomplete,
    "An actual matching ISRC is an identity anchor even when MusicBrainz omits duration and album");
  assert.equal(chartRecordingResolution(isrcEntry, [{ ...incomplete, isrcs: [] }]).automatic, null);
  assert.equal(chartRecordingResolution({ ...entry, durationSec: null }, [incomplete]).automatic, null,
    "Absent identifiers, album and duration never become confidence");
  assert.equal(chartRecordingResolution(identified, [{ ...recording, album: "Different Release" }]).automatic, null,
    "Known album conflicts remain edition ambiguity, even with a matching recording ID");
});
test("strong recording identities never override artist, cover, version, identifier or duration conflicts", () => {
  const identified = { ...entry, recordingId, isrc: recording.isrcs[0]! };
  for (const incompatible of [
    { ...recording, artist: "The Cover Moons" },
    { ...recording, title: `${entry.title} (Cover)` },
    { ...recording, title: `${entry.title} (Live)` },
    { ...recording, title: `${entry.title} - Remix` },
    { ...recording, title: `${entry.title} (Remastered)` },
    { ...recording, id: "bb48ac0a-adb0-4b9e-962e-d1591ed7f2e3" },
    { ...recording, isrcs: ["USFI12600002"] },
    { ...recording, durationSec: 183 },
    { ...recording, durationSec: 177 },
  ]) {
    assert.equal(compatibleChartRecording(identified, incompatible), false);
    assert.equal(confidentChartRecording(identified, incompatible), false);
    assert.deepEqual(chartRecordingResolution(identified, [incompatible]), { results: [], automatic: null });
  }
  assert.equal(compatibleChartRecording(entry, { ...recording, durationSec: 182.5 }), true);
  assert.equal(compatibleChartRecording(entry, { ...recording, durationSec: 177.5 }), true);
  assert.equal(chartRecordingResolution(identified, [{ ...recording, album: "Night Letters (2025 Remaster)" }]).automatic, null);
  assert.equal(chartRecordingResolution(identified, [{ ...recording, isrcs: [] }]).automatic, null,
    "A supplied chart ISRC must still be verified for automatic selection");
});
test("Apple uses a real storefront feed plus one bounded metadata lookup, never a global alias or preview", async () => {
  const calls: URL[] = [];
  const result = await fetchChart(CHARTS[0]!, async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    return url.hostname === "rss.marketingtools.apple.com" ? Response.json({ feed: { country: "us", updated: now.toUTCString(), results: [
      { id: "123", name: entry.title, artistName: entry.artist, url: entry.url, artworkUrl100: "https://is1-ssl.mzstatic.com/fixture.jpg", genres: [{ name: "Music" }, { name: "Alternative" }] },
    ] } }) : Response.json({ results: [{ trackId: 123, trackTimeMillis: 180000, collectionName: entry.album, previewUrl: "https://not-used.example" }] });
  }, now);
  assert.equal(calls.length, 2); assert.equal(calls[0]!.pathname, "/api/v2/us/music/most-played/50/songs.json");
  assert.equal(result.entries[0]!.durationSec, 180); assert.equal(result.entries[0]!.album, entry.album);
  assert.equal(result.entries[0]!.artwork, "https://is1-ssl.mzstatic.com/fixture.jpg",
    "Apple artwork is retained for its chart row, not saved as local-library art");
  assert.ok(!JSON.stringify(result).includes("preview")); assert.match(result.period, /not published/);
  assert.ok(CHARTS.filter((chart) => chart.provider === "apple").every((chart) => !chart.territory.includes("Worldwide")));
});
test("community charts retain their actual dates and Audius genres remain provider scoped", async () => {
  const brainz = await fetchChart(CHARTS.find((chart) => chart.id === "listenbrainz-week")!, async () => Response.json({
    payload: { from_ts: 1791763200, to_ts: 1792368000, last_updated: 1792818907, recordings: [
      ...["9b16c594-19cd-4ac4-86b2-303114b97045", "8b16c594-19cd-4ac4-86b2-303114b97045"].map((release) => ({ track_name: entry.title, artist_name: entry.artist,
        recording_mbid: "9b16c594-19cd-4ac4-86b2-303114b97045", release_name: entry.album, caa_release_mbid: release })),
    ] },
  }), now);
  assert.match(brainz.period, /2026-10-12.*2026-10-19/);
  assert.equal(brainz.entries[0]!.recordingId, "9b16c594-19cd-4ac4-86b2-303114b97045");
  assert.equal(brainz.entries[0]!.artwork, "https://coverartarchive.org/release/9b16c594-19cd-4ac4-86b2-303114b97045/front-250");
  assert.equal(new Set(brainz.entries.map((entry) => entry.id)).size, 2);
  assert.deepEqual(brainz.entries.map((entry) => entry.rank), [1, 2], "Keep provider ranks even when release variants share a recording identity");
  assert.match(brainz.notice!, /original ranks/);
  const audius = await fetchChart(CHARTS.find((chart) => chart.id === "audius-electronic")!, async (input) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get("genre"), "Electronic"); assert.equal(url.searchParams.get("time"), "week");
    assert.equal(url.searchParams.get("limit"), "50");
    return Response.json({ data: [{ id: "fictional", title: entry.title, duration: 180, genre: "Electronic",
      artwork: { "480x480": "https://creatornode3.audius.co/tracks/fictional/image" }, user: { name: entry.artist } }] });
  }, now);
  assert.equal(audius.providerUpdatedAt, null);
  assert.equal(audius.entries[0]!.url, "https://audius.co/trending");
  assert.equal(audius.entries[0]!.artwork, "https://creatornode3.audius.co/tracks/fictional/image");
});
test("cache bounds storage, coalesces refresh, preserves stale data and honors provider-wide cooldown", async () => {
  const { data, store } = memory(), chart = CHARTS[0]!;
  let calls = 0;
  const load = async () => { calls++; return snapshot(); };
  const first = await cachedChart(chart, store, load, now.getTime());
  assert.equal(first.status, "fresh"); assert.equal(calls, 1);
  assert.equal(data.get(chartCacheKey(chart))!.seconds, CHART_KEEP_SECONDS);
  await cachedChart(chart, store, load, now.getTime() + 1000); assert.equal(calls, 1);
  data.delete("mint:charts:throttle:apple");
  const later = now.getTime() + 3601_000;
  const stale = await cachedChart(chart, store, async () => { calls++; throw new ChartProviderError("Rate limited", 600); }, later);
  assert.equal(stale.status, "stale"); assert.equal(stale.snapshot!.entries[0]!.rank, 1);
  assert.equal(stale.retryAt, new Date(later + 600000).toISOString());
  const other = await cachedChart(CHARTS[1]!, store, load, later);
  assert.equal(other.status, "error"); assert.equal(other.notice, "Rate limited"); assert.equal(calls, 2);
  data.delete("mint:charts:cooldown:apple"); data.delete("mint:charts:throttle:apple");
  const requests = await Promise.all([cachedChart(chart, store, load, later), cachedChart(chart, store, load, later)]);
  assert.equal(calls, 3); assert.ok(requests.some((result) => result.status === "stale"));
});
test("cold chart callers on separate store instances coalesce and invalid rankings never publish", async () => {
  const chart = CHARTS[0]!, { store } = memory();
  let calls = 0;
  const load = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return snapshot(); };
  const results = await Promise.all(Array.from({ length: 20 }, () => cachedChart(chart, { ...store }, load, now.getTime())));
  assert.equal(calls, 1); assert.ok(results.every((result) => result.snapshot?.revision === "fixture"));
  await cachedChart(chart, { ...store }, load, now.getTime()); assert.equal(calls, 1);
  const invalid = memory();
  const result = await cachedChart(chart, invalid.store, async () => ({ ...snapshot(),
    entries: [{ ...entry, artwork: "https://untrusted.example/cover.jpg" }] }), now.getTime());
  assert.equal(result.status, "error"); assert.equal(invalid.data.has(chartCacheKey(chart)), false);
  assert.notEqual(chartCacheKey(chart), chartCacheKey({ ...chart, country: "gb" }));
  assert.notEqual(chartCacheKey(chart), chartCacheKey({ ...chart, genre: "Rock" }));
});
test("an expired chart lease cannot overwrite another refresh or release its lease", async () => {
  const chart = CHARTS[0]!, { data, store } = memory(), key = chartCacheKey(chart);
  const result = await cachedChart(chart, store, async () => {
    data.set(`${key}:refresh`, { value: "new-owner", seconds: 30 });
    return snapshot();
  }, now.getTime());
  assert.equal(result.status, "error"); assert.match(result.notice!, /lease expired/);
  assert.equal(data.has(key), false);
  assert.equal(data.get(`${key}:refresh`)?.value, "new-owner");
});
test("malformed provider cooldowns remain explicit and never permit another upstream request", async () => {
  const { store, data } = memory();
  data.set("mint:charts:cooldown:apple", { value: "{bad", seconds: 60 });
  let calls = 0;
  const result = await cachedChart(CHARTS[0]!, store, async () => { calls++; return snapshot(); }, now.getTime());
  assert.equal(result.status, "error"); assert.match(result.notice!, /cooldown/); assert.equal(calls, 0);
});
test("empty, expired, malformed, timed-out and stale provider output remain distinguishable", async () => {
  const chart = CHARTS[0]!;
  const empty = await cachedChart(chart, memory().store, async () => ({ ...snapshot(), entries: [] }), now.getTime());
  assert.equal(empty.status, "empty"); assert.equal(empty.notice, null);
  const timeout = await cachedChart(chart, memory().store, async () => { throw new DOMException("Timeout", "TimeoutError"); }, now.getTime());
  assert.equal(timeout.status, "error"); assert.match(timeout.notice!, /timed out/);
  const old = { ...snapshot(), providerUpdatedAt: "2026-10-01T00:00:00Z" };
  assert.equal((await cachedChart(chart, memory().store, async () => old, now.getTime())).status, "stale");
  const { data, store } = memory();
  data.set(chartCacheKey(chart), { value: JSON.stringify({ ...snapshot(), fetchedAt: "2026-10-01T00:00:00Z" }), seconds: 1 });
  const expired = await cachedChart(chart, store, async () => { throw new Error("offline"); }, now.getTime());
  assert.equal(expired.status, "error"); assert.equal(expired.snapshot, null);
  const corrupt = memory(); corrupt.data.set(chartCacheKey(chart), { value: "{bad", seconds: 100 });
  assert.equal((await cachedChart(chart, corrupt.store, async () => snapshot(), now.getTime())).status, "fresh");
  await assert.rejects(boundedProviderJson(new Response("x".repeat(2_000_001))), /safety limit/);
  await assert.rejects(boundedProviderJson(new Response("{")), /invalid JSON/);
  await assert.rejects(boundedProviderJson(new Response(null, { status: 429, headers: { "retry-after": "120" } })), (error) => error instanceof ChartProviderError && error.retrySeconds === 120);
});

test("chart request responses only affect the page view that sent them", () => {
  const current = (outcome: ChartRequestOutcome) => chartRequestEffect(true, "Distant Window", outcome);
  const stale = (outcome: ChartRequestOutcome) => chartRequestEffect(false, "Distant Window", outcome);
  assert.equal(current({ status: "resolve" }).resolve, true);
  assert.equal(current({ status: "error", message: "Rate limited." }).rowError, "Rate limited.");
  assert.deepEqual([current({ status: "requested" }).markRequested, current({ status: "requested" }).refresh], [true, true]);
  for (const outcome of [{ status: "resolve" }, { status: "error", message: "Rate limited." }, { status: "requested" }, { status: "available" }] as ChartRequestOutcome[]) {
    const effect = stale(outcome);
    assert.deepEqual([effect.resolve, effect.rowError, effect.markRequested, effect.refresh], [false, null, false, false], outcome.status);
    assert.match(effect.notice || effect.error, /Distant Window/, "Stale outcomes stay visible and name the song");
  }
  assert.match(stale({ status: "requested" }).notice, /^Request sent for Distant Window/, "Submitted requests are still acknowledged after paging");
  assert.match(stale({ status: "resolve" }).notice, /^Pick a version of Distant Window/);
  assert.match(stale({ status: "error", message: "Rate limited." }).error, /^Couldn’t add Distant Window\. Rate limited\./);
});
