import fs from "node:fs/promises";
import path from "node:path";
import { WORKER_ONLINE_MS, jobId, type AcquireJob, type FinalizeJob } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { catalogIdentityMatches, downloadedLengthMatches, supportingRecordingDuration, YoutubeSearchDeferredError } from "@mint/core/matching";
import { reconcileCatalogRecording } from "@mint/core/catalog-client";
import { youtubeScrapingAuthorized } from "@mint/core/youtube-scrape";
import { YoutubeTurns } from "@mint/core/youtube-pace";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { config } from "../config";
import { assignSourceVideo, keepExisting } from "../existing-track";
import { reusePendingTrack } from "../existing-track";
import { libraryIndexEnabled } from "../library-index";
import { getRedis } from "@mint/core/redis";
import { codecQuality } from "../library-policy";
import { probe, probePlayableAudio } from "../media";
import { downloadToFile } from "../files";
import { log } from "../log";
import { queues } from "../queues";
import * as cobalt from "../services/cobalt";
import * as lidarr from "../services/lidarr";
import { HttpError } from "../http";
import { matchRecording } from "../services/musicbrainz";
import { findRequestedVideo, NeedsSourceError, validateRequestedVideo } from "../services/youtube";
import { progress, stage, updateTrack } from "../track-state";
import { bridgeProgress, getRecord } from "./torbox-bridge";

// Partial test configs omit the gap; production config always sets it.
const youtubeTurns = new YoutubeTurns(config.youtubeImportGapMs ?? 0);

/** Waits for this worker's single YouTube import turn, showing why the track is not moving yet. */
async function youtubeTurn(trackId: string) {
  if (youtubeTurns.busy) await updateTrack(trackId, { detail: "Waiting for this worker's previous YouTube import" });
  return youtubeTurns.take();
}

/**
 * Hands a downloaded file to finalize. A finished finalize job for the same track would make BullMQ drop
 * the add, stranding a re-run (for example after a lost job lock) at "downloading 100%".
 */
async function queueFinalize(data: FinalizeJob) {
  const id = jobId.finalize(data.trackId);
  const previous = await queues.finalize.getJob(id);
  if (previous && ["completed", "failed"].includes(await previous.getState())) await previous.remove();
  await queues.finalize.add("finalize", data, { jobId: id });
}
async function onlineWorkers() {
  return getDb().$count(
    schema.workers,
    and(eq(schema.workers.status, "active"), gt(schema.workers.lastSeenAt, new Date(Date.now() - WORKER_ONLINE_MS))),
  );
}

async function shouldHandOff() {
  if (config.remoteMode === "never") return false;
  if (config.remoteMode === "always" || !process.env.COBALT_URL) return true;
  return (await onlineWorkers()) > 0;
}

async function approvedOwner(trackId: string, scraping: boolean) {
  const owners = getDb().select({ userId: schema.userTracks.userId }).from(schema.userTracks)
    .innerJoin(schema.users, and(eq(schema.users.id, schema.userTracks.userId), eq(schema.users.status, "active")));
  const [owner] = await (scraping ? owners : owners.innerJoin(schema.youtubeAccounts, eq(schema.youtubeAccounts.userId, schema.userTracks.userId)))
    .where(eq(schema.userTracks.trackId, trackId)).limit(1);
  return owner?.userId;
}

async function later(job: Job<AcquireJob>, token: string | undefined, data: AcquireJob, ms: number): Promise<never> {
  await job.updateData(data);
  await job.moveToDelayed(Date.now() + ms, token);
  throw new DelayedError();
}

/**
 * Catalog rows for the same recording: YouTube Music video IDs (checked before any search) and provider
 * lengths. Best-effort; matching proceeds without them when the catalog is absent or unavailable.
 */
async function catalogEvidence(track: { title: string; artist: string; album: string | null; durationSec: number | null; mbRecordingId: string | null }) {
  const result = await reconcileCatalogRecording({ title: track.title, artist: track.artist, album: track.album,
    durationSec: track.durationSec, musicbrainzRecordingId: track.mbRecordingId },
  { timeoutMs: 5_000, log: (message, detail) => log.warn(detail, message) }).catch((err: unknown) => {
    log.warn({ err }, "catalog reconciliation failed");
    return null;
  });
  if (result?.status !== "ok") return { videoIds: [], durationsSec: [] };
  const same = result.candidates.filter((candidate) =>
    !candidate.conflicts.some((conflict) => conflict === "title_mismatch" || conflict === "version_mismatch") &&
    catalogIdentityMatches(track, { title: candidate.title, artists: [{ name: candidate.artist }] }));
  const lengths = same.flatMap((candidate) => candidate.durationSec ? [candidate.durationSec] : []).sort((a, b) => a - b);
  return {
    videoIds: [...new Set(same.filter((candidate) => (candidate.source === "ytmusic" || candidate.source === "youtube") &&
      /^[A-Za-z0-9_-]{11}$/.test(candidate.providerId)).map((candidate) => candidate.providerId))].slice(0, 3),
    // Providers that disagree by more than 3s are not evidence of one length.
    durationsSec: lengths.length && lengths[lengths.length - 1]! - lengths[0]! <= 3 ? [lengths[Math.floor(lengths.length / 2)]!] : [],
  };
}

