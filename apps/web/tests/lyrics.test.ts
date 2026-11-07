import assert from "node:assert/strict";
import test from "node:test";
import { lyricsSchema, lyricTiming, parseLrc, rankLyrics, type Lyrics } from "../src/lib/lyrics";
import { fetchBestLyrics, fetchLyrics, fetchLyricsById, fetchOvhLyrics, LyricsBusyError, searchLyrics } from "../src/lib/lyrics-provider";
import { publicCacheFixture } from "../../../packages/core/src/public-cache-fixture";

const track = { title: "Test song", artist: "Fixture artist", album: "Test album", duration: 123 };
const plain: Lyrics = { source: "Lyrics.ovh", instrumental: false, plainLyrics: "First phrase", syncedLyrics: null };
const synced: Lyrics = { id: 12, source: "LRCLIB", instrumental: false, plainLyrics: "First phrase", syncedLyrics: "[00:01.00]First phrase" };
const word: Lyrics = { ...synced, syncedLyrics: "[00:01.00]<00:01.00>First <00:01.50>phrase" };

test("LRC retains repeated timestamps, offsets, fractional precision and chronological order", () => {
  assert.deepEqual(parseLrc("[offset:-100]\n[00:03.5][00:01.005]Repeat\n[00:70.00]Invalid\n[00:00.01]Start"), [
    { time: 0, text: "Start" }, { time: 905, text: "Repeat" }, { time: 3400, text: "Repeat" },
  ]);
});

test("enhanced LRC preserves real word timing and does not invent timing for plain lines", () => {
  assert.deepEqual(parseLrc("[offset:100]\n" + word.syncedLyrics), [{
    time: 1100, text: "First phrase", words: [{ time: 1100, text: "First " }, { time: 1600, text: "phrase" }],
  }]);
  assert.equal(lyricTiming(word), "Word by word");
  assert.equal(lyricTiming(synced), "Line by line");
  assert.equal(lyricTiming(plain), "Plain text");
  assert.equal(lyricTiming({ ...word, syncedLyrics: `${word.syncedLyrics}\n[00:03]No word timing` }), "Line by line");
  assert.equal(lyricTiming({ ...word, syncedLyrics: "[00:01]<00:02>First <00:01>phrase" }), "Line by line");
  assert.equal(lyricTiming({ ...word, syncedLyrics: "[00:01]Prefix <00:02>phrase" }), "Line by line");
  assert.equal(lyricTiming({ ...word, syncedLyrics: "[00:01]<00:01>First phrase" }), "Line by line");
});

test("automatic selection ranks actual timing, ignores empty results and preserves source ties", () => {
  assert.deepEqual(rankLyrics([plain, synced, word]).map(lyricTiming), ["Word by word", "Line by line", "Plain text"]);
  assert.deepEqual(rankLyrics([{ ...plain, plainLyrics: " " }, { ...synced, plainLyrics: null, syncedLyrics: "[00:01]" }]), []);
  const instrumental = { ...synced, instrumental: true, plainLyrics: null, syncedLyrics: null };
  assert.equal(rankLyrics([plain, instrumental])[0], instrumental);
  assert.equal(lyricsSchema.parse({ id: 1, instrumental: false, plainLyrics: null, syncedLyrics: null }).source, "LRCLIB");
});

test("two bounded providers are compared without forwarding audio or private identifiers", async () => {
  const urls: URL[] = [];
  const mock: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.ok(options?.signal);
    return Response.json(url.hostname === "lrclib.net" ? synced : { lyrics: "First phrase" });
  };
  const result = await fetchBestLyrics(track, mock);
  assert.equal(result.lyrics?.source, "LRCLIB");
  assert.equal(result.alternatives.length, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(urls.length, 2);
  assert.equal(urls[0]!.searchParams.get("duration"), "123");
  assert.equal(urls[1]!.pathname, "/v1/Fixture%20artist/Test%20song");
});

test("provider failures are visible while another source remains usable", async () => {
  const mock: typeof fetch = async (input) => String(input).includes("lrclib.net")
    ? new Response("", { status: 429, headers: { "retry-after": "120" } }) : Response.json({ lyrics: "Fixture text" });
  const result = await fetchBestLyrics(track, mock);
  assert.equal(result.lyrics?.source, "Lyrics.ovh");
  assert.equal(result.retryAfter, 120);
  assert.match(result.warnings[0]!, /LRCLIB is unavailable/);
});

test("LRCLIB cooldown still allows the independent fallback; both no-matches remain distinct from errors", async () => {
  const urls: string[] = [];
  const mock: typeof fetch = async (input) => { urls.push(String(input)); return Response.json({ lyrics: "Fixture text" }); };
  assert.equal((await fetchBestLyrics(track, mock, 30)).lyrics?.source, "Lyrics.ovh");
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /api\.lyrics\.ovh/);
  assert.equal((await fetchBestLyrics(track, async () => new Response(null, { status: 404 }))).lyrics, null);
  await assert.rejects(() => fetchBestLyrics(track, async () => new Response(null, { status: 502 })), /502/);
});

