import path from "node:path";
import { jobId, type AcquireJob } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { DelayedError, type Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { config } from "../config";
import { downloadToFile } from "../files";
import { log } from "../log";
import { queues } from "../queues";
import * as cobalt from "../services/cobalt";
import * as lidarr from "../services/lidarr";
import { matchRecording } from "../services/musicbrainz";
import { progress, stage, updateTrack } from "../track-state";
import { bridgeProgress, getRecord } from "./torbox-bridge";

async function later(job: Job<AcquireJob>, token: string | undefined, data: AcquireJob, ms: number): Promise<never> {
  await job.updateData(data);
  await job.moveToDelayed(Date.now() + ms, token);
  throw new DelayedError();
}

async function toCobalt(job: Job<AcquireJob>, token: string | undefined, reason: string): Promise<never> {
  log.info({ trackId: job.data.trackId, reason }, "falling back to Cobalt");
  await stage(job.data.trackId, "downloading", `${reason} → YouTube via Cobalt`);
  return later(job, token, { ...job.data, step: "cobalt" }, 0);
}

export async function processAcquire(job: Job<AcquireJob>, token?: string) {
  const db = getDb();
  const track = await db.query.tracks.findFirst({ where: eq(schema.tracks.id, job.data.trackId) });
  if (!track) return { skipped: "deleted" };
  if (track.stage === "ready" || track.filePath) return { skipped: "already acquired" };
  const step = job.data.step ?? "match";

  if (step === "match") {
    await db.update(schema.tracks).set({ attempts: sql`${schema.tracks.attempts} + 1` }).where(eq(schema.tracks.id, track.id));
    await stage(track.id, "matching", "Looking up MusicBrainz");
    const match = await matchRecording(track).catch((err) => {
      log.warn({ err, trackId: track.id }, "musicbrainz lookup failed");
      return null;
    });
    if (match) {
      await updateTrack(track.id, {
        mbRecordingId: match.recordingId,
        mbReleaseGroupId: match.releaseGroupId,
        mbArtistId: match.artistId,
        album: track.album ?? match.album,
        year: track.year ?? match.year,
      });
    }
    if (job.data.forceCobalt || !lidarr.lidarrEnabled()) return toCobalt(job, token, "Lidarr disabled");
    if (!match) return toCobalt(job, token, "No MusicBrainz match");
    return later(job, token, { ...job.data, step: "lidarr-add" }, 0);
  }

  if (step === "lidarr-add") {
    await stage(track.id, "searching", `Searching for “${track.album ?? track.title}” via Lidarr`);
    await lidarr.ensureArtist(track.mbArtistId!);
    const album = await lidarr.findAlbum(track.mbReleaseGroupId!);
    if (!album) {
      // A freshly added artist needs a metadata refresh before its albums appear.
      const firstSeen = job.data.lidarrStartedAt ?? Date.now();
      if (Date.now() - firstSeen > 4 * 60_000) return toCobalt(job, token, "Album not in Lidarr metadata");
      return later(job, token, { ...job.data, lidarrStartedAt: firstSeen }, 20_000);
    }
    const existing = await lidarr.importedFile(album.id, { recordingId: track.mbRecordingId, title: track.title });
    if (existing) {
      await queues.finalize.add("finalize", { trackId: track.id, sourcePath: existing.path, source: "lidarr", inLibrary: true }, { jobId: jobId.finalize(track.id) });
      return { album: album.id, existing: true };
    }
    await lidarr.monitorAndSearch(album.id);
    return later(job, token, { ...job.data, step: "lidarr-wait", lidarrAlbumId: album.id, lidarrStartedAt: Date.now() }, 15_000);
  }

  if (step === "lidarr-wait") {
    const albumId = job.data.lidarrAlbumId!;
    const startedAt = job.data.lidarrStartedAt ?? Date.now();
    const elapsed = Date.now() - startedAt;
    const file = await lidarr.importedFile(albumId, { recordingId: track.mbRecordingId, title: track.title });
    if (file) {
      await stage(track.id, "importing", "Imported by Lidarr", 1);
      await queues.finalize.add("finalize", { trackId: track.id, sourcePath: file.path, source: "lidarr", inLibrary: true }, { jobId: jobId.finalize(track.id) });
      return { album: albumId };
    }
    const queue = await lidarr.queueForAlbum(albumId);
    const item = queue[0];
    if (item) {
      const rec = await getRecord(item.title);
      if (rec?.phase === "error") return toCobalt(job, token, `TorBox: ${rec.error ?? "failed"}`);
      if (/importPending|importing/i.test(item.trackedDownloadState ?? "")) {
        await stage(track.id, "importing", "Lidarr is importing the album", 0.9);
      } else {
        const frac = rec ? bridgeProgress(rec) : item.size ? 1 - item.sizeleft / item.size : 0;
        const detail = rec ? `TorBox · ${rec.phase === "remote" ? rec.state : "transferring"}` : `Lidarr · ${item.status}`;
        if (track.stage !== "downloading") await stage(track.id, "downloading", detail, frac);
        else await progress(track.id, frac, detail);
      }
      if (/failed/i.test(item.trackedDownloadState ?? "") && elapsed > config.lidarrGrabTimeoutMs) {
        return toCobalt(job, token, "Lidarr import failed");
      }
    } else if (elapsed > config.lidarrGrabTimeoutMs) {
      return toCobalt(job, token, "No album release found");
    }
    if (elapsed > config.lidarrTotalTimeoutMs) return toCobalt(job, token, "Album download timed out");
    return later(job, token, job.data, 15_000);
  }

  // step === "cobalt"
  if (track.stage !== "downloading") await stage(track.id, "downloading", "YouTube via Cobalt");
  const { url, filename } = await cobalt.requestAudio(track.youtubeVideoId);
  const ext = path.extname(filename) || ".audio";
  const dest = path.join(config.stagingDir, `${track.id}${ext}`);
  await downloadToFile(url, dest, (frac) => {
    if (frac !== null) void progress(track.id, frac, "YouTube via Cobalt");
  });
  await queues.finalize.add("finalize", { trackId: track.id, sourcePath: dest, source: "cobalt", inLibrary: false }, { jobId: jobId.finalize(track.id) });
  return { source: "cobalt" };
}

export async function onAcquireFailed(job: Job<AcquireJob> | undefined, err: Error) {
  if (!job) return;
  const final = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (final) {
    await updateTrack(job.data.trackId, { stage: "failed", error: err.message.slice(0, 500), detail: "Download failed" }, err.message);
  } else {
    await updateTrack(job.data.trackId, { detail: `Retrying: ${err.message.slice(0, 120)}` });
  }
}