async function toCobalt(job: Job<AcquireJob>, token: string | undefined, reason: string) {
  let verifiedVideo: AcquireJob["verifiedVideo"];
  const track = await getDb().query.tracks.findFirst({ where: eq(schema.tracks.id, job.data.trackId) });
  if (track?.existingFilePath) {
    await keepExisting(track, `${reason}; YouTube cannot provide a verified lossless upgrade`);
    // Complete the state machine without downloading a lossy fallback.
    return later(job, token, { ...job.data, step: "match" }, 0);
  }
  if (track && !track.youtubeVideoId) {
    const scraping = youtubeScrapingAuthorized();
    const requester = job.data.requestedBy ?? await approvedOwner(track.id, scraping);
    if (!requester) throw new UnrecoverableError(scraping
      ? "This request needs an approved member for YouTube source lookup."
      : "This request needs a YouTube video URL, or a linked YouTube account for source lookup.");
    let videoId: string | null;
    let supportedDuration: number | null = null;
    const evidence = { ...track, officialDurationsSec: track.durationSec === null ? job.data.officialDurationsSec : undefined,
      catalogVideoIds: job.data.catalogVideoIds };
    const turn = await youtubeTurn(track.id);
    try {
      const aliases = await getDb().select({ id: schema.trackVideos.videoId }).from(schema.trackVideos).where(eq(schema.trackVideos.trackId, track.id)).limit(1);
      videoId = await findRequestedVideo(requester, evidence, {
        syncOrigin: aliases.length > 0,
        onSelected: (candidate) => { supportedDuration = supportingRecordingDuration(evidence, candidate); },
        blockedVideoIds: track.blockedVideoIds,
      });
      turn.release();
    } catch (error) {
      turn.release();
      if (error instanceof NeedsSourceError) await getDb().update(schema.tracks).set({ sourceChoices: error.choices }).where(eq(schema.tracks.id, track.id));
      if (error instanceof YoutubeSearchDeferredError) {
        await updateTrack(track.id, { stage: "queued", detail: error.message, progress: 0 });
        return later(job, token, job.data, error.delayMs);
      }
      const body = error instanceof HttpError ? error.body ?? "" : "";
      const busy = error instanceof HttpError && (error.status === 429 || error.status === 503 || (error.status === 403 && /quota|rate/i.test(`${error.message} ${body}`)));
      if (!busy) throw error;
      const waits = (job.data.youtubeWaits ?? 0) + 1;
      await updateTrack(track.id, { stage: "queued", detail: "YouTube is busy. The download will retry.", progress: 0 });
      return later(job, token, { ...job.data, youtubeWaits: waits }, Math.min(15 * 60_000, 60_000 * 2 ** Math.min(waits, 4)));
    }
    if (!videoId) throw new UnrecoverableError("No verified YouTube recording matched this request. Add a YouTube video URL and retry, or use Lidarr.");
    const owner = await assignSourceVideo(track.id, videoId);
    if (owner) return { linked: owner, skipped: "source already owned" };
    verifiedVideo = { id: videoId, at: Date.now() };
    if (track.sourceChoices) await getDb().update(schema.tracks).set({ sourceChoices: null }).where(eq(schema.tracks.id, track.id));
    if (track.durationSec === null && supportedDuration !== null) {
      await getDb().update(schema.tracks).set({ durationSec: supportedDuration })
        .where(and(eq(schema.tracks.id, track.id), isNull(schema.tracks.durationSec)));
    }
  }
  log.info({ trackId: job.data.trackId, reason }, "falling back to Cobalt");
  await stage(job.data.trackId, "downloading", `${reason} → YouTube via Cobalt`);
  return later(job, token, { ...job.data, step: "cobalt", ...(verifiedVideo ? { verifiedVideo } : {}) }, 0);
}

/** A selection made moments ago by this job already passed the same checks as pinned-source validation. */
const VERIFIED_VIDEO_TTL_MS = 30 * 60_000;