test("fallback rejects oversized or malformed responses and identifies its own rate limit", async () => {
  await assert.rejects(() => fetchOvhLyrics(track, async () => Response.json({ lyrics: 123 })));
  await assert.rejects(() => fetchOvhLyrics(track, async () => new Response("a".repeat(300_001))), /too large/);
  await assert.rejects(() => fetchOvhLyrics(track, async () => new Response(null, { status: 429 })), (error: unknown) =>
    error instanceof LyricsBusyError && error.provider === "Lyrics.ovh");
  assert.equal(await fetchLyricsById(12, async () => new Response(null, { status: 404 })), null);
  await assert.rejects(() => fetchLyricsById(12, async () => Response.json(null)), /invalid/);
  await assert.rejects(() => searchLyrics("Fixture song", async () => Response.json(null)), /invalid/);
  await assert.rejects(() => fetchLyricsById(-1), /Invalid lyric match/);
});

test("all four public lyric endpoint families share validated persistent metadata across callers", async () => {
  let now = Date.now(), calls = 0;
  const fixture = publicCacheFixture(() => now);
  const request: typeof fetch = async (input) => {
    calls++;
    const url = new URL(String(input));
    return Response.json(url.hostname === "api.lyrics.ovh" ? { lyrics: "First phrase" } :
      url.pathname === "/api/search" ? [{ ...synced, trackName: track.title, artistName: track.artist, albumName: track.album, duration: 123 }] : synced);
  };
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) =>
    fetchLyrics(track, request, index % 2 ? fixture.cache : fixture.instance())));
  assert.ok(results.every((lyrics) => lyrics?.id === 12)); assert.equal(calls, 1);
  await fetchLyrics(track, request, fixture.instance()); assert.equal(calls, 1);
  now += 2000;
  await fetchLyricsById(12, request, fixture.cache); await fetchLyricsById(12, request, fixture.instance());
  assert.equal(calls, 2);
  now += 2000;
  assert.equal((await searchLyrics("Fixture artist Test song", request, fixture.cache)).length, 1);
  await searchLyrics("Fixture artist Test song", request, fixture.instance()); assert.equal(calls, 3);
  await fetchOvhLyrics(track, request, fixture.cache); await fetchOvhLyrics(track, request, fixture.instance());
  assert.equal(calls, 4, "37 endpoint lookups need four upstream reads");
  now += 2000;
  await fetchLyrics({ ...track, album: "Different edition" }, request, fixture.cache);
  assert.equal(calls, 5, "album/duration variants cannot collide");
});
test("fallback lyrics respect their own provider-wide Retry-After without suppressing LRCLIB", async () => {
  let now = Date.now(), fallbackCalls = 0, lrclibCalls = 0;
  const fixture = publicCacheFixture(() => now);
  const request: typeof fetch = async (input) => {
    if (String(input).includes("lrclib.net")) { lrclibCalls++; return Response.json(synced); }
    fallbackCalls++;
    return new Response(null, { status: 429, headers: { "retry-after": "120" } });
  };
  const first = await fetchBestLyrics(track, request, 0, fixture.cache);
  assert.equal(first.lyrics?.source, "LRCLIB"); assert.equal(first.retryAfter, 120);
  now += 2000;
  const second = await fetchBestLyrics({ ...track, title: "Another song" }, request, 0, fixture.instance());
  assert.equal(second.lyrics?.source, "LRCLIB");
  assert.equal(fallbackCalls, 1); assert.equal(lrclibCalls, 2);
});
test("lyrics retain bounded real no-match negatives and stale lyrics report their original age", async () => {
  let now = Date.now(), calls = 0;
  const fixture = publicCacheFixture(() => now);
  const missing: typeof fetch = async () => { calls++; return new Response(null, { status: 404 }); };
  assert.equal(await fetchLyrics(track, missing, fixture.cache), null);
  assert.equal(await fetchLyrics(track, missing, fixture.instance()), null); assert.equal(calls, 1);
  now += 301_000;
  assert.equal(await fetchLyrics(track, missing, fixture.instance()), null); assert.equal(calls, 2);
  const kept = publicCacheFixture(() => now);
  await fetchBestLyrics(track, async (input) => Response.json(String(input).includes("lrclib") ? synced : { lyrics: "First phrase" }), 0, kept.cache);
  now += 86401_000;
  const stale = await fetchBestLyrics(track, async () => new Response(null, { status: 503 }), 0, kept.instance());
  assert.equal(stale.lyrics?.source, "LRCLIB");
  assert.equal(stale.warnings.length, 2);
  assert.match(stale.warnings[0]!, /cached lyrics.*86401 seconds old/);
});
