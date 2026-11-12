import { CHANNEL, jobId, publish, type SyncJob, type SyncState } from "@mint/core";
import { getDb, schema, type Db } from "@mint/core/db";
import { audioSourceRejection, sameRecordingVersion, sourceKind } from "@mint/core/matching";
import { getRedis } from "@mint/core/redis";
import type { Job } from "bullmq";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { codecQuality, libraryMatchKey, sameRecording } from "../library-policy";
import { requestExistingUpgrade, reusePendingTrack } from "../existing-track";
import { libraryIndexEnabled, type LibraryIndexStatus } from "../library-index";
import { log } from "../log";
import { parseIsoDuration, parseYoutubeMeta } from "../parse";
import { queues } from "../queues";
import * as yt from "../services/youtube";

const MUSIC_CATEGORY = "10";

async function emit(userId: string, state: SyncState) {
  await publish(getRedis(), CHANNEL.user(userId), { type: "sync", data: state });
}

export function importedSource(video: yt.YtVideo) {
  const meta = parseYoutubeMeta(video);
  const durationSec = parseIsoDuration(video.durationIso);
  const candidate = yt.audioCandidate(video);
  // The upload's own length is not independent evidence, so unlabelled uploads are never clean imports.
  const clean = sameRecordingVersion("", video.title) && sourceKind(candidate) !== "unknown" &&
    !audioSourceRejection({ ...meta, durationSec }, candidate, true);
  return { ...meta, durationSec: clean ? durationSec : null, youtubeVideoId: clean ? video.id : null };
}

