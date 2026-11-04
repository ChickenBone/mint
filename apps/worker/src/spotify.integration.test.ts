import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, closeDb, schema } from "@mint/core/db";
import { runMigrations } from "@mint/core/db/migrate";
import { decrypt, encrypt, sha256 } from "@mint/core/crypto";
import { spotifyAccounts as accounts, spotifyEntries as entries, spotifyPlaylists as playlists, spotifyOauthStates as states } from "@mint/core/spotify-db";
import { beginSpotifyOAuth, connectSpotifyAccount, consumeSpotifyState, disconnectSpotifyAccount, importSpotifyPlaylist,
  setSpotifyPlaylistSelection, spotifyPlayablePage, spotifyPlaylistView, spotifyQueueTrackSource, syncSpotifyAccount } from "@mint/core/spotify-store";
import type { SpotifyFetch } from "@mint/core/spotify";

test("Spotify real PostgreSQL integration: OAuth, snapshots, duplicate queues, local-only matches, failures and account boundaries", {
  skip: !process.env.MINT_SPOTIFY_TEST_DATABASE_URL, timeout: 120_000,
}, async (t) => {
  const url = process.env.MINT_SPOTIFY_TEST_DATABASE_URL!;
  assert.match(new URL(url).pathname, /^\/mint_spotify_test(?:_[a-z0-9]+)?$/);
  Object.assign(process.env, { DATABASE_URL: url, SPOTIFY_CLIENT_ID: "fixture-client", SPOTIFY_CLIENT_SECRET: "fixture-secret",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"), SPOTIFY_API_MODE: "development" });
  const db = getDb(), userId = randomUUID(), otherId = randomUUID(), trackIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const own = "0123456789ABCDEFGHIJKL", collab = "1123456789ABCDEFGHIJKL", followed = "2123456789ABCDEFGHIJKL";
  let providerError = 0, inconsistent = false, rotated = 0, snapshot = "v1", pages = 0, network = 0, revocation = false;
  let profileId = "provider-owner", profileAccountId = "stable-account";
  const metadata = (id: string) => ({ id, name: id === own ? "Ordered playlist" : "Another playlist", snapshot_id: snapshot,
    owner: { id: id === own ? profileId : "someone-else", display_name: "Provider owner" }, collaborative: id === collab });
  const song = (name = "Song", id = "song") => ({ added_at: "2026-01-01T00:00:00Z", added_by: { id: "provider-owner" },
    item: { type: "track", id, uri: `spotify:track:${id}`, name, artists: [{ name: "Artist" }], album: { name: "Album" }, duration_ms: 200_000 } });
  const source = [song(), song(), song("Missing", "missing"), { item: { type: "episode", name: "Podcast", id: "episode" } }, song("Ambiguous", "ambiguous")];
  const transport: SpotifyFetch = async (input, init) => {
    network++;
    const u = new URL(String(input));
    if (u.hostname === "accounts.spotify.com") {
      const body = init?.body as URLSearchParams;
      assert.equal(u.pathname, "/api/token"); assert.equal(init?.method, "POST");
      if (body.get("grant_type") === "refresh_token") {
        if (revocation) return Response.json({ error: "invalid_grant" }, { status: 400 });
        rotated++; return Response.json({ access_token: `access-${rotated}`, refresh_token: `refresh-${rotated}`, expires_in: 3600 });
      }
      assert.equal(body.get("code_verifier"), "fixture-verifier");
      return Response.json({ access_token: "access-initial", refresh_token: "refresh-initial", expires_in: 3600, scope: "playlist-read-private playlist-read-collaborative" });
    }
    assert.equal(u.hostname, "api.spotify.com"); assert.ok(!init?.method || init.method === "GET", "No upstream playlist writes");
    if (u.pathname === "/v1/me") return Response.json({ id: profileId, account_id: profileAccountId, display_name: "Spotify account" });
    if (u.pathname === "/v1/me/playlists") return Response.json({ items: [metadata(own), metadata(collab), metadata(followed)], total: 3, next: null });
    if (u.pathname === `/v1/playlists/${own}/items`) {
      pages++;
      if (providerError) return Response.json({ error: "provider-private-body" }, { status: providerError, headers: { "retry-after": "120" } });
      const offset = Number(u.searchParams.get("offset") ?? 0);
      return Response.json({ items: offset ? source.slice(2) : source.slice(0, 2), total: source.length, offset,
        next: offset ? null : `https://api.spotify.com/v1/playlists/${own}/items?limit=50&offset=2` });
    }
    const id = u.pathname.split("/").at(-1)!;
    if ([own, collab, followed].includes(id)) {
      const p = metadata(id);
      if (inconsistent && pages) p.snapshot_id = "changed";
      return Response.json(p);
    }
    throw new Error("Unexpected provider endpoint " + u.pathname);
  };
  try {
    await runMigrations("../../packages/core/migrations");
    await db.insert(schema.users).values([{ id: userId, email: `${userId}@fixture.invalid`, name: "Spotify fixture", passwordHash: "fixture", status: "active" },
      { id: otherId, email: `${otherId}@fixture.invalid`, name: "Other fixture", passwordHash: "fixture", status: "active" }]);
    const sessionHash = sha256("session-" + userId);
    await db.insert(schema.sessions).values({ id: sessionHash, userId, expiresAt: new Date(Date.now() + 60_000) });
    await t.test("OAuth state is hashed, encrypted, expiring, session-bound and consumed once", async () => {
      const auth = new URL(await beginSpotifyOAuth(db, userId, sessionHash, "https://mint.test/api/oauth/spotify/callback"));
      const state = auth.searchParams.get("state")!;
      const [stored] = await db.select().from(states).where(eq(states.hash, sha256(state)));
      assert.ok(stored); assert.notEqual(stored.verifierEnc, decrypt(stored.verifierEnc));
      assert.equal(await consumeSpotifyState(db, otherId, sessionHash, state), null);
      assert.equal(await consumeSpotifyState(db, userId, sha256("another-session"), state), null);
      const verifier = await consumeSpotifyState(db, userId, sessionHash, state);
      assert.ok(verifier);
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), auth.searchParams.get("code_challenge"));
      assert.equal(await consumeSpotifyState(db, userId, sessionHash, state), null);
      const expired = new URL(await beginSpotifyOAuth(db, userId, sessionHash, "https://mint.test/callback")).searchParams.get("state")!;
      await db.update(states).set({ expiresAt: new Date(0) }).where(eq(states.hash, sha256(expired)));
      assert.equal(await consumeSpotifyState(db, userId, sessionHash, expired), null);
    });
    await t.test("OAuth account connection encrypts both tokens and reads only authorized profile", async () => {
      await connectSpotifyAccount(db, userId, "fixture-code", "fixture-verifier", "https://mint.test/callback", transport);
      const [account] = await db.select().from(accounts).where(eq(accounts.userId, userId));
      assert.equal(decrypt(account!.accessTokenEnc), "access-initial");
      assert.equal(decrypt(account!.refreshTokenEnc), "refresh-initial");
      assert.equal(account!.providerAccountId, "stable-account");
    });
    await db.insert(schema.tracks).values([
      { id: trackIds[0], title: "Song", artist: "Artist", album: "Album", durationSec: 200, stage: "ready", filePath: "/fixture/song.flac", plexRatingKey: "1" },
      { id: trackIds[1], title: "Ambiguous", artist: "Artist", album: "Album", durationSec: 200, stage: "ready", existingFilePath: "/fixture/a.flac", existingLibraryKey: `${userId}:a` },
      { id: trackIds[2], title: "Ambiguous", artist: "Artist", album: "Album", durationSec: 200, stage: "ready", filePath: "/fixture/b.flac", plexRatingKey: "3" },
      { id: trackIds[3], title: "Missing", artist: "Artist", album: "Album", durationSec: 200, stage: "ready", filePath: "/fixture/not-plex.flac" },
    ]);
    let playlistId = "";
    await t.test("discovery filters inaccessible followed playlists, link import rejects them honestly", async () => {
      await syncSpotifyAccount(db, userId, { transport });
      const rows = await db.select().from(playlists).where(eq(playlists.userId, userId));
      assert.deepEqual(rows.map((p) => p.providerId).sort(), [own, collab].sort());
      await assert.rejects(() => importSpotifyPlaylist(db, userId, followed, transport), /own or collaborate/);
      playlistId = await importSpotifyPlaylist(db, userId, own, transport);
    });
    await t.test("full paged snapshot preserves provider order, duplicates and all explicit match states", async () => {
      await syncSpotifyAccount(db, userId, { transport });
      const view = await spotifyPlaylistView(db, userId, playlistId);
      assert.ok(view); assert.equal(view.playlist.sourceTotal, 5); assert.equal(view.playlist.matchedTotal, 2);
      assert.deepEqual(view.items.map((i) => i.position), [0, 1, 2, 3, 4]);
      assert.deepEqual(view.items.map((i) => i.status), ["matched", "matched", "missing", "unavailable", "ambiguous"]);
      assert.equal(view.items[0]!.trackId, trackIds[0]); assert.equal(view.items[1]!.trackId, trackIds[0]);
      assert.notEqual(view.items[0]!.id, view.items[1]!.id);
      assert.equal(view.items[0]!.addedBy, "provider-owner");
      assert.equal((await db.select({ id: schema.playlists.id }).from(schema.playlists).where(eq(schema.playlists.userId, userId))).length, 0, "Never writes YouTube source tables");
    });
    const successfulIds = (await spotifyPlaylistView(db, userId, playlistId))!.items.map((i) => i.id);
    await t.test("selection is owner-bound, retains disabled snapshots and enforces the account selection bound", async () => {
      await assert.rejects(() => setSpotifyPlaylistSelection(db, otherId, playlistId, false), /not found/);
      await setSpotifyPlaylistSelection(db, userId, playlistId, false);
      const before = network; await syncSpotifyAccount(db, userId, { transport, discover: false }); assert.equal(network, before);
      assert.deepEqual((await spotifyPlaylistView(db, userId, playlistId))!.items.map((i) => i.id), successfulIds);
      await setSpotifyPlaylistSelection(db, userId, playlistId, true);
      const fixtureIds = Array.from({ length: 500 }, () => randomUUID());
      await db.insert(playlists).values(fixtureIds.map((id, i) => ({ id, userId, providerId: `S${String(i).padStart(21, "0")}`,
        title: "Selection limit fixture", providerUrl: "https://open.spotify.com/playlist/fixture", syncEnabled: i < 499 })));
      try { await assert.rejects(() => setSpotifyPlaylistSelection(db, userId, fixtureIds[499]!, true), /at most 500/); }
      finally { await db.delete(playlists).where(inArray(playlists.id, fixtureIds)); }
    });
    await t.test("queue SQL/page returns only local matched songs with separate occurrence IDs, authorized per member", async () => {
      const page = await spotifyPlayablePage(db, userId, playlistId, { limit: 1, offset: 1 });
      assert.ok(page); assert.equal(page.total, 2); assert.equal(page.sourceTotal, 5); assert.equal(page.items[0]!.position, 1);
      const query = await spotifyQueueTrackSource(db, userId, playlistId);
      assert.ok(query);
      const rows = await db.execute(query);
      assert.equal(rows.rows.length, 2); assert.equal(rows.rows[0]!.track_id, trackIds[0]);
      assert.notEqual(rows.rows[0]!.source_occurrence_id, rows.rows[1]!.source_occurrence_id);
      assert.deepEqual(rows.rows.map((r) => r.original_position), [0, 1]);
      assert.equal(await spotifyPlayablePage(db, otherId, playlistId), null);
      await db.update(schema.users).set({ status: "disabled" }).where(eq(schema.users.id, userId));
      assert.equal(await spotifyPlayablePage(db, userId, playlistId), null);
      const before = network; await assert.rejects(() => syncSpotifyAccount(db, userId, { transport })); assert.equal(network, before);
      await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, userId));
    });
    await t.test("provider snapshot changes keep the last successful rows and expose playlist failure", async () => {
      inconsistent = true; pages = 0;
      await syncSpotifyAccount(db, userId, { transport, discover: false });
      const view = await spotifyPlaylistView(db, userId, playlistId);
      assert.deepEqual(view!.items.map((i) => i.id), successfulIds);
      assert.match(view!.playlist.error!, /changed during sync/); assert.equal(view!.playlist.snapshotId, "v1");
      inconsistent = false; pages = 0;
    });
    await t.test("429 respects Retry-After and token rotation survives snapshot rollback", async () => {
      await db.update(accounts).set({ expiresAt: new Date(0), status: "idle" }).where(eq(accounts.userId, userId));
      providerError = 429;
      await assert.rejects(() => syncSpotifyAccount(db, userId, { transport, discover: false }), /rate\/quota/);
      const [account] = await db.select().from(accounts).where(eq(accounts.userId, userId));
      assert.equal(account!.status, "rate_limited"); assert.ok(account!.nextSyncAt.getTime() >= Date.now() + 115_000);
      assert.equal(decrypt(account!.refreshTokenEnc), "refresh-1"); assert.equal(rotated, 1);
      assert.deepEqual((await spotifyPlaylistView(db, userId, playlistId))!.items.map((i) => i.id), successfulIds);
      const before = network; await assert.rejects(() => syncSpotifyAccount(db, userId, { transport })); assert.equal(network, before);
      providerError = 0;
      await db.update(accounts).set({ nextSyncAt: new Date(0) }).where(eq(accounts.userId, userId));
      await syncSpotifyAccount(db, userId, { transport, discover: false });
    });
    await t.test("unplayable local tracks are immediately excluded, and subsequent sync rematches", async () => {
      await db.update(schema.tracks).set({ stage: "failed" }).where(eq(schema.tracks.id, trackIds[0]!));
      assert.equal((await spotifyPlayablePage(db, userId, playlistId))!.total, 0);
      assert.equal((await spotifyPlaylistView(db, userId, playlistId))!.items[0]!.status, "missing");
      await db.update(schema.tracks).set({ stage: "ready" }).where(eq(schema.tracks.id, trackIds[0]!));
      snapshot = "v2"; await syncSpotifyAccount(db, userId, { transport, discover: false });
      assert.deepEqual((await spotifyPlaylistView(db, userId, playlistId))!.items.map((i) => i.id), successfulIds);
    });
    await t.test("concurrent sync serializes refresh token rotation without duplicate refresh calls", async () => {
      await db.update(accounts).set({ expiresAt: new Date(0) }).where(eq(accounts.userId, userId));
      const before = rotated;
      await Promise.all([syncSpotifyAccount(db, userId, { transport, discover: false }), syncSpotifyAccount(db, userId, { transport, discover: false })]);
      assert.equal(rotated, before + 1);
      assert.deepEqual((await spotifyPlaylistView(db, userId, playlistId))!.items.map((i) => i.id), successfulIds);
    });
    await t.test("extended mode explicitly uses authorized legacy tracks endpoint and track response field", async () => {
      process.env.SPOTIFY_API_MODE = "extended";
      let legacyCalls = 0;
      const extendedTransport: SpotifyFetch = async (input, init) => {
        const u = new URL(String(input));
        if (u.pathname === `/v1/playlists/${own}/tracks`) {
          legacyCalls++;
          return Response.json({ total: source.length, next: null, items: source.map(({ item, ...rest }) => ({ ...rest, track: item })) });
        }
        return transport(input, init);
      };
      try { await syncSpotifyAccount(db, userId, { transport: extendedTransport, discover: false }); }
      finally { process.env.SPOTIFY_API_MODE = "development"; }
      assert.equal(legacyCalls, 1);
      assert.deepEqual((await spotifyPlaylistView(db, userId, playlistId))!.items.map((i) => i.status), ["matched", "matched", "missing", "unavailable", "ambiguous"]);
    });
    await t.test("scheduled jobs revalidate auto-sync and revoked tokens stop further scheduled access", async () => {
      await db.update(accounts).set({ autoSync: false }).where(eq(accounts.userId, userId));
      const before = network; await syncSpotifyAccount(db, userId, { transport, scheduled: true }); assert.equal(network, before);
      await db.update(accounts).set({ autoSync: true, expiresAt: new Date(0) }).where(eq(accounts.userId, userId)); revocation = true;
      await assert.rejects(() => syncSpotifyAccount(db, userId, { transport }), /expired or was revoked/);
      assert.equal((await db.select().from(accounts).where(eq(accounts.userId, userId)))[0]!.status, "reconnect");
      assert.deepEqual((await spotifyPlaylistView(db, userId, playlistId))!.items.map((i) => i.id), successfulIds);
    });
    await t.test("immutable account identity survives mutable Spotify user ID changes; switching accounts drops old sources", async () => {
      revocation = false;
      profileId = "renamed-owner";
      await connectSpotifyAccount(db, userId, "fixture-code", "fixture-verifier", "https://mint.test/callback", transport);
      assert.equal((await db.select().from(accounts).where(eq(accounts.userId, userId)))[0]!.providerId, profileId);
      assert.deepEqual((await spotifyPlaylistView(db, userId, playlistId))!.items.map((i) => i.id), successfulIds);
      profileAccountId = "different-account";
      await connectSpotifyAccount(db, userId, "fixture-code", "fixture-verifier", "https://mint.test/callback", transport);
      assert.equal(await spotifyPlaylistView(db, userId, playlistId), null);
      assert.equal((await db.select().from(entries).where(eq(entries.playlistId, playlistId))).length, 0);
    });
    await t.test("disconnect removes source snapshots/tokens but never local library files or tracks", async () => {
      await disconnectSpotifyAccount(db, userId);
      assert.equal((await db.select().from(accounts).where(eq(accounts.userId, userId))).length, 0);
      assert.equal((await db.select().from(playlists).where(eq(playlists.userId, userId))).length, 0);
      assert.equal((await db.select().from(entries).where(eq(entries.playlistId, playlistId))).length, 0);
      assert.equal((await db.select().from(schema.tracks).where(inArray(schema.tracks.id, trackIds))).length, 4);
      assert.equal(await spotifyPlayablePage(db, userId, playlistId), null);
      const before = network; await assert.rejects(() => syncSpotifyAccount(db, userId, { transport })); assert.equal(network, before);
    });
  } finally {
    await db.delete(schema.users).where(inArray(schema.users.id, [userId, otherId]));
    await db.delete(schema.tracks).where(inArray(schema.tracks.id, trackIds));
    await closeDb();
  }
});
