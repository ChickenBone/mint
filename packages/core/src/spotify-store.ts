import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { decrypt, encrypt, randomToken, sha256 } from "./crypto";
import { type Db, schema } from "./db/index";
import { spotifyAccounts as accounts, spotifyEntries as entries, spotifyOauthStates as states, spotifyPlaylists as playlists } from "./db/spotify";
import { PLAYABLE, UUID } from "./playback";
import { matchSpotifyItem, normalizeSpotifyItem, SPOTIFY_SCOPES, SpotifyClient, spotifyExtended, SpotifyError, spotifyMetadataKey,
  spotifyPlaylistSchema, spotifyTokenRequest, type SpotifyFetch, type SpotifyPlaylist, type SpotifySourceItem } from "./spotify";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const accountLock = (db: Tx, userId: string) => db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`spotify:${userId}`},0))`);
const localPlex = or(isNotNull(schema.tracks.plexRatingKey), isNotNull(schema.tracks.existingLibraryKey));

export async function beginSpotifyOAuth(db: Db, userId: string, sessionHash: string, redirectUri: string) {
  const state = randomToken(), verifier = randomToken(48);
  await db.delete(states).where(lte(states.expiresAt, new Date()));
  await db.insert(states).values({ hash: sha256(state), userId, sessionHash, verifierEnc: encrypt(verifier), expiresAt: new Date(Date.now() + 600_000) });
  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({ client_id: process.env.SPOTIFY_CLIENT_ID ?? "", response_type: "code",
    redirect_uri: redirectUri, scope: SPOTIFY_SCOPES.join(" "), state,
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
  return url.href;
}

export async function consumeSpotifyState(db: Db, userId: string, sessionHash: string, state: string) {
  if (!state || state.length > 200) return null;
  const [row] = await db.delete(states).where(and(eq(states.hash, sha256(state)), eq(states.userId, userId),
    eq(states.sessionHash, sessionHash), gt(states.expiresAt, new Date()))).returning();
  return row ? decrypt(row.verifierEnc) : null;
}

export async function connectSpotifyAccount(db: Db, userId: string, code: string, verifier: string, redirectUri: string, transport: SpotifyFetch = fetch) {
  const token = await spotifyTokenRequest(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }), transport);
  if (!SPOTIFY_SCOPES.every((scope) => token.scope?.split(" ").includes(scope))) throw new SpotifyError("Spotify playlist read permissions were not granted.");
  const client = new SpotifyClient(async () => token.access_token, transport);
  const profile = z.object({ id: z.string().min(1).max(200), account_id: z.string().min(1).max(200).optional(),
    display_name: z.string().max(1000).nullish() }).parse(await client.get("me"));
  await db.transaction(async (tx) => {
    await accountLock(tx, userId);
    const [existing] = await tx.select().from(accounts).where(eq(accounts.userId, userId));
    const same = existing && (profile.account_id && existing.providerAccountId ?
      profile.account_id === existing.providerAccountId : existing.providerId === profile.id);
    if (!token.refresh_token && !same) throw new SpotifyError("Spotify did not return a refresh token. Remove Mint in Spotify account permissions, then reconnect.");
    if (!same) await tx.delete(accounts).where(eq(accounts.userId, userId));
    const values = { providerId: profile.id, providerAccountId: profile.account_id ?? null, displayName: profile.display_name || profile.id,
      accessTokenEnc: encrypt(token.access_token), refreshTokenEnc: token.refresh_token ? encrypt(token.refresh_token) : existing!.refreshTokenEnc,
      expiresAt: new Date(Date.now() + token.expires_in * 1000), scope: token.scope!, status: "idle", error: null, nextSyncAt: new Date() };
    await tx.insert(accounts).values({ userId, ...values }).onConflictDoUpdate({ target: accounts.userId, set: values });
  });
}

export async function disconnectSpotifyAccount(db: Db, userId: string) {
  await db.transaction(async (tx) => {
    await accountLock(tx, userId);
    await tx.delete(states).where(eq(states.userId, userId));
    await tx.delete(accounts).where(eq(accounts.userId, userId));
  });
}

async function activeAccount(tx: Tx, userId: string) {
  const [row] = await tx.select({ account: accounts }).from(accounts).innerJoin(schema.users, eq(schema.users.id, accounts.userId))
    .where(and(eq(accounts.userId, userId), eq(schema.users.status, "active"))).limit(1);
  if (!row) throw new SpotifyError("Spotify account disconnected or Mint membership is inactive.");
  if (row.account.status === "reconnect") throw new SpotifyError("Reconnect Spotify before syncing.", 401);
  if (row.account.nextSyncAt > new Date() && row.account.status === "rate_limited")
    throw new SpotifyError("Spotify rate/quota cooldown is still active.", 429, Math.ceil((row.account.nextSyncAt.getTime() - Date.now()) / 1000));
  return row.account;
}

async function accountClient(tx: Tx, userId: string, transport: SpotifyFetch) {
  let account = await activeAccount(tx, userId);
  if (account.expiresAt.getTime() <= Date.now() + 60_000) {
    // Caller holds the transaction-scoped account lock, including refresh token rotation.
    const token = await spotifyTokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: decrypt(account.refreshTokenEnc) }), transport);
    const scope = token.scope ?? account.scope;
    if (!SPOTIFY_SCOPES.every((s) => scope.split(" ").includes(s))) throw new SpotifyError("Spotify read permissions changed. Reconnect your account.", 401);
    const values = { accessTokenEnc: encrypt(token.access_token),
      refreshTokenEnc: token.refresh_token ? encrypt(token.refresh_token) : account.refreshTokenEnc,
      expiresAt: new Date(Date.now() + token.expires_in * 1000), scope };
    await tx.update(accounts).set(values).where(eq(accounts.userId, userId));
    account = { ...account, ...values };
  }
  // Refresh outside snapshot savepoints so a later provider failure cannot roll back token rotation.
  return { account, client: new SpotifyClient(async () => decrypt(account.accessTokenEnc), transport) };
}

function assertReadable(playlist: SpotifyPlaylist, providerId: string) {
  if (!spotifyExtended() && playlist.owner.id !== providerId && !playlist.collaborative)
    throw new SpotifyError("Spotify development mode exposes contents only for playlists you own or collaborate on. Followed/editorial playlists cannot be imported.", 403);
}
async function upsertPlaylist(tx: Tx, userId: string, p: SpotifyPlaylist) {
  const values = { title: p.name, description: p.description ?? "", ownerName: p.owner.display_name ?? p.owner.id ?? null,
    providerUrl: `https://open.spotify.com/playlist/${p.id}` };
  const [row] = await tx.insert(playlists).values({ userId, providerId: p.id, ...values })
    .onConflictDoUpdate({ target: [playlists.userId, playlists.providerId], set: values }).returning();
  return row!;
}
async function setSelection(tx: Tx, userId: string, id: string, enabled: boolean) {
  const [row] = await tx.select({ id: playlists.id }).from(playlists).innerJoin(schema.users, eq(schema.users.id, playlists.userId))
    .where(and(eq(playlists.id, id), eq(playlists.userId, userId), eq(schema.users.status, "active"))).limit(1);
  if (!row) throw new SpotifyError("Spotify source not found or membership is inactive.");
  if (enabled) {
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(playlists)
      .where(and(eq(playlists.userId, userId), eq(playlists.syncEnabled, true), ne(playlists.id, id)));
    if (Number(count?.total ?? 0) >= 500) throw new SpotifyError("Select at most 500 Spotify playlists. Turn another playlist off first.");
  }
  await tx.update(playlists).set({ syncEnabled: enabled }).where(eq(playlists.id, id));
}
export async function setSpotifyPlaylistSelection(db: Db, userId: string, id: string, enabled: boolean) {
  if (!UUID.test(id)) throw new SpotifyError("Invalid Spotify source identifier.");
  await db.transaction(async (tx) => { await accountLock(tx, userId); await setSelection(tx, userId, id, enabled); });
}
function occurrenceId(playlistId: string, identity: string, ordinal: number) {
  const h = sha256(`${playlistId}:${identity}:${ordinal}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function syncPlaylist(tx: Tx, userId: string, providerId: string, playlist: typeof playlists.$inferSelect, client: SpotifyClient) {
  const before = await client.playlist(playlist.providerId);
  assertReadable(before, providerId);
  const source: SpotifySourceItem[] = [];
  const path = `playlists/${playlist.providerId}/${spotifyExtended() ? "tracks" : "items"}?limit=50&offset=0`;
  for await (const page of client.pages(path)) source.push(...page.map(normalizeSpotifyItem));
  const after = await client.playlist(playlist.providerId);
  assertReadable(after, providerId);
  if (!before.snapshot_id || before.snapshot_id !== after.snapshot_id) throw new SpotifyError("Spotify playlist changed during sync. The previous successful snapshot was kept; try again.");
  await activeAccount(tx, userId);
  const titles = [...new Set(source.filter((i) => !i.unavailable).map((i) => spotifyMetadataKey(i.title)))];
  const tracks = schema.tracks;
  const candidates = titles.length ? await tx.select({ id: tracks.id, title: tracks.title, artist: tracks.artist, album: tracks.album,
    durationSec: sql<number | null>`coalesce(${tracks.existingDurationSec},${tracks.durationSec})` })
    .from(tracks).where(and(PLAYABLE, localPlex,
      inArray(sql`trim(regexp_replace(lower(normalize(${tracks.title}, NFKC)), '[^[:alnum:]]+', ' ', 'g'))`, titles))).limit(50_001) : [];
  if (candidates.length > 50_000) throw new SpotifyError("Local match candidate limit exceeded. The previous snapshot was kept.");
  const grouped = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = spotifyMetadataKey(candidate.title);
    const group = grouped.get(key) ?? []; group.push(candidate); grouped.set(key, group);
  }
  const occurrences = new Map<string, number>();
  const values = source.map((item, position) => {
    const identity = JSON.stringify([item.providerUri ?? item.providerId ?? item.title, item.addedAt, item.addedBy]);
    const ordinal = occurrences.get(identity) ?? 0; occurrences.set(identity, ordinal + 1);
    const { unavailable: _, ...metadata } = item;
    return { ...metadata, playlistId: playlist.id, position, id: occurrenceId(playlist.id, identity, ordinal),
      ...matchSpotifyItem(item, grouped.get(spotifyMetadataKey(item.title)) ?? []) };
  });
  // Only a completely read, version-consistent provider snapshot replaces the previous one.
  await tx.delete(entries).where(eq(entries.playlistId, playlist.id));
  for (let i = 0; i < values.length; i += 250) await tx.insert(entries).values(values.slice(i, i + 250));
  await tx.update(playlists).set({ title: after.name, description: after.description ?? "", snapshotId: after.snapshot_id,
    sourceTotal: values.length, matchedTotal: values.filter((v) => v.status === "matched").length,
    lastSyncedAt: new Date(), status: "synced", error: null }).where(eq(playlists.id, playlist.id));
}

function safeError(error: unknown) {
  return error instanceof SpotifyError ? error.message : "Spotify sync failed. The last successful snapshot was kept. Retry or check the worker diagnostics.";
}
async function recordFailure(db: Db | Tx, userId: string, error: unknown, playlistId?: string) {
  const reconnect = error instanceof SpotifyError && [400, 401].includes(error.status);
  const rate = error instanceof SpotifyError && error.status === 429;
  await db.update(accounts).set({ status: reconnect ? "reconnect" : rate ? "rate_limited" : "error", error: safeError(error),
    nextSyncAt: new Date(Date.now() + (rate ? error.retryAfterSeconds : 30 * 60) * 1000) }).where(eq(accounts.userId, userId));
  if (playlistId) await db.update(playlists).set({ status: "error", error: safeError(error) })
    .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)));
}

/** Discovers metadata, then syncs selected playlists. No acquisition queue or upstream write is used. */
export async function syncSpotifyAccount(db: Db, userId: string, options: { transport?: SpotifyFetch; discover?: boolean; playlistId?: string; scheduled?: boolean } = {}) {
  const failure = await db.transaction(async (outer) => {
    await accountLock(outer, userId);
    try {
      if (options.scheduled && !(await activeAccount(outer, userId)).autoSync) return null;
      const { account, client } = await accountClient(outer, userId, options.transport ?? fetch);
      return await outer.transaction(async (tx) => {
        if (options.discover !== false) {
          for await (const page of client.pages("me/playlists?limit=50&offset=0", 5_000)) for (const raw of page) {
            const playlist = spotifyPlaylistSchema.parse(raw);
            if (spotifyExtended() || playlist.owner.id === account.providerId || playlist.collaborative) await upsertPlaylist(tx, userId, playlist);
          }
        }
        const selected = await tx.select().from(playlists).where(and(eq(playlists.userId, userId), eq(playlists.syncEnabled, true),
          options.playlistId ? eq(playlists.id, options.playlistId) : undefined))
          .orderBy(sql`${playlists.lastSyncedAt} asc nulls first`, asc(playlists.id)).limit(501);
        if (selected.length > 500) throw new SpotifyError("Select at most 500 Spotify playlists.");
        let failed = 0;
        for (const playlist of selected) {
          // Savepoints isolate a failed playlist; successful snapshots and rotated tokens still persist.
          try { await tx.transaction((savepoint) => syncPlaylist(savepoint, userId, account.providerId, playlist, client)); }
          catch (error) {
            failed++;
            await tx.update(playlists).set({ status: "error", error: safeError(error) }).where(eq(playlists.id, playlist.id));
            if (error instanceof SpotifyError && [400, 401, 403, 429].includes(error.status)) {
              await recordFailure(tx, userId, error, playlist.id);
              return { message: safeError(error), status: error.status };
            }
          }
        }
        await tx.update(accounts).set({ status: failed ? "partial" : "idle", error: failed ? `${failed} selected playlist(s) could not sync. See their status below.` : null, lastSyncedAt: new Date(),
          nextSyncAt: new Date(Date.now() + 30 * 60_000) }).where(eq(accounts.userId, userId));
        return null;
      });
    } catch (error) { await recordFailure(outer, userId, error, options.playlistId); return { message: safeError(error), status: error instanceof SpotifyError ? error.status : 0 }; }
  });
  if (failure) throw new SpotifyError(failure.message, failure.status);
}

/** Import by link only reads a provider-authorized playlist; selection is independent of YouTube sources. */
export async function importSpotifyPlaylist(db: Db, userId: string, providerId: string, transport: SpotifyFetch = fetch) {
  const result = await db.transaction(async (outer) => {
    await accountLock(outer, userId);
    try {
      const { account, client } = await accountClient(outer, userId, transport);
      const id = await outer.transaction(async (tx) => {
        const p = await client.playlist(providerId);
        assertReadable(p, account.providerId);
        const row = await upsertPlaylist(tx, userId, p);
        await setSelection(tx, userId, row.id, true);
        return row.id;
      });
      return { id };
    } catch (error) { await recordFailure(outer, userId, error); return { error: safeError(error) }; }
  });
  if (!result.id) throw new SpotifyError(result.error ?? "Spotify playlist import failed.");
  return result.id;
}

export async function spotifyAccountView(db: Db, userId: string) {
  const [row] = await db.select({ displayName: accounts.displayName, autoSync: accounts.autoSync, status: accounts.status,
    error: accounts.error, lastSyncedAt: accounts.lastSyncedAt, nextSyncAt: accounts.nextSyncAt })
    .from(accounts).where(eq(accounts.userId, userId)).limit(1);
  return row ?? null;
}

/** Authorized queue SQL; callers materialize within their queue transaction. No distinct: repeats are intentional. */
export async function spotifyPlayableQuery(db: Db, userId: string, playlistId: string): Promise<{ title: string; total: number; sourceTotal: number; query: SQL } | null> {
  if (!UUID.test(playlistId) || !UUID.test(userId)) return null;
  const [playlist] = await db.select({ title: playlists.title, sourceTotal: playlists.sourceTotal }).from(playlists)
    .innerJoin(accounts, eq(accounts.userId, playlists.userId)).innerJoin(schema.users, eq(schema.users.id, playlists.userId))
    .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId), eq(schema.users.status, "active"))).limit(1);
  if (!playlist) return null;
  const query = sql`select ${entries.trackId} as track_id, ${entries.id} as occurrence_id, ${entries.position} as position
    from ${entries} inner join ${schema.tracks} on ${schema.tracks.id} = ${entries.trackId}
    inner join ${playlists} on ${playlists.id} = ${entries.playlistId}
    inner join ${accounts} on ${accounts.userId} = ${playlists.userId}
    inner join ${schema.users} on ${schema.users.id} = ${playlists.userId}
    where ${entries.playlistId} = ${playlistId} and ${playlists.userId} = ${userId} and ${schema.users.status} = 'active'
      and ${entries.status} = 'matched' and ${PLAYABLE} and ${localPlex}
    order by ${entries.position}, ${entries.id}`;
  const count = await db.execute(sql`select count(*)::int as total from (${query}) as playable`);
  return { ...playlist, total: Number(count.rows[0]?.total ?? 0), query };
}

export async function spotifyPlayablePage(db: Db, userId: string, playlistId: string, options: { offset?: number; limit?: number } = {}) {
  const selection = await spotifyPlayableQuery(db, userId, playlistId);
  if (!selection) return null;
  const offset = Math.max(0, Math.min(10_000, Math.floor(options.offset ?? 0)));
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const rows = await db.execute(sql`${selection.query} limit ${limit} offset ${offset}`);
  return { title: selection.title, total: selection.total, sourceTotal: selection.sourceTotal,
    items: rows.rows.map((r) => ({ trackId: String(r.track_id), occurrenceId: String(r.occurrence_id), position: Number(r.position) })) };
}

/** Id-only source for the shared progressive queue materializer; source occurrences retain duplicates. */
export async function spotifyQueueTrackSource(db: Db, userId: string, playlistId: string): Promise<SQL | null> {
  const source = await spotifyPlayableQuery(db, userId, playlistId);
  return source ? sql`select track_id, occurrence_id as source_occurrence_id, position as original_position from (${source.query}) as spotify_source order by position, occurrence_id` : null;
}

export async function spotifyPlaylistView(db: Db, userId: string, playlistId: string, page = 0) {
  if (!UUID.test(playlistId)) return null;
  const [playlist] = await db.select().from(playlists).where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId))).limit(1);
  if (!playlist) return null;
  const rows = await db.select({ entry: entries, playable: sql<boolean>`(${PLAYABLE} and ${localPlex}) is true` })
    .from(entries).leftJoin(schema.tracks, eq(schema.tracks.id, entries.trackId)).where(eq(entries.playlistId, playlistId))
    .orderBy(asc(entries.position)).offset(Math.max(0, Math.min(100, page)) * 100).limit(100);
  return { playlist, items: rows.map(({ entry, playable }) => entry.status === "matched" && !playable ?
    { ...entry, status: "missing" as const, trackId: null, reason: "Previously matched local file is no longer playable. Sync to match again." } : entry) };
}