/** Alias ownership is committed before the map is consumed by likes/playlists. No provider searches. */
export async function upsertTracks(videos: yt.YtVideo[], userId: string, options: {
  db?: Db; enqueue?: (tracks: Array<{ id: string }>) => Promise<unknown>;
  indexReady?: () => Promise<void>; upgrade?: typeof requestExistingUpgrade;
} = {}): Promise<Map<string, string>> {
  const db = options.db ?? getDb();
  const ids = new Map<string, string>();
  if (!videos.length) return ids;
  if (options.indexReady) await options.indexReady();
  else if (libraryIndexEnabled()) {
    const raw = await getRedis().get("mint:library-index");
    const status = raw ? JSON.parse(raw) as LibraryIndexStatus : null;
    if (status?.state !== "ready") throw new Error("Existing library must finish indexing before syncing likes, to avoid duplicate downloads. Check Admin.");
  }
  const rows = videos.map((v): typeof schema.tracks.$inferInsert & { youtubeVideoId: string } => {
    const meta = parseYoutubeMeta(v);
    return {
      youtubeVideoId: v.id,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      year: meta.year,
      durationSec: parseIsoDuration(v.durationIso),
    };
  });
  const aliases = await db.select().from(schema.trackVideos).where(inArray(schema.trackVideos.videoId, videos.map((v) => v.id)));
  for (const alias of aliases) ids.set(alias.videoId, alias.trackId);
  const known = await db.select()
    .from(schema.tracks).where(inArray(schema.tracks.youtubeVideoId, videos.map((v) => v.id)));
  for (const t of known) if (t.youtubeVideoId) {
    ids.set(t.youtubeVideoId, (t.stage !== "failed" ? await reusePendingTrack(t) : null) ?? t.id);
  }
  const existing = await db.select().from(schema.tracks).where(and(
    isNotNull(schema.tracks.existingLibraryKey),
    inArray(schema.tracks.libraryMatchKey, rows.map((r) => libraryMatchKey(r.artist, r.title))),
  ));
  const existingById = new Map(existing.map((track) => [track.id, track]));
  const videoById = new Map(videos.map((video) => [video.id, video]));
  const byKey = new Map<string, typeof existing>();
  for (const track of existing) {
    const key = track.libraryMatchKey!;
    const group = byKey.get(key) ?? [];
    group.push(track);
    byKey.set(key, group);
  }
  for (const row of rows) {
    const video = videoById.get(row.youtubeVideoId)!;
    const source = importedSource(video);
    if (ids.has(row.youtubeVideoId)) {
      const original = existingById.get(ids.get(row.youtubeVideoId)!);
      if (original) await (options.upgrade ?? requestExistingUpgrade)(original, source.youtubeVideoId);
      continue;
    }
    const matches = (byKey.get(libraryMatchKey(row.artist, row.title)) ?? []).filter((t) =>
      sameRecording({ artist: row.artist, title: row.title, album: row.album ?? null, durationSec: row.durationSec ?? null, codec: null }, t));
    // Ambiguous editions are not silently treated as the same recording.
    const match = matches.find((t) => codecQuality(t.codec) === "lossless") ?? (matches.length === 1 ? matches[0] : undefined);
    if (!match) {
      if (byKey.has(libraryMatchKey(row.artist, row.title))) {
        row.stage = "failed";
        row.error = "Existing-library match needs review: album, duration or edition is ambiguous.";
        row.detail = "Duplicate download held for review";
      }
    }
    const stored = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video:${video.id}`}, 783))`);
      const [alias] = await tx.select().from(schema.trackVideos).where(eq(schema.trackVideos.videoId, video.id));
      const [known] = await tx.select().from(schema.tracks).where(eq(schema.tracks.youtubeVideoId, video.id));
      if (alias || known) return { id: alias?.trackId ?? known!.id, fresh: false, stage: known?.stage };
      let owner = match;
      let fresh = false;
      if (!owner) {
        [owner] = await tx.insert(schema.tracks).values({ ...row, ...source }).onConflictDoNothing().returning();
        fresh = Boolean(owner);
        if (!owner) [owner] = await tx.select().from(schema.tracks).where(eq(schema.tracks.youtubeVideoId, video.id));
      }
      if (!owner) throw new Error("Imported source ownership could not be resolved.");
      const [claimed] = await tx.insert(schema.trackVideos).values({ videoId: video.id, trackId: owner.id }).onConflictDoNothing().returning();
      if (!claimed) {
        const [aliasOwner] = await tx.select().from(schema.trackVideos).where(eq(schema.trackVideos.videoId, video.id));
        if (!aliasOwner) throw new Error("Imported source alias disappeared.");
        if (fresh && aliasOwner.trackId !== owner.id) await tx.delete(schema.tracks).where(eq(schema.tracks.id, owner.id));
        return { id: aliasOwner.trackId, fresh: false, stage: owner.stage };
      }
      return { id: owner.id, fresh, stage: owner.stage };
    });
    ids.set(video.id, stored.id);
    if (match && stored.id === match.id) await (options.upgrade ?? requestExistingUpgrade)(match, source.youtubeVideoId);
    if (stored.fresh && stored.stage !== "failed") {
      await (options.enqueue ?? ((tracks) => queues.acquire.addBulk(tracks.map((track) => ({
        name: "acquire", data: { trackId: track.id, requestedBy: userId }, opts: { jobId: jobId.acquire(track.id) },
      })))))([{ id: stored.id }]);
    }
  }
  return ids;
}

