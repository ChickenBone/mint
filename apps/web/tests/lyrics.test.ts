import assert from "node:assert/strict";
import test from "node:test";
import { lyricsSchema, lyricTiming, parseLrc, rankLyrics, type Lyrics } from "../src/lib/lyrics";
import { fetchBestLyrics, fetchLyricsById, fetchOvhLyrics, LyricsBusyError } from "../src/lib/lyrics-provider";

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
  await assert.rejects(() => fetchLyricsById(-1), /Invalid lyric match/);
});
