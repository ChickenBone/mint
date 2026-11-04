import assert from "node:assert/strict";
import test from "node:test";
import { defaultDsp, dspSchema, playerStateSchema } from "../../web/src/lib/player-protocol";
import { lyricsSchema, parseLrc } from "../../web/src/lib/lyrics";
import { fetchLyrics, LyricsBusyError, retryAfterSeconds } from "../../web/src/lib/lyrics-provider";

test("synced lyrics support fractional times, repeated tags, offsets and stable ordering", () => {
  assert.deepEqual(parseLrc("[ar:Mint Fixture]\n[offset:-250]\n[00:02.5][00:04.050]A new morning\n[00:01.00]First light\n[00:70.00]Invalid\n[00:05.001]\n[03:00]Last line"), [
    { time: 750, text: "First light" }, { time: 2250, text: "A new morning" }, { time: 3800, text: "A new morning" },
    { time: 4751, text: "" }, { time: 179750, text: "Last line" },
  ]);
  assert.deepEqual(parseLrc("Plain lyrics without timestamps"), []);
  assert.equal(lyricsSchema.safeParse({ id: 1, instrumental: false, plainLyrics: "Original fixture words", syncedLyrics: null }).success, true);
  assert.equal(lyricsSchema.safeParse({ id: 1, instrumental: false, plainLyrics: "a".repeat(100001), syncedLyrics: null }).success, false);
});

test("audio settings and state have bounded typed contracts", () => {
  assert.equal(dspSchema.safeParse(defaultDsp).success, true);
  for (const invalid of [{ ...defaultDsp, preamp: 1 }, { ...defaultDsp, bands: [0] }, { ...defaultDsp, crossfade: 13 }]) assert.equal(dspSchema.safeParse(invalid).success, false);
  assert.equal(playerStateSchema.safeParse({ playing: false, time: 0, duration: 0, volume: 100, shuffle: false, repeat: 0, track: null, queue: [], queueTotal: 0, queueOffset: 0, dsp: defaultDsp, dspAvailable: true }).success, true);
});

test("lyrics lookup identifies Mint, uses exact metadata, bounds responses and honors provider backoff", async () => {
  const track = { artist: "Mint Fixture", title: "First Light", album: "Browser Sessions", duration: 90 };
  const value = { id: 1, instrumental: false, plainLyrics: "First light, a new morning", syncedLyrics: null };
  const lookup = (response: Response) => fetchLyrics(track, async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/api/get");
    assert.equal(new URL(String(input)).searchParams.get("duration"), "90");
    assert.match(new Headers(init?.headers).get("user-agent")!, /Mint\/3.5/);
    assert.equal(init?.redirect, "error");
    return response;
  });
  assert.deepEqual(await lookup(Response.json(value)), value);
  assert.equal(await lookup(new Response(null, { status: 404 })), null);
  await assert.rejects(lookup(new Response(null, { status: 429, headers: { "retry-after": "120" } })), (error) => error instanceof LyricsBusyError && error.retryAfter === 120);
  assert.equal(retryAfterSeconds("Thu, 01 Jan 1970 00:02:00 GMT", 0), 120);
  await assert.rejects(lookup(new Response("x".repeat(300001))), /too large/);
  await assert.rejects(lookup(Response.json({})), /id/);
});
