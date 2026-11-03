import { CHANNEL, jobId, publish, type SyncJob, type SyncState } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
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

/** Inserts unknown videos as tracks and queues them for acquisition. Returns track ids keyed by video id. */
async function upsertTracks(videos: yt.YtVideo[]): Promise<Map<string, string>> {
  const db = getDb();
  const ids = new Map<string, string>();
  if (!videos.length) return ids;
  if (libraryIndexEnabled()) {
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
  const fresh: typeof rows = [];
  const existingById = new Map(existing.map((track) => [track.id, track]));
  const byKey = new Map<string, typeof existing>();
  for (const track of existing) {
    const key = track.libraryMatchKey!;
    const group = byKey.get(key) ?? [];
    group.push(track);
    byKey.set(key, group);
  }
  for (const row of rows) {
    if (ids.has(row.youtubeVideoId)) {
      const original = existingById.get(ids.get(row.youtubeVideoId)!);
      if (original) await requestExistingUpgrade(original, row.youtubeVideoId);
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
      fresh.push(row);
      continue;
    }
    await db.insert(schema.trackVideos).values({ videoId: row.youtubeVideoId, trackId: match.id }).onConflictDoNothing();
    ids.set(row.youtubeVideoId, match.id);
    await requestExistingUpgrade(match, row.youtubeVideoId);
  }
  for (let i = 0; i < fresh.length; i += 200) {
    const inserted = await db
      .insert(schema.tracks)
      .values(fresh.slice(i, i + 200))
      .onConflictDoNothing({ target: schema.tracks.youtubeVideoId })
      .returning({ id: schema.tracks.id, stage: schema.tracks.stage });
    if (inserted.length) {
      await queues.acquire.addBulk(
        inserted.filter((t) => t.stage !== "failed").map((t) => ({ name: "acquire", data: { trackId: t.id }, opts: { jobId: jobId.acquire(t.id) } })),
      );
    }
  }
  const all = await db
    .select({ id: schema.tracks.id, videoId: schema.tracks.youtubeVideoId })
    .from(schema.tracks)
    .where(inArray(schema.tracks.youtubeVideoId, videos.map((v) => v.id)));
  for (const t of all) if (t.videoId) ids.set(t.videoId, t.id);
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
      const fresh = await yt.videosById(token, videoIds);
      const map = await upsertTracks(fresh);
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