export async function processSync(job: Job<SyncJob>) {
  const { userId } = job.data;
  const db = getDb();
  const pending: Array<{ id: string }> = [];
  const enqueue = async (tracks: Array<{ id: string }>) => { pending.push(...tracks); };
  const flush = async () => {
    if (!pending.length) return;
    await queues.acquire.addBulk(pending.map((track) => ({
      name: "acquire", data: { trackId: track.id, requestedBy: userId }, opts: { jobId: jobId.acquire(track.id) },
    })));
    pending.length = 0;
  };
  const acct = await db.query.youtubeAccounts.findFirst({ where: eq(schema.youtubeAccounts.userId, userId) });
  if (!acct) return { skipped: "not linked" };

  await db.update(schema.youtubeAccounts).set({ syncStatus: "syncing", syncError: null }).where(eq(schema.youtubeAccounts.userId, userId));
  await emit(userId, { status: "syncing", message: "Reading your liked songs…" });

  try {
    const token = await yt.getAccessToken(userId);

    // Liked songs
    const liked: yt.YtVideo[] = [];
    for await (const v of yt.likedVideos(token)) {
      if (!acct.musicOnly || v.categoryId === MUSIC_CATEGORY) liked.push(v);
      if (liked.length % 100 === 0) await emit(userId, { status: "syncing", message: `Found ${liked.length} liked songs…`, found: liked.length });
    }
    const before = await db.$count(schema.userTracks, eq(schema.userTracks.userId, userId));
    const likedIds = await upsertTracks(liked, userId, { enqueue });
    const trackIds = [...likedIds.values()];
    if (trackIds.length) {
      await db
        .insert(schema.userTracks)
        .values([...new Set(trackIds)].map((trackId) => ({ userId, trackId })))
        .onConflictDoUpdate({ target: [schema.userTracks.userId, schema.userTracks.trackId], set: { origin: "youtube" } });
    }
    // Un-liked songs leave the member's list; the files stay in the shared library.
    await db
      .delete(schema.userTracks)
      .where(and(eq(schema.userTracks.userId, userId), eq(schema.userTracks.origin, "youtube"), trackIds.length ? notInArray(schema.userTracks.trackId, trackIds) : sql`true`));

    // Playlists
    await emit(userId, { status: "syncing", message: "Reading your playlists…", found: liked.length });
    const remote = await yt.listPlaylists(token);
    for (const p of remote) {
      await db
        .insert(schema.playlists)
        .values({ userId, youtubePlaylistId: p.id, title: p.title, description: p.description, artworkUrl: p.thumbnail, itemCount: p.itemCount })
        .onConflictDoUpdate({
          target: [schema.playlists.userId, schema.playlists.youtubePlaylistId],
          set: { title: p.title, description: p.description, artworkUrl: p.thumbnail, itemCount: p.itemCount },
        });
    }
    if (remote.length) {
      await db.delete(schema.playlists).where(
        and(eq(schema.playlists.userId, userId), notInArray(schema.playlists.youtubePlaylistId, remote.map((p) => p.id))),
      );
    }
    const enabled = await db.query.playlists.findMany({
      where: and(eq(schema.playlists.userId, userId), eq(schema.playlists.syncEnabled, true)),
    });
    for (const pl of enabled) {
      const videoIds = await yt.playlistVideoIds(token, pl.youtubePlaylistId);
      const fresh = await yt.videosById(token, videoIds);
      const map = await upsertTracks(fresh, userId, { enqueue });
      const all = await db
        .select({ id: schema.tracks.id, videoId: schema.tracks.youtubeVideoId })
        .from(schema.tracks)
        .where(videoIds.length ? inArray(schema.tracks.youtubeVideoId, videoIds) : sql`false`);
      for (const t of all) if (t.videoId) map.set(t.videoId, t.id);
      await db.transaction(async (tx) => {
        await tx.delete(schema.playlistTracks).where(eq(schema.playlistTracks.playlistId, pl.id));
        const seen = new Set<string>();
        const rows = videoIds
          .map((vid, position) => ({ playlistId: pl.id, trackId: map.get(vid)!, position }))
          .filter((r) => r.trackId && !seen.has(r.trackId) && seen.add(r.trackId));
        if (rows.length) await tx.insert(schema.playlistTracks).values(rows);
      });
    }

    const after = await db.$count(schema.userTracks, eq(schema.userTracks.userId, userId));
    await flush();
    const now = new Date();
    await db
      .update(schema.youtubeAccounts)
      .set({ syncStatus: "idle", syncError: null, lastSyncedAt: now })
      .where(eq(schema.youtubeAccounts.userId, userId));
    await emit(userId, {
      status: "idle",
      message: null,
      found: liked.length,
      added: Math.max(0, after - before),
      lastSyncedAt: now.toISOString(),
    });
    await publish(getRedis(), CHANNEL.user(userId), { type: "library", data: { trackIds } });
    await queues.maintenance.add(
      "plex-playlists",
      { kind: "plex-playlists", userId },
      { jobId: jobId.plexPlaylists(userId), delay: 30_000 },
    );
    return { liked: liked.length, added: after - before, playlists: remote.length };
  } catch (err) {
    await flush();
    const message = err instanceof yt.YoutubeAuthError ? "YouTube access expired. Reconnect your account." : (err as Error).message;
    log.warn({ err, userId }, "sync failed");
    await db.update(schema.youtubeAccounts).set({ syncStatus: "error", syncError: message }).where(eq(schema.youtubeAccounts.userId, userId));
    await emit(userId, { status: "error", message });
    if (err instanceof yt.YoutubeAuthError) return { error: message };
    throw err;
  }
}
