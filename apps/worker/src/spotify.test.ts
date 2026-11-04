import assert from "node:assert/strict";
import test from "node:test";
import { matchSpotifyItem, normalizeSpotifyItem, parseSpotifyPlaylistId, SpotifyClient, SpotifyError, spotifyJson,
  spotifyTokenRequest, type SpotifySourceItem } from "@mint/core/spotify";

const playlistId = "0123456789ABCDEFGHIJKL";
const track = { id: "track1", uri: "spotify:track:track1", type: "track", name: "Song (Live)",
  artists: [{ name: "Artist" }], album: { name: "Album" }, duration_ms: 200_000 };
const item = () => normalizeSpotifyItem({ item: track, added_at: "2026-01-01", added_by: { id: "owner" } });

test("Spotify links accept canonical playlist IDs and reject arbitrary upstream URLs", () => {
  for (const input of [playlistId, `spotify:playlist:${playlistId}`, `https://open.spotify.com/playlist/${playlistId}?si=x`,
    `https://open.spotify.com/intl-en/playlist/${playlistId}`]) assert.equal(parseSpotifyPlaylistId(input), playlistId);
  for (const input of ["https://evil.test/playlist/" + playlistId, "http://open.spotify.com/playlist/" + playlistId,
    `https://open.spotify.com.evil.test/playlist/${playlistId}`, "spotify:album:" + playlistId, "not-a-playlist",
    `https://user:pass@open.spotify.com/playlist/${playlistId}`]) assert.throws(() => parseSpotifyPlaylistId(input));
});

test("current item and legacy track fields normalize without discarding nulls/order metadata", () => {
  assert.equal(item().addedBy, "owner");
  assert.equal(item().title, track.name);
  assert.deepEqual(normalizeSpotifyItem({ track }), normalizeSpotifyItem({ item: track }));
  assert.ok(normalizeSpotifyItem({ item: null, track }).unavailable);
  assert.ok(normalizeSpotifyItem({ item: { ...track, type: "episode" } }).unavailable);
  assert.ok(normalizeSpotifyItem({ item: track, is_local: true }).unavailable);
  assert.ok(normalizeSpotifyItem({ item: { ...track, restrictions: { reason: "market" } } }).unavailable);
  assert.ok(normalizeSpotifyItem({ item: { ...track, is_playable: false } }).unavailable);
  assert.equal(normalizeSpotifyItem({ item: { ...track, external_ids: { isrc: "TEST000001" } } }).isrc, "TEST000001");
});

test("matching keeps versions and album identities intact and refuses ambiguity", () => {
  const local = { id: "local", title: track.name, artist: "Artist", album: "Album", durationSec: 200 };
  assert.equal(matchSpotifyItem(item(), [local]).status, "matched");
  assert.equal(matchSpotifyItem(item(), [{ ...local, title: "Song" }]).status, "missing");
  assert.equal(matchSpotifyItem(item(), [{ ...local, title: "Song (Remastered)" }]).status, "missing");
  assert.equal(matchSpotifyItem(item(), [{ ...local, album: "Other release" }]).status, "missing");
  assert.equal(matchSpotifyItem(item(), [{ ...local, durationSec: 205 }]).status, "missing");
  assert.equal(matchSpotifyItem(item(), [{ ...local, durationSec: null }]).status, "missing");
  assert.equal(matchSpotifyItem(item(), [local, { ...local, id: "other-recording" }]).status, "ambiguous");
  assert.equal(matchSpotifyItem({ ...item(), unavailable: "restricted" } as SpotifySourceItem, [local]).status, "unavailable");
});

test("Spotify pagination is bounded, same-endpoint and never sends tokens to another host", async () => {
  const seen: string[] = [];
  const client = new SpotifyClient(async () => "fixture-token", async (input, init) => {
    const url = new URL(String(input)); seen.push(url.href);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ items: [offset], total: 2, next: offset ? null : "https://api.spotify.com/v1/me/playlists?offset=1&limit=1" });
  });
  const result = [];
  for await (const page of client.pages("me/playlists?offset=0&limit=1")) result.push(...page);
  assert.deepEqual(result, [0, 1]); assert.equal(seen.length, 2);
  await assert.rejects(() => client.get("https://evil.test/v1/me"), /Invalid Spotify/);
  for (const next of ["https://evil.test/v1/me/playlists?offset=1", "https://api.spotify.com/v1/me?offset=1",
    "https://api.spotify.com/v1/me/playlists?offset=0", "https://api.spotify.com/v1/me/playlists?offset=3"]) {
    let requests = 0;
    const bad = new SpotifyClient(async () => "secret", async () => { requests++; return Response.json({ items: [1], total: 2, next }); });
    await assert.rejects(async () => { for await (const _ of bad.pages("me/playlists?offset=0")) { /* drain */ } }, /pagination/);
    assert.equal(requests, 1);
  }
});

test("Spotify incomplete/oversized/cyclic/changing snapshots cannot be accepted", async () => {
  for (const response of [
    { items: [1], next: null, total: 2 },
    { items: [], next: "https://api.spotify.com/v1/me/playlists?offset=1", total: 2 },
    { items: [1], next: null, total: 10_001 },
  ]) {
    const client = new SpotifyClient(async () => "x", async () => Response.json(response));
    await assert.rejects(async () => { for await (const _ of client.pages("me/playlists?offset=0")) { /* drain */ } });
  }
  let page = 0;
  const changing = new SpotifyClient(async () => "x", async () => Response.json({ items: [1], next: page++ ? null : "https://api.spotify.com/v1/me/playlists?offset=1", total: page === 1 ? 2 : 3 }));
  await assert.rejects(async () => { for await (const _ of changing.pages("me/playlists?offset=0")) { /* drain */ } }, /changed/);
});

test("provider failures are sanitized; 429 Retry-After seconds and dates are honored", async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    await assert.rejects(() => spotifyJson(new Response("secret-access-token", { status })), (error: unknown) =>
      error instanceof SpotifyError && error.status === status && !error.message.includes("secret"));
  }
  await assert.rejects(() => spotifyJson(new Response("", { status: 429, headers: { "retry-after": "120" } })),
    (error: unknown) => error instanceof SpotifyError && error.retryAfterSeconds === 120);
  await assert.rejects(() => spotifyJson(new Response("", { status: 429, headers: { "retry-after": new Date(Date.now() + 180_000).toUTCString() } })),
    (error: unknown) => error instanceof SpotifyError && error.retryAfterSeconds >= 179);
});

test("token endpoint uses confidential server credentials and a form, never provider playlist writes", async () => {
  const old = { id: process.env.SPOTIFY_CLIENT_ID, secret: process.env.SPOTIFY_CLIENT_SECRET, key: process.env.ENCRYPTION_KEY };
  Object.assign(process.env, { SPOTIFY_CLIENT_ID: "client-fixture", SPOTIFY_CLIENT_SECRET: "secret-fixture", ENCRYPTION_KEY: "configured" });
  try {
    const result = await spotifyTokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: "fixture-refresh" }), async (input, init) => {
      assert.equal(String(input), "https://accounts.spotify.com/api/token");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("client-fixture:secret-fixture").toString("base64")}`);
      assert.ok(init?.body instanceof URLSearchParams);
      return Response.json({ access_token: "access-fixture", refresh_token: "rotated-fixture", expires_in: 3600 });
    });
    assert.equal(result.refresh_token, "rotated-fixture");
  } finally {
    for (const [name, value] of [["SPOTIFY_CLIENT_ID", old.id], ["SPOTIFY_CLIENT_SECRET", old.secret], ["ENCRYPTION_KEY", old.key]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});
