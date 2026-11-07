import { applyTrackUpdate } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, eq, sql } from "drizzle-orm";
import { catalogBusy, chartAcquisition } from "./chart-service";
import { enqueueRequested } from "./queues";

let tail: Promise<void> = Promise.resolve();

/** Match one queued chart song at a time, and retry when MusicBrainz is busy. */
export function scheduleChartMatch(userId: string, input: { chart: string; entry: string; youtubeUrl?: string }, trackId: string, attempt = 0) {
  tail = tail.then(() => matchQueuedChart(userId, input, trackId, attempt), () => matchQueuedChart(userId, input, trackId, attempt));
  return tail;
}

async function matchQueuedChart(userId: string, input: { chart: string; entry: string; youtubeUrl?: string }, trackId: string, attempt: number) {
  try {
    const result = await chartAcquisition(userId, { ...input, existingTrackId: trackId });
    if (result.status === "available") {
      await getDb().delete(schema.tracks).where(and(eq(schema.tracks.id, trackId), eq(schema.tracks.stage, "queued"), sql`${schema.tracks.filePath} is null`));
      return;
    }
    if (result.status === "needs-video" || result.status === "resolve") {
      await failQueuedChart(trackId, result.message);
      return;
    }
    if (result.status === "requested" && result.needsQueue) await enqueueRequested(result.trackId, userId);
  } catch (error) {
    const youtube = error instanceof Error && /youtube/i.test(error.message);
    if (catalogBusy(error) && attempt < (youtube ? 12 : 5)) {
      await applyTrackUpdate(getDb(), getRedis(), trackId, {
        detail: youtube ? "YouTube is busy. Matching will retry." : "MusicBrainz is busy. Matching will retry.",
      }).catch(() => undefined);
      const delay = youtube ? Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempt, 4)) : Math.min(20_000, 2_000 * 2 ** attempt);
      setTimeout(() => scheduleChartMatch(userId, input, trackId, attempt + 1), delay);
      return;
    }
    await failQueuedChart(trackId, error instanceof Error ? error.message : "The song could not be matched.");
  }
}

async function failQueuedChart(trackId: string, message: string) {
  await applyTrackUpdate(getDb(), getRedis(), trackId, {
    stage: "failed", progress: 0, error: message.slice(0, 500), detail: message.slice(0, 240),
  }, message).catch(() => undefined);
}
