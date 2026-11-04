import { jobId } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, eq, isNotNull } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { codecQuality, libraryMatchKey, sameRecording } from "./library-policy";
import { libraryIndexEnabled } from "./library-index";
import { queues } from "./queues";
import { updateTrack } from "./track-state";

export async function keepExisting(track: typeof schema.tracks.$inferSelect, reason: string) {
  if (!track.existingFilePath) throw new Error("No existing original to preserve");
  const original = await stat(track.existingFilePath);
  await updateTrack(track.id, {
    stage: "ready",
    filePath: track.existingFilePath,
    codec: track.existingCodec,
    bytes: original.size,
    durationSec: track.existingDurationSec,
    sonicAnalyzed: track.existingSonicAnalyzed,
    plexRatingKey: track.existingLibraryKey?.split(":").at(-1) ?? null,
    source: null,
    workerId: null,
    readyAt: track.readyAt ?? new Date(),
    error: null,
    remoteAt: null,
    leaseId: null,
    leaseWorkerId: null,
    leaseExpiresAt: null,
    progress: 1,
    detail: `Existing library kept: ${reason}`,
  }, reason);
}

export async function requestExistingUpgrade(track: typeof schema.tracks.$inferSelect, videoId: string) {
  if (codecQuality(track.codec) !== "lossy") return;
  const started = await getDb().update(schema.tracks).set({
    youtubeVideoId: track.youtubeVideoId ?? videoId,
    upgradeAttempted: true,
    stage: "queued",
    detail: "Looking for a lossless upgrade; original remains untouched",
  }).where(and(eq(schema.tracks.id, track.id), eq(schema.tracks.upgradeAttempted, false))).returning({ id: schema.tracks.id });
  if (started.length) {
    try {
      await queues.acquire.add("acquire", { trackId: track.id }, { jobId: jobId.acquire(track.id) });
    } catch (err) {
      await getDb().update(schema.tracks).set({ upgradeAttempted: false }).where(eq(schema.tracks.id, track.id));
      await keepExisting(track, "Upgrade could not be queued; retry the sync");
      throw err;
    }
  }
}

/** Reconcile requests queued before the original library was first imported. */
export async function reusePendingTrack(track: typeof schema.tracks.$inferSelect) {
  if (!libraryIndexEnabled() || track.existingFilePath || track.filePath || !track.youtubeVideoId) return null;
  const db = getDb();
  const candidates = await db.select().from(schema.tracks).where(and(
    isNotNull(schema.tracks.existingLibraryKey),
    eq(schema.tracks.libraryMatchKey, libraryMatchKey(track.artist, track.title)),
  ));
  const matches = candidates.filter((candidate) => sameRecording(track, candidate) &&
    (!track.mbRecordingId || !candidate.mbRecordingId || track.mbRecordingId === candidate.mbRecordingId));
  if (track.mbRecordingId && matches.length > 1) throw new Error("Multiple existing editions fit the requested recording. Choose an exact local edition; no duplicate was downloaded.");
  const existing = matches.find((candidate) => codecQuality(candidate.codec) === "lossless") ??
    (matches.length === 1 ? matches[0] : undefined);
  if (!existing) {
    if (candidates.length) throw new Error("Existing-library match needs review: album, duration or edition is ambiguous. No duplicate was downloaded.");
    return null;
  }
  await db.transaction(async (tx) => {
    const [pending] = await tx.select().from(schema.tracks).where(eq(schema.tracks.id, track.id)).for("update");
    if (!pending) return;
    const owners = await tx.select().from(schema.userTracks).where(eq(schema.userTracks.trackId, track.id));
    if (owners.length) await tx.insert(schema.userTracks).values(owners.map((row) => ({ ...row, trackId: existing.id }))).onConflictDoNothing();
    const playlists = await tx.select().from(schema.playlistTracks).where(eq(schema.playlistTracks.trackId, track.id));
    if (playlists.length) await tx.insert(schema.playlistTracks).values(playlists.map((row) => ({ ...row, trackId: existing.id }))).onConflictDoNothing();
    await tx.update(schema.trackVideos).set({ trackId: existing.id }).where(eq(schema.trackVideos.trackId, track.id));
    await tx.insert(schema.trackVideos).values({ videoId: track.youtubeVideoId!, trackId: existing.id }).onConflictDoNothing();
    await tx.update(schema.trackEvents).set({ trackId: existing.id }).where(eq(schema.trackEvents.trackId, track.id));
    await tx.update(schema.chartEntryLinks).set({ trackId: existing.id }).where(eq(schema.chartEntryLinks.trackId, track.id));
    await tx.delete(schema.tracks).where(eq(schema.tracks.id, track.id));
  });
  await requestExistingUpgrade(existing, track.youtubeVideoId);
  await getRedis().del("mint:stats");
  return existing.id;
}
