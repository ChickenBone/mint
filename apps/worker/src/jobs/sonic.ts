import { CHANNEL, publish, type SonicJob } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { DelayedError, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { config } from "../config";
import * as plex from "../services/plex";
import { updateTrack } from "../track-state";

async function markReady(trackId: string, sonic: boolean, detail: string | null) {
  const db = getDb();
  const t = await db.query.tracks.findFirst({ where: eq(schema.tracks.id, trackId), columns: { readyAt: true } });
  await updateTrack(trackId, { stage: "ready", sonicAnalyzed: sonic, detail, progress: 1, readyAt: t?.readyAt ?? new Date() }, detail ?? "Ready");
  const owners = await db.select({ userId: schema.userTracks.userId }).from(schema.userTracks).where(eq(schema.userTracks.trackId, trackId));
  for (const { userId } of owners) await publish(getRedis(), CHANNEL.user(userId), { type: "library", data: { trackIds: [trackId] } });
}

/** Polls Plex until the track carries sonic analysis data (musicAnalysisVersion), or gives up after PLEX_SONIC_TIMEOUT_HOURS. */
export async function processSonic(job: Job<SonicJob>, token?: string) {
  const db = getDb();
  const track = await db.query.tracks.findFirst({ where: eq(schema.tracks.id, job.data.trackId) });
  if (!track || track.stage === "ready") return;
  const elapsed = Date.now() - job.data.startedAt;

  let key = track.plexRatingKey;
  if (!key && track.filePath) {
    const found = await plex.findTrackByFile(track.filePath, track.title).catch(() => null);
    if (found) {
      key = found.ratingKey;
      await updateTrack(track.id, { plexRatingKey: key, readyAt: track.readyAt ?? new Date() });
      await plex.analyze(key).catch(() => undefined);
    }
  }
  if (key) {
    const t = await plex.getTrack(key);
    if (t && plex.isSonicallyAnalyzed(t)) return markReady(track.id, true, null);
  }
  if (elapsed > config.sonicTimeoutMs) {
    return markReady(track.id, false, key ? "Sonic analysis still pending in Plex" : "Not found in Plex");
  }
  // Progress is time-based: Plex exposes no percentage for per-item sonic analysis.
  await updateTrack(track.id, { progress: Math.min(0.95, elapsed / config.sonicTimeoutMs), detail: key ? "Plex sonic analysis" : "Waiting for Plex scan" });
  await job.moveToDelayed(Date.now() + Math.min(5 * 60_000, 30_000 + elapsed / 10), token);
  throw new DelayedError();
}
