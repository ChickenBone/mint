import fs from "node:fs/promises";
import path from "node:path";
import { jobId, type FinalizeJob } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { DelayedError, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { keepExisting, reusePendingTrack } from "../existing-track";
import { libraryIndexEnabled } from "../library-index";
import { isLosslessUpgrade } from "../library-policy";
import { exists } from "../files";
import { log } from "../log";
import { makeArtwork, probe, tagInto } from "../media";
import { safeSegment } from "../parse";
import { queues } from "../queues";
import { coverArtUrl } from "../services/musicbrainz";
import * as plex from "../services/plex";
import { stage, updateTrack } from "../track-state";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetches cover art into staging for embedding; the source URL is what the website shows. */
async function buildArtwork(track: typeof schema.tracks.$inferSelect): Promise<{ file: string; url: string } | null> {
  const dest = path.join(config.stagingDir, `${track.id}.cover.jpg`);
  const candidates = [
    track.artworkUrl,
    track.mbReleaseGroupId ? coverArtUrl(track.mbReleaseGroupId) : null,
    `https://i.ytimg.com/vi/${track.youtubeVideoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${track.youtubeVideoId}/hqdefault.jpg`,
  ].filter(Boolean) as string[];
  for (const src of candidates) {
    try {
      await makeArtwork(src, dest);
      return { file: dest, url: src };
    } catch {
      /* try next source */
    }
  }
  return null;
}

export async function processFinalize(job: Job<FinalizeJob>, token?: string) {
  const db = getDb();
  const track = await db.query.tracks.findFirst({ where: eq(schema.tracks.id, job.data.trackId) });
  if (!track) return { skipped: "deleted" };
  if (libraryIndexEnabled()) {
    const status = JSON.parse((await getRedis().get("mint:library-index")) ?? "null");
    if (status?.state !== "ready") {
      await stage(track.id, "queued", "Waiting for existing-library index; check Admin for errors");
      await job.moveToDelayed(Date.now() + 30_000, token);
      throw new DelayedError();
    }
    const reused = await reusePendingTrack(track);
    if (reused) return { reused };
  }
  if (!track.youtubeVideoId) throw new Error("Cannot finalize an indexed original as a download");
  if (track.existingFilePath) {
    const [original, candidate] = await Promise.all([probe(track.existingFilePath), probe(job.data.sourcePath)]);
    if (!isLosslessUpgrade(original.codec, candidate.codec) ||
      !original.durationSec || !candidate.durationSec || Math.abs(original.durationSec - candidate.durationSec) > 5) {
      await keepExisting(track, "Candidate was not a lossless-format upgrade");
      const relative = path.relative(config.stagingDir, job.data.sourcePath);
      if (!job.data.inLibrary && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        await fs.unlink(job.data.sourcePath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
        });
      }
      return { skipped: "not a lossless upgrade" };
    }
  }

  await stage(track.id, "tagging", "Tagging and artwork", 0.1);
  const cover = await buildArtwork(track);
  const art = cover?.file ?? null;
  if (cover) await updateTrack(track.id, { artworkUrl: cover.url });

  let filePath = job.data.sourcePath;
  if (!job.data.inLibrary || track.existingFilePath) {
    const album = track.album ?? `${track.title} (Single)`;
    const albumDir = track.existingFilePath
      ? path.join(config.musicDir, "upgrades", track.id)
      : path.join(config.musicDir, safeSegment(track.artist), safeSegment(album));
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
    if (!job.data.inLibrary) await fs.unlink(job.data.sourcePath).catch(() => undefined);
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
    ...(track.existingFilePath ? { sonicAnalyzed: false, plexRatingKey: null } : {}),
    progress: 1,
  });
  if (art) await fs.unlink(art).catch(() => undefined);

  if (!config.plexEnabled || config.plexReadOnly) {
    await updateTrack(track.id, {
      stage: "ready",
      detail: config.plexReadOnly ? "Saved separately; existing Plex is read-only" : null,
      readyAt: new Date(),
      progress: 1,
    }, config.plexReadOnly ? "Saved without changing existing Plex" : "Ready (Plex not configured)");
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