export async function processAcquire(job: Job<AcquireJob>, token?: string) {
  const db = getDb();
  const track = await db.query.tracks.findFirst({ where: eq(schema.tracks.id, job.data.trackId) });
  if (!track) return { skipped: "deleted" };
  if (track.stage === "ready" || (track.filePath && !track.existingFilePath)) return { skipped: "already acquired" };
  if (libraryIndexEnabled()) {
    const status = JSON.parse((await getRedis().get("mint:library-index")) ?? "null");
    if (status?.state !== "ready") {
      await stage(track.id, "queued", "Waiting for existing-library index; check Admin for errors");
      return later(job, token, job.data, 30_000);
    }
    const reused = await reusePendingTrack(track);
    if (reused) return { reused };
  }
  const step = job.data.step ?? "match";

  if (step === "match") {
    if (track.existingFilePath) {
      const original = await probe(track.existingFilePath);
      if (codecQuality(original.codec) !== "lossy") {
        await keepExisting({ ...track, existingCodec: original.codec }, "Original is lossless or its quality is unknown");
        return { skipped: "no verified quality upgrade" };
      }
      await updateTrack(track.id, { existingCodec: original.codec });
    }
    await db.update(schema.tracks).set({ attempts: sql`${schema.tracks.attempts} + 1` }).where(eq(schema.tracks.id, track.id));
    await stage(track.id, "matching", "Looking up MusicBrainz");
    let catalogFailure: unknown;
    const match = await matchRecording(track).catch((err: unknown) => {
      catalogFailure = err;
      log.warn({ err, trackId: track.id }, "musicbrainz lookup failed");
      return null;
    });
    const ambiguousRecording = !track.mbRecordingId && track.durationSec === null &&
      (match?.ambiguous || (match?.officialDurationsSec.length ?? 0) > 1);
    if (match) {
      await updateTrack(track.id, {
        ...(ambiguousRecording ? {} : { mbRecordingId: match.recordingId }),
        mbReleaseGroupId: match.releaseGroupId,
        mbArtistId: match.artistId,
        album: track.album ?? match.album,
        year: track.year ?? match.year,
        ...(track.durationSec === null && match.durationSec !== null ? { durationSec: match.durationSec } : {}),
      });
    }
    await stage(track.id, "matching", "Checking the metadata catalog");
    const catalog = await catalogEvidence({ ...track, album: track.album ?? match?.album ?? null,
      durationSec: track.durationSec ?? match?.durationSec ?? null, mbRecordingId: track.mbRecordingId ?? (ambiguousRecording ? null : match?.recordingId ?? null) });
    const knownLength = track.durationSec !== null || (!ambiguousRecording && match?.durationSec != null);
    await job.updateData({ ...job.data, catalogVideoIds: catalog.videoIds,
      officialDurationsSec: knownLength ? undefined : match?.officialDurationsSec.length ? match.officialDurationsSec : catalog.durationsSec });
    if (ambiguousRecording) return toCobalt(job, token, "Multiple official catalog recordings; resolving clean audio");
    if (!match) {
      try {
        return await toCobalt(job, token, catalogFailure ? "MusicBrainz unavailable; checking independent audio evidence" : "No MusicBrainz match");
      } catch (error) {
        if (catalogFailure && error instanceof UnrecoverableError) {
          throw new Error("Recording catalog is temporarily unavailable and independent audio evidence is insufficient. Matching will retry.",
            { cause: catalogFailure });
        }
        throw error;
      }
    }
    if (job.data.forceCobalt || !lidarr.lidarrEnabled()) return toCobalt(job, token, "Lidarr disabled");
    return later(job, token, { ...job.data, step: "lidarr-add" }, 0);
  }

  if (step === "lidarr-add") {
    await stage(track.id, "searching", `Searching for “${track.album ?? track.title}” via Lidarr`);
    const profile = track.existingFilePath ? await lidarr.losslessProfile() : null;
    if (track.existingFilePath && !profile) return toCobalt(job, token, "Lidarr needs a lossless-only quality profile");
    await lidarr.ensureArtist(track.mbArtistId!, profile ?? undefined);
    const album = await lidarr.findAlbum(track.mbReleaseGroupId!);
    if (!album) {
      // A freshly added artist needs a metadata refresh before its albums appear.
      const firstSeen = job.data.lidarrStartedAt ?? Date.now();
      if (Date.now() - firstSeen > 4 * 60_000) return toCobalt(job, token, "Album not in Lidarr metadata");
      return later(job, token, { ...job.data, lidarrStartedAt: firstSeen }, 20_000);
    }
    const existing = await lidarr.importedFile(album.id, { recordingId: track.mbRecordingId, title: track.title });
    if (existing) {
      await queueFinalize({ trackId: track.id, sourcePath: existing.path, source: "lidarr", inLibrary: true });
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
      await queueFinalize({ trackId: track.id, sourcePath: file.path, source: "lidarr", inLibrary: true });
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
  if (!track.youtubeVideoId) return toCobalt(job, token, "Resolving the requested recording's YouTube source");
  if (track.existingFilePath) return toCobalt(job, token, "No lossless source available");
  const scraping = youtubeScrapingAuthorized();
  const requester = job.data.requestedBy ?? await approvedOwner(track.id, scraping);
  if (!requester) throw new UnrecoverableError(scraping
    ? "This pinned source needs an approved member to verify its audio metadata."
    : "This pinned source needs an approved member with linked YouTube to verify its audio metadata.");
  const turn = await youtubeTurn(track.id);
  let dest: string;
  try {
    try {
      await validateRequestedVideo(requester, track, track.youtubeVideoId);
    } catch (error) {
      if (!(error instanceof YoutubeSearchDeferredError)) throw error;
      const verified = job.data.verifiedVideo;
      if (verified?.id === track.youtubeVideoId && Date.now() - verified.at <= VERIFIED_VIDEO_TTL_MS) {
        log.warn({ trackId: track.id, videoId: verified.id, reason: error.message },
          "YouTube re-validation deferred; using this job's fresh verified selection");
      } else {
        await updateTrack(track.id, { stage: "queued", detail: error.message, progress: 0 });
        return later(job, token, job.data, error.delayMs);
      }
    }
    if (!job.data.local && (await shouldHandOff())) {
      await updateTrack(
        track.id,
        { stage: "downloading", detail: "Waiting for a volunteer worker", progress: 0, remoteAt: new Date(), leaseId: null, leaseWorkerId: null, leaseExpiresAt: null },
        "Handed to the volunteer worker pool",
      );
      return { source: "remote" };
    }
    if (track.stage !== "downloading") await stage(track.id, "downloading", "YouTube via Cobalt");
    const { url, filename } = await cobalt.requestAudio(track.youtubeVideoId);
    const ext = path.extname(filename) || ".audio";
    dest = path.join(config.stagingDir, `${track.id}${ext}`);
    await downloadToFile(url, dest, (frac) => {
      if (frac !== null) void progress(track.id, frac, "YouTube via Cobalt");
    });
  } finally {
    turn.release();
  }
  let downloaded: Awaited<ReturnType<typeof probePlayableAudio>>;
  try {
    downloaded = await probePlayableAudio(dest);
  } catch (error) {
    await fs.unlink(dest).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    const reason = error instanceof Error ? error.message.replaceAll(dest, "downloaded file") : "ffprobe failed";
    throw new Error(`Cobalt returned invalid or incomplete media: ${reason}`, { cause: error });
  }
  if (!downloadedLengthMatches(track.durationSec, downloaded.durationSec)) {
    await fs.unlink(dest).catch(() => {});
    const rematches = (job.data.rematches ?? 0) + 1;
    log.warn({ trackId: track.id, videoId: track.youtubeVideoId, expected: track.durationSec, actual: downloaded.durationSec },
      "downloaded audio length does not match the recording; blocking the source and matching again");
    await getDb().update(schema.tracks).set({ youtubeVideoId: null,
      blockedVideoIds: sql`array_append(${schema.tracks.blockedVideoIds}, ${track.youtubeVideoId})` }).where(eq(schema.tracks.id, track.id));
    if (rematches > 2) throw new UnrecoverableError("Downloaded audio repeatedly did not match the recording length. Choose an audio URL and retry.");
    await stage(track.id, "matching", "Downloaded audio was a different length; finding another source");
    return later(job, token, { ...job.data, step: "match", verifiedVideo: undefined, rematches }, 0);
  }
  await queueFinalize({ trackId: track.id, sourcePath: dest, source: "cobalt", inLibrary: false });
  return { source: "cobalt" };
}

export async function onAcquireFailed(job: Job<AcquireJob> | undefined, err: Error) {
  if (!job) return;
  const final = err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (final) {
    const track = await getDb().query.tracks.findFirst({ where: eq(schema.tracks.id, job.data.trackId) });
    if (track?.existingFilePath) {
      await keepExisting(track, `Upgrade failed: ${err.message.slice(0, 200)}`);
      return;
    }
    await updateTrack(job.data.trackId, { stage: "failed", error: err.message.slice(0, 500),
      detail: err instanceof NeedsSourceError ? "Needs a source" : "Download failed" }, err.message);
  } else {
    await updateTrack(job.data.trackId, { detail: `Retrying: ${err.message.slice(0, 120)}` });
  }
}
