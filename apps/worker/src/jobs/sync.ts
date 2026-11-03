import { CHANNEL, jobId, publish, type SyncJob, type SyncState } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import type { Job } from "bullmq";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { log } from "../log";
import { parseIsoDuration, parseYoutubeMeta } from "../parse";
import { queues } from "../queues";
import * as yt from "../services/youtube";

const MUSIC_CATEGORY = "10";

async function emit(userId: string, state: SyncState) {
  await publish(getRedis(), CHANNEL.user(userId), { type: "sync", data: state });
}

/** Inserts unknown videos as tracks and queues them for acquisition. Returns track ids keyed by video id. */
async function upsertTracks(videos: yt.YtVideo[]): Promise<Map<string, string>> {
  const db = getDb();
  const ids = new Map<string, string>();
  if (!videos.length) return ids;
  const rows = videos.map((v) => {
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
  for (let i = 0; i < rows.length; i += 200) {
    const inserted = await db
      .insert(schema.tracks)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing({ target: schema.tracks.youtubeVideoId })
      .returning({ id: schema.tracks.id, videoId: schema.tracks.youtubeVideoId });
    if (inserted.length) {
      await queues.acquire.addBulk(
        inserted.map((t) => ({ name: "acquire", data: { trackId: t.id }, opts: { jobId: jobId.acquire(t.id) } })),
      );
    }
  }
  const all = await db
    .select({ id: schema.tracks.id, videoId: schema.tracks.youtubeVideoId })
    .from(schema.tracks)
    .where(inArray(schema.tracks.youtubeVideoId, videos.map((v) => v.id)));
  for (const t of all) ids.set(t.videoId, t.id);
  return ids;
}

export async function processSync(job: Job<SyncJob>) {
  const { userId } = job.data;
  const db = getDb();
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
    const likedIds = await upsertTracks(liked);
    const trackIds = [...likedIds.values()];
    if (trackIds.length) {
      await db
        .insert(schema.userTracks)
        .values(trackIds.map((trackId) => ({ userId, trackId })))
        .onConflictDoNothing();
    }
    // Un-liked songs leave the member's list; the files stay in the shared library.
    await db
      .delete(schema.userTracks)
      .where(and(eq(schema.userTracks.userId, userId), trackIds.length ? notInArray(schema.userTracks.trackId, trackIds) : sql`true`));

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
      const known = await db
        .select({ videoId: schema.tracks.youtubeVideoId })
        .from(schema.tracks)
        .where(videoIds.length ? inArray(schema.tracks.youtubeVideoId, videoIds) : sql`false`);
      const knownSet = new Set(known.map((k) => k.videoId));
      const fresh = await yt.videosById(token, videoIds.filter((id) => !knownSet.has(id)));
      const map = await upsertTracks(fresh);
      const all = await db
        .select({ id: schema.tracks.id, videoId: schema.tracks.youtubeVideoId })
        .from(schema.tracks)
        .where(videoIds.length ? inArray(schema.tracks.youtubeVideoId, videoIds) : sql`false`);
      for (const t of all) map.set(t.videoId, t.id);
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
    const message = err instanceof yt.YoutubeAuthError ? "YouTube access expired. Reconnect your account." : (err as Error).message;
    log.warn({ err, userId }, "sync failed");
    await db.update(schema.youtubeAccounts).set({ syncStatus: "error", syncError: message }).where(eq(schema.youtubeAccounts.userId, userId));
    await emit(userId, { status: "error", message });
    if (err instanceof yt.YoutubeAuthError) return { error: message };
    throw err;
  }
}
