import fs from "node:fs/promises";
import path from "node:path";
import { jobId, type FinalizeJob } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { exists } from "../files";
import { log } from "../log";
import { makeArtwork, makePreview, probe, tagInto } from "../media";
import { safeSegment } from "../parse";
import { queues } from "../queues";
import { coverArtUrl } from "../services/musicbrainz";
import * as plex from "../services/plex";
import { stage, updateTrack } from "../track-state";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function buildArtwork(track: typeof schema.tracks.$inferSelect): Promise<string | null> {
  const dest = path.join(config.previewDir, "art", `${track.id}.jpg`);
  const candidates = [
    track.mbReleaseGroupId ? coverArtUrl(track.mbReleaseGroupId) : null,
    `https://i.ytimg.com/vi/${track.youtubeVideoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${track.youtubeVideoId}/hqdefault.jpg`,
  ].filter(Boolean) as string[];
  for (const src of candidates) {
    try {
      await makeArtwork(src, dest);
      return dest;
    } catch {
      /* try next source */
    }
  }
  return null;
}

export async function processFinalize(job: Job<FinalizeJob>) {
  const db = getDb();
  const track = await db.query.tracks.findFirst({ where: eq(schema.tracks.id, job.data.trackId) });
  if (!track) return { skipped: "deleted" };

  await stage(track.id, "tagging", "Tagging and artwork", 0.1);
  const art = await buildArtwork(track);
  if (art) await updateTrack(track.id, { hasArtwork: true });

  let filePath = job.data.sourcePath;
  if (!job.data.inLibrary) {
    const album = track.album ?? `${track.title} (Single)`;
    const albumDir = path.join(config.musicDir, safeSegment(track.artist), safeSegment(album));
    filePath = await tagInto(
      job.data.sourcePath,
      path.join(albumDir, safeSegment(track.title)),
      {
        title: track.title,
        artist: track.artist,
        albumArtist: track.artist,
        album,
        year: track.year,
        mbRecordingId: track.mbRecordingId,
        mbReleaseGroupId: track.mbReleaseGroupId,
        mbArtistId: track.mbArtistId,
        youtubeVideoId: track.youtubeVideoId,
      },
      art,
    );
    const folderCover = path.join(albumDir, "cover.jpg");
    if (art && !(await exists(folderCover))) await fs.copyFile(art, folderCover);
    await fs.unlink(job.data.sourcePath).catch(() => undefined);
  }

  const info = await probe(filePath);
  const stat = await fs.stat(filePath);
  await updateTrack(track.id, {
    filePath,
    source: job.data.source,
    workerId: job.data.workerId ?? track.workerId,
    bytes: stat.size,
    codec: info.codec,
    durationSec: info.durationSec ?? track.durationSec,
  });

  await stage(track.id, "previewing", "Cutting 30s preview", 0.5);
  await makePreview(filePath, path.join(config.previewDir, `${track.id}.mp3`), config.previewSeconds);
  await updateTrack(track.id, { hasPreview: true, progress: 1 });

  if (!config.plexEnabled) {
    await updateTrack(track.id, { stage: "ready", detail: null, readyAt: new Date(), progress: 1 }, "Ready (Plex not configured)");
    return { filePath };
  }

  await stage(track.id, "scanning", "Waiting for Plex to pick it up");
  await plex.refreshPath(path.dirname(filePath));
  const deadline = Date.now() + config.plexScanTimeoutMs;
  let found: Awaited<ReturnType<typeof plex.findTrackByFile>> = null;
  for (let i = 0; Date.now() < deadline; i++) {
    await sleep(Math.min(15_000, 3_000 + i * 1_000));
    found = await plex.findTrackByFile(filePath, track.title).catch(() => null);
    if (found) break;
  }
  if (found) {
    await updateTrack(track.id, { plexRatingKey: found.ratingKey, readyAt: new Date() });
    if (!plex.isSonicallyAnalyzed(found)) await plex.analyze(found.ratingKey).catch((err) => log.warn({ err }, "plex analyze failed"));
  } else {
    log.warn({ trackId: track.id }, "plex scan timeout; sonic watcher will keep looking");
  }

  await stage(track.id, "analyzing", "Plex sonic analysis");
  await queues.sonic.add("sonic", { trackId: track.id, startedAt: Date.now() }, { jobId: jobId.sonic(track.id), delay: 30_000 });

  const owners = await db.select({ userId: schema.userTracks.userId }).from(schema.userTracks).where(eq(schema.userTracks.trackId, track.id));
  for (const { userId } of owners) {
    await queues.maintenance.add("plex-playlists", { kind: "plex-playlists", userId }, { jobId: jobId.plexPlaylists(userId), delay: 60_000 });
  }
  return { filePath, ratingKey: found?.ratingKey ?? null };
}
